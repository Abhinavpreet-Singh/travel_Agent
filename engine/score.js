/**
 * Travelomore Core — Scoring Layer
 *
 * Deterministic score(entity, persona) -> { eligible, score_0_1, score_0_10, ... }.
 * No LLM anywhere in this file. Every number is reproducible from the same
 * entity + persona + signal_dictionary inputs.
 *
 * Pipeline: buildSignalVector (normalize.js) -> evaluate gates -> weighted sum
 * -> tag modifiers -> soft-gate cap -> contributions (feeds explain.js).
 */

import { buildSignalVector, clamp01 } from './normalize.js';

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
};

/** Resolve the value a gate compares against: a normalized signal, or a raw attribute (constraints first, then attributes). */
function resolveGateActual(gate, entity, signalVector) {
  if (gate.signal) {
    const s = signalVector[gate.signal];
    return s ? s.value : undefined;
  }
  if (gate.attribute) {
    if (entity.constraints && gate.attribute in entity.constraints) {
      return entity.constraints[gate.attribute];
    }
    if (entity.attributes && gate.attribute in entity.attributes) {
      return entity.attributes[gate.attribute];
    }
  }
  return undefined;
}

/**
 * Evaluate one gate against one entity.
 * Returns { applicable, passed, actual } — `applicable:false` means this gate
 * doesn't concern this entity type at all (e.g. an activity-scoped attribute
 * gate evaluated against a city) and must not affect eligibility or caps.
 */
export function evaluateGate(gate, entity, signalVector) {
  if (gate.scope && !gate.scope.includes(entity.type)) {
    return { applicable: false, passed: true, actual: undefined };
  }
  const actual = resolveGateActual(gate, entity, signalVector);
  if (actual === undefined) {
    // No data to judge by. Fail-open on soft gates, fail-closed on nothing —
    // we simply can't evaluate, so treat as not applicable rather than guessing.
    return { applicable: false, passed: true, actual: undefined };
  }
  const op = OPS[gate.op];
  if (!op) throw new Error(`Unknown gate operator: ${gate.op}`);
  return { applicable: true, passed: op(actual, gate.value), actual };
}

/**
 * Merge N personas into one composed persona for stacked trips
 * (e.g. family_trip + infant_friendly). Weights are each persona's own
 * weights renormalised to sum to 1, then averaged — so one persona in a
 * stack of three can't be diluted to a third of its intended influence
 * just because the others declare more weight keys.
 */
export function composePersonas(personaIds, personasById) {
  const list = personaIds.map((id) => {
    const p = personasById[id];
    if (!p) throw new Error(`Unknown persona id: ${id}`);
    return p;
  });

  // Always normalise to a [0,1]-summing distribution, even for a single
  // persona — so "weights" in the output is consistently shaped whether the
  // trip activated one persona or five, and a caller never has to special-case it.
  const normalizedWeights = list.map((p) => {
    const total = Object.values(p.weights).reduce((a, b) => a + b, 0) || 1;
    const norm = {};
    for (const [k, v] of Object.entries(p.weights)) norm[k] = v / total;
    return norm;
  });
  const keys = new Set(normalizedWeights.flatMap((n) => Object.keys(n)));
  const weights = {};
  for (const k of keys) {
    weights[k] =
      normalizedWeights.reduce((sum, n) => sum + (n[k] || 0), 0) / list.length;
  }

  const dedupe = (gates) => {
    const seen = new Map();
    for (const g of gates) {
      const key = JSON.stringify([g.signal ?? g.attribute, g.op, g.value, g.scope ?? null]);
      if (!seen.has(key) || (g.cap !== undefined && g.cap < seen.get(key).cap)) {
        seen.set(key, g);
      }
    }
    return [...seen.values()];
  };

  const tag_modifiers = { boost: {}, penalty: {} };
  for (const p of list) {
    for (const [tag, v] of Object.entries(p.tag_modifiers?.boost ?? {})) {
      tag_modifiers.boost[tag] = (tag_modifiers.boost[tag] ?? 0) + v;
    }
    for (const [tag, v] of Object.entries(p.tag_modifiers?.penalty ?? {})) {
      tag_modifiers.penalty[tag] = (tag_modifiers.penalty[tag] ?? 0) + v;
    }
  }

  const isSingle = list.length === 1;
  return {
    id: list.map((p) => p.id).join('+'),
    label: list.map((p) => p.label).join(' + '),
    description: isSingle ? list[0].description : `Composed persona: ${list.map((p) => p.label).join(', ')}.`,
    composed_from: list.map((p) => p.id),
    weights,
    hard_gates: dedupe(list.flatMap((p) => p.hard_gates ?? [])),
    soft_gates: dedupe(list.flatMap((p) => p.soft_gates ?? [])),
    tag_modifiers,
  };
}

