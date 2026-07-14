/**
 * Travelomore Core — Normalization Layer
 *
 * Contract: raw attribute (any unit) -> signal value in [0,1], where 1 is ALWAYS
 * "better for the traveller". Every persona weight is expressed over signals,
 * never over raw attributes, so units and directionality never leak into scoring.
 *
 * Deterministic and pure: same input -> same output. No LLM in this path.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Apply a single normalizer spec to a raw value. Returns null if not computable. */
export function applyNormalizer(raw, spec) {
  if (raw === null || raw === undefined) return null;
  const n = spec.type;

  switch (n) {
    case 'index_100':
      return clamp01(Number(raw) / 100);
    case 'index_100_inverse':
      return clamp01(1 - Number(raw) / 100);
    case 'ratio':
      return clamp01(Number(raw));
    case 'linear_clamp':
      return clamp01((Number(raw) - spec.min) / (spec.max - spec.min));
    case 'linear_inverse_clamp':
      return clamp01(1 - (Number(raw) - spec.min) / (spec.max - spec.min));
    case 'scale_1_5':
      return clamp01((Number(raw) - 1) / 4);
    case 'scale_1_5_inverse':
      return clamp01(1 - (Number(raw) - 1) / 4);
    case 'boolean':
      return raw === true ? 1 : 0;
    case 'enum_map': {
      const v = spec.map[String(raw)];
      return v === undefined ? null : clamp01(v);
    }
    case 'count_saturating':
      return clamp01(1 - Math.exp(-Number(raw) / spec.k));
    default:
      throw new Error(`Unknown normalizer type: ${n}`);
  }
}

/**
 * Resolve the raw attribute for a signal along the inheritance chain.
 * Precedence: entity > parent city > country. Non-inheritable signals do NOT
 * climb the chain — an activity's exertion level is its own, not its city's.
 *
 * Returns { value, source_entity_id, inherited } or null.
 */
export function resolveAttribute(signal, entity, ancestors) {
  const own = entity.attributes?.[signal.attribute];
  if (own !== undefined && own !== null) {
    return { value: own, source_entity_id: entity.id, inherited: false };
  }
  if (!signal.inheritable) return null;

  for (const anc of ancestors) {
    const v = anc.attributes?.[signal.attribute];
    if (v !== undefined && v !== null) {
      return { value: v, source_entity_id: anc.id, inherited: true };
    }
  }
  return null;
}

/**
 * Build the full signal vector for an entity.
 *
 * Returns:
 *  signals: { [signal_id]: { value, raw, inherited, source_entity_id, missing } }
 *  Missing signals are included with missing:true and a neutral prior of 0.5,
 *  so a data gap never silently reads as a zero (which would look like a defect
 *  rather than an unknown).
 */
// signal_dictionary.json scope[] uses the short scope vocabulary declared in its
// own "scopes" field ("country", "city", ...); entity.type uses the fuller,
// descriptive ontology names ("destination_country", "destination_city", ...).
// This is the single place that reconciles the two vocabularies.
const SCOPE_ALIASES = { destination_country: 'country', destination_city: 'city' };
const scopeNameFor = (type) => SCOPE_ALIASES[type] ?? type;

export function buildSignalVector(entity, ancestors, dictionary) {
  const out = {};
  const entityType = scopeNameFor(entity.type);

  for (const signal of dictionary.signals) {
    // Skip signals that don't apply to this entity type at all — they are not
    // "missing data", they are out of scope, and must not dilute the weights.
    const applies =
      signal.scope.includes(entityType) ||
      (signal.inheritable && ancestors.some((a) => signal.scope.includes(scopeNameFor(a.type))));
    if (!applies) continue;

    const resolved = resolveAttribute(signal, entity, ancestors);
    if (!resolved) {
      out[signal.id] = {
        value: 0.5,
        raw: null,
        missing: true,
        inherited: false,
        source_entity_id: null,
        facet: signal.facet,
      };
      continue;
    }

    const value = applyNormalizer(resolved.value, signal.normalizer);
    out[signal.id] = {
      value: value === null ? 0.5 : value,
      raw: resolved.value,
      missing: value === null,
      inherited: resolved.inherited,
      source_entity_id: resolved.source_entity_id,
      facet: signal.facet,
    };
  }
  return out;
}

export { clamp01 };
