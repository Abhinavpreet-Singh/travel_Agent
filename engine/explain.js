/**
 * Travelomore Core — Explainability Layer
 *
 * Turns a scoreEntity() result into the human-readable {persona, score, reasons}
 * shape future agents (and end users, via the Itinerary/Summary agents) consume.
 * Every reason is a template from signal_dictionary.json filled with the entity's
 * own raw value — never freehand LLM text — so the explanation is exactly as
 * deterministic as the score it explains.
 */

function renderTemplate(template, attribute, raw) {
  const value = raw === null || raw === undefined ? '—' : raw;
  return template.replaceAll(`{${attribute}}`, String(value));
}

/**
 * @param {object} entity
 * @param {object} persona - the (possibly composed) persona used to score
 * @param {object} result - output of scoreEntity()
 * @param {object} dictionary - signal_dictionary.json (parsed)
 * @param {number} [topN=4] - max positive reasons to surface
 */
export function buildExplanation({ entity, persona, result, dictionary, topN = 4 }) {
  const byId = Object.fromEntries(dictionary.signals.map((s) => [s.id, s]));

  if (!result.eligible) {
    const cautions = result.gate_failures
      .filter((f) => f.kind === 'hard')
      .map((f) => `Excluded: ${f.reason}`);
    return { persona: persona.id, score: result.score_0_10, reasons: [], cautions };
  }

  let positive = result.contributions.filter((c) => !c.missing && c.value >= 0.6).slice(0, topN);
  if (positive.length === 0) {
    positive = result.contributions.filter((c) => !c.missing).slice(0, 2);
  }
  const reasons = positive
    .map((c) => byId[c.signal_id])
    .filter(Boolean)
    .map((def, i) => renderTemplate(def.positive_template, def.attribute, positive[i].raw));

  const cautions = result.gate_failures
    .filter((f) => f.kind === 'soft')
    .map((f) => `Caution: ${f.reason}`);

  const negative = [...result.contributions]
    .sort((a, b) => a.impact - b.impact)
    .filter((c) => !c.missing && c.value <= 0.35)
    .slice(0, 3);
  for (const c of negative) {
    const def = byId[c.signal_id];
    if (!def) continue;
    cautions.push(renderTemplate(def.negative_template, def.attribute, c.raw));
  }

  return {
    persona: persona.id,
    score: result.score_0_10,
    reasons,
    cautions,
  };
}