/**
 * Score one entity against one (possibly composed) persona.
 *
 * @param {object} entity - the raw entity (country/city/hotel/activity/flight/visa)
 * @param {object[]} ancestors - parent chain, nearest first (e.g. [city, country])
 * @param {object} persona - a persona object, or the output of composePersonas()
 * @param {object} dictionary - signal_dictionary.json (parsed)
 */
export function scoreEntity(entity, ancestors, persona, dictionary) {
  const signalVector = buildSignalVector(entity, ancestors, dictionary);

  const hardFailures = [];
  for (const gate of persona.hard_gates ?? []) {
    const result = evaluateGate(gate, entity, signalVector);
    if (result.applicable && !result.passed) {
      hardFailures.push({
        kind: 'hard',
        signal: gate.signal,
        attribute: gate.attribute,
        op: gate.op,
        required_value: gate.value,
        actual_value: result.actual,
        reason: gate.reason,
      });
    }
  }
  const eligible = hardFailures.length === 0;

  const softFailures = [];
  let cap = 1;
  for (const gate of persona.soft_gates ?? []) {
    const result = evaluateGate(gate, entity, signalVector);
    if (result.applicable && !result.passed) {
      cap = Math.min(cap, gate.cap);
      softFailures.push({
        kind: 'soft',
        signal: gate.signal,
        attribute: gate.attribute,
        op: gate.op,
        required_value: gate.value,
        actual_value: result.actual,
        reason: gate.reason,
      });
    }
  }

  // Renormalise weights over signals actually applicable (in-scope) to this entity.
  const applicable = Object.entries(persona.weights).filter(([k]) => k in signalVector);
  const weightTotal = applicable.reduce((sum, [, w]) => sum + w, 0) || 1;

  let rawScore = 0;
  let coverage = 0;
  const contributions = [];
  for (const [signalId, weight] of applicable) {
    const w = weight / weightTotal;
    const sig = signalVector[signalId];
    rawScore += w * sig.value;
    coverage += w * (sig.missing ? 0 : 1);
    contributions.push({
      signal_id: signalId,
      weight: w,
      value: sig.value,
      raw: sig.raw,
      missing: sig.missing,
      inherited: sig.inherited,
      impact: w * (sig.value - 0.5) * 2, // signed, roughly in [-w, +w]
    });
  }

  let modifier = 0;
  for (const tag of entity.tags ?? []) {
    if (persona.tag_modifiers?.boost?.[tag] !== undefined) modifier += persona.tag_modifiers.boost[tag];
    if (persona.tag_modifiers?.penalty?.[tag] !== undefined) modifier -= persona.tag_modifiers.penalty[tag];
  }
  modifier = Math.max(-0.12, Math.min(0.12, modifier));

  let score01 = clamp01(rawScore + modifier);
  // A soft-gate cap is a ceiling, not a floor — but a flat min(score, cap)
  // means every entity that would have scored ABOVE the cap collapses to
  // the exact same number, destroying differentiation among them (verified:
  // this flattened 8 genuinely different-quality hotels — a five-star
  // resort and a budget business hotel included — to the identical 4.5 for
  // pregnancy_friendly in a Zika-flagged city). Instead, let a controlled
  // fraction of the excess above the cap still show through: entities stay
  // clearly capped (well below anything that passed the gate outright) but
  // remain ordered relative to each other. SOFT_CAP_SPREAD is deliberately
  // small (0.35) so the cap still means something — the best possible
  // capped entity (raw score 1.0) still only reaches cap + 0.65*0.35, never
  // close to an uncapped score.
  const SOFT_CAP_SPREAD = 0.35;
  if (score01 > cap) {
    score01 = cap + (score01 - cap) * SOFT_CAP_SPREAD;
  }
  if (!eligible) score01 = 0;

  contributions.sort((a, b) => b.impact - a.impact);

  return {
    persona_id: persona.id,
    composed_from: persona.composed_from,
    eligible,
    gate_failures: [...hardFailures, ...softFailures],
    score_0_1: Number(score01.toFixed(4)),
    score_0_10: Number((score01 * 10).toFixed(1)),
    signal_coverage: Number(coverage.toFixed(3)),
    tag_modifier: Number(modifier.toFixed(3)),
    soft_cap_applied: cap < 1 ? cap : null,
    contributions,
  };
}

/** Score and rank a list of {entity, ancestors} items against one persona. Ineligible items sort last. */
export function rankEntities(items, persona, dictionary) {
  return items
    .map(({ entity, ancestors }) => ({
      entity_id: entity.id,
      name: entity.name,
      ...scoreEntity(entity, ancestors, persona, dictionary),
    }))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return b.score_0_1 - a.score_0_1;
    });
}
