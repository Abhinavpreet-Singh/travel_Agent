/**
 * Travelomore Core — Query CLI
 *
 * The tool for actually trying the engine out. Two ways to drive it:
 *
 *   1. Free text, like a real user would type into Maya:
 *        node engine/cli.js "family trip to Phuket with 2 kids, need wheelchair access for grandma"
 *
 *   2. Explicit overrides, for exact same-city / different-persona A-B testing:
 *        node engine/cli.js --city=HKT --persona=senior_citizen
 *        node engine/cli.js --city=HKT --persona=bachelor_trip
 *        node engine/cli.js --city=HKT --persona=senior_citizen,bachelor_trip   (side-by-side compare)
 *        node engine/cli.js --persona=senior_citizen,bachelor_trip             (compare across all cities)
 *
 *   No arguments at all drops into an interactive prompt loop where both
 *   forms above work per-line, plus a shorthand: `city:HKT persona:bachelor_trip`.
 *   Interactive mode always shows the extraction (resolved city, personas,
 *   parsed roster, notes on anything ambiguous or not yet supported) as its
 *   own JSON block FIRST and lets you correct it before anything is scored —
 *   press Enter to accept it as-is, or type a correction/addition.
 *
 * Every query writes its own timestamped JSON file to
 * output/thailand/queries/ (nothing is ever overwritten there) plus an
 * always-latest convenience copy at output/thailand/query_result.json, and
 * prints a compact console summary.
 */

import path from 'node:path';
import readline from 'node:readline';

import { loadThailand, writeJSON, ROOT } from './loadData.js';
import { scoreEntity, rankEntities, composePersonas } from './score.js';
import { buildExplanation } from './explain.js';
import { derivePersonas, parseFreeTextToBrief } from './personaFromBrief.js';

const data = loadThailand();

// ---- input parsing ---------------------------------------------------------

function parseArgv(argv) {
  const flags = {};
  const rest = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) flags[arg.slice(2).toLowerCase()] = true;
      else flags[arg.slice(2, eq).toLowerCase()] = arg.slice(eq + 1);
    } else {
      rest.push(arg);
    }
  }
  return { flags, text: rest.join(' ').trim() };
}

/** `city:HKT persona:bachelor_trip,senior_citizen` typed inline -> the same flags parseArgv would produce. */
function parseShorthandLine(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((t) => /^[a-zA-Z_]+:.+$/.test(t))) return null;
  const flags = {};
  for (const t of tokens) {
    const idx = t.indexOf(':');
    flags[t.slice(0, idx).toLowerCase()] = t.slice(idx + 1);
  }
  return flags;
}

function findCity(query) {
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  const cities = data.cityFile.entities;
  return (
    cities.find((c) => c.id.toLowerCase().endsWith(':' + q)) ||
    cities.find((c) => (c.gateway_airport || []).some((a) => a.toLowerCase() === q)) ||
    cities.find((c) => c.name.toLowerCase() === q) ||
    cities.find((c) => c.name.toLowerCase().includes(q)) ||
    null
  );
}

/** Scan free text for any known city's name (handles "Krabi (Ao Nang / Railay)" style alt names). */
function detectCityInText(text) {
  const lower = text.toLowerCase();
  const cities = [...data.cityFile.entities].sort((a, b) => b.name.length - a.name.length);
  for (const c of cities) {
    const simple = c.name.toLowerCase().split('(')[0].trim();
    if (simple && lower.includes(simple)) return c;
    const paren = c.name.match(/\(([^)]+)\)/);
    if (paren) {
      for (const alt of paren[1].split('/').map((s) => s.trim().toLowerCase())) {
        if (alt && lower.includes(alt)) return c;
      }
    }
  }
  return null;
}

function resolveCity(flags, text) {
  if (flags.city) {
    const c = findCity(flags.city);
    if (!c) {
      throw new Error(
        `Unknown city "${flags.city}". Known cities: ${data.cityFile.entities.map((c) => c.name).join(', ')}`
      );
    }
    return c;
  }
  return text ? detectCityInText(text) : null;
}

function resolvePersonas(flags, text) {
  if (flags.persona) {
    const ids = String(flags.persona)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) {
      if (!data.personasById[id]) {
        throw new Error(`Unknown persona "${id}". Valid ids: ${data.ALL_PERSONA_IDS.join(', ')}`);
      }
    }
    return { ids, source: 'explicit', derived: null, brief: null };
  }
  if (text) {
    // Parse into Maya's exact stored brief shape first (destinationType,
    // dates, duration, budget, groupComposition, extras[]) — see Developer
    // Onboarding Guide §9.1 — so a typed prompt and a real Maya conversation
    // produce the same shape before persona derivation ever runs.
    const brief = parseFreeTextToBrief(text);
    const derived = derivePersonas(brief);
    return { ids: derived.personas, source: 'derived', derived, brief };
  }
  return { ids: ['default'], source: 'fallback', derived: null, brief: null };
}

// ---- ranking helpers --------------------------------------------------------

const PACE_LABELS = { 1: 'Very Easy', 2: 'Easy', 3: 'Moderate', 4: 'Active', 5: 'Strenuous' };

function activityCostBand(priceInr) {
  if (priceInr === undefined || priceInr === null) return null;
  if (priceInr === 0) return 'Free';
  if (priceInr < 800) return '$';
  if (priceInr < 2500) return '$$';
  if (priceInr < 6000) return '$$$';
  return '$$$$';
}

function hotelCostBand(priceInrPerNight) {
  if (priceInrPerNight === undefined || priceInrPerNight === null) return null;
  if (priceInrPerNight < 3000) return '$';
  if (priceInrPerNight < 6000) return '$$';
  if (priceInrPerNight < 10000) return '$$$';
  return '$$$$';
}

/**
 * Best-effort time-of-day for scheduling an activity into a day plan —
 * derived from category/tags/golden-hour-index rather than hand-authored
 * per entity (122 activities × a new field is real authoring work; this is
 * "good enough to sequence a day," not a verified fact). No new data added
 * to any entity file.
 */
function bestTime(entity) {
  const cat = (entity.category ?? '').toLowerCase();
  const tags = entity.tags ?? [];
  const golden = entity.attributes?.golden_hour_index_0_100 ?? 0;
  const heat = entity.attributes?.peak_heat_index_c ?? 0;
  if (cat === 'nightlife' || tags.includes('nightlife') || tags.includes('party')) return 'evening';
  if (tags.includes('sunset_spot') || golden >= 75) return 'evening';
  if (tags.includes('sunrise_spot')) return 'early_morning';
  if ((cat === 'heritage' || cat === 'culture') && heat >= 38) return 'morning';
  if (cat === 'food' && /night/i.test(entity.name ?? '')) return 'evening';
  return 'flexible';
}

/**
 * Type-aware, day-planning-relevant fields derived from the entity's own
 * data — cheap to compute, so attached to EVERY entity regardless of
 * explainTop. An itinerary agent needs to know which city an activity is in
 * and roughly how long/expensive/strenuous it is to sequence a day; making
 * it re-derive that from raw signal attributes (or worse, guess) is exactly
 * the kind of friction this layer exists to remove.
 */
function entityMetadata(entity) {
  const dataConfidence = entity.meta?.data_confidence ?? null;
  if (entity.type === 'activity') {
    return {
      city: data.citiesById[entity.parent_id]?.name ?? null,
      category: entity.category,
      duration_hours: entity.duration_hours,
      cost_band: activityCostBand(entity.price_inr),
      pace: PACE_LABELS[entity.attributes?.exertion_level_1_5] ?? null,
      best_time: bestTime(entity),
      data_confidence: dataConfidence,
    };
  }
  if (entity.type === 'hotel') {
    return {
      city: data.citiesById[entity.parent_id]?.name ?? null,
      category: entity.category,
      star_rating: entity.star_rating,
      cost_band: hotelCostBand(entity.price_inr_per_night),
      data_confidence: dataConfidence,
    };
  }
  if (entity.type === 'destination_city') {
    return { province: entity.province ?? null, best_months: entity.best_months ?? null, data_confidence: dataConfidence };
  }
  return { data_confidence: dataConfidence };
}

/**
 * Score + sort EVERY entity in `entities` — never truncated. This is the
 * material an itinerary agent builds from, so hiding most of a 107-activity
 * country-wide pool behind a top-8 cutoff (the old behavior) starves it of
 * options. Every entry always carries entity_id/name/score_0_10/eligible
 * plus day-planning metadata (city/duration/cost/pace); the first
 * `explainTop` entries additionally get gate_failures and template-rendered
 * why/caution reasons — kept to a sane count so payload size doesn't scale
 * with the whole pool, since the score+metadata alone is enough for an LLM
 * to place an entity in an itinerary even without a citation-quality reason.
 */
function rankAll(entities, ancestorsFn, persona, explainTop) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const ranked = rankEntities(
    entities.map((entity) => ({ entity, ancestors: ancestorsFn(entity) })),
    persona,
    data.dictionary
  );
  return ranked.map((r, i) => {
    const entity = byId.get(r.entity_id);
    const base = {
      entity_id: r.entity_id,
      name: r.name,
      score_0_10: r.score_0_10,
      eligible: r.eligible,
      ...entityMetadata(entity),
    };
    // Why an entity was excluded is cheap (r.gate_failures is already
    // computed by rankEntities above, no extra scoring needed) and always
    // worth keeping — regardless of explainTop position. Ineligible entries
    // sort to the tail of the list, so without this they'd fall outside a
    // country-wide explainTop cutoff and lose their reason entirely.
    if (!r.eligible) base.gate_failures = r.gate_failures;
    if (i >= explainTop) return base;
    const result = scoreEntity(entity, ancestorsFn(entity), persona, data.dictionary);
    const explanation = buildExplanation({ entity, persona, result, dictionary: data.dictionary });
    return { ...base, gate_failures: r.gate_failures, why: explanation.reasons, caution: explanation.cautions };
  });
}

function buildComparisonTable(entities, ancestorsFn, personas) {
  const rows = entities.map((entity) => {
    const scores = {};
    const eligible = {};
    for (const persona of personas) {
      const r = scoreEntity(entity, ancestorsFn(entity), persona, data.dictionary);
      scores[persona.id] = r.score_0_10;
      eligible[persona.id] = r.eligible;
    }
    const vals = Object.values(scores);
    return { entity_id: entity.id, name: entity.name, scores, eligible, spread: Math.max(...vals) - Math.min(...vals) };
  });
  return rows.sort((a, b) => b.spread - a.spread); // full list, never truncated — sorted so the most persona-differentiating entities read first
}

/**
 * Split a rankAll() list into entities actually worth recommending
 * (eligible, sorted best-first) and a compact excluded record (name, city,
 * the one-line reason) — combined later into one excluded_options list
 * across cities/activities/hotels, matching the shape an itinerary agent
 * actually wants: a clean candidate pool plus "and here's what NOT to
 * suggest and why," not one list where the caller has to filter on
 * `eligible` themselves.
 */
function splitRecommendedExcluded(rankedList, type) {
  const recommended = [];
  const excluded = [];
  for (const item of rankedList) {
    if (item.eligible) {
      const { eligible, gate_failures, ...rest } = item;
      recommended.push(rest);
    } else {
      excluded.push({
        type,
        entity_id: item.entity_id,
        name: item.name,
        city: item.city ?? null,
        reason: item.gate_failures?.[0]?.reason ?? 'excluded by a hard gate',
      });
    }
  }
  return { recommended, excluded };
}

function runSingle(city, persona) {
  const activityPool = city ? data.activities.filter((a) => a.parent_id === city.id) : data.activities;
  const hotelPool = city ? data.hotels.filter((h) => h.parent_id === city.id) : data.hotels;
  const cityPool = city ? [city] : data.cityFile.entities;

  // explainTop sized generously enough to cover a whole city-scoped pool
  // (activities/hotels rarely exceed ~15) or a meaningful slice of the
  // country-wide pool (20 of 100+) — everything past that still has its score.
  const cities = city ? null : splitRecommendedExcluded(rankAll(cityPool, data.ancestorsOf.destination_city, persona, cityPool.length), 'city');
  const activities = splitRecommendedExcluded(
    rankAll(activityPool, data.ancestorsOf.activity, persona, city ? activityPool.length : 20),
    'activity'
  );
  const hotels = splitRecommendedExcluded(rankAll(hotelPool, data.ancestorsOf.hotel, persona, hotelPool.length), 'hotel');

  return {
    persona: { id: persona.id, label: persona.label, composed_from: persona.composed_from ?? [persona.id] },
    recommended_cities: cities?.recommended,
    recommended_activities: activities.recommended,
    recommended_hotels: hotels.recommended,
    excluded_options: [...(cities?.excluded ?? []), ...activities.excluded, ...hotels.excluded],
  };
}

function runCompare(city, personaIds) {
  const personas = personaIds.map((id) => data.personasById[id]);

  if (city) {
    const activityPool = data.activities.filter((a) => a.parent_id === city.id);
    const hotelPool = data.hotels.filter((h) => h.parent_id === city.id);
    return {
      scope: 'city',
      city: { id: city.id, name: city.name },
      personas: personaIds,
      activities_comparison: buildComparisonTable(activityPool, data.ancestorsOf.activity, personas),
      hotels_comparison: buildComparisonTable(hotelPool, data.ancestorsOf.hotel, personas),
      per_persona_top: Object.fromEntries(
        personas.map((persona) => [
          persona.id,
          {
            top_activities: rankAll(activityPool, data.ancestorsOf.activity, persona, Math.min(8, activityPool.length)),
            top_hotels: rankAll(hotelPool, data.ancestorsOf.hotel, persona, hotelPool.length),
          },
        ])
      ),
    };
  }

  return {
    scope: 'country_cities',
    personas: personaIds,
    cities_comparison: buildComparisonTable(data.cityFile.entities, data.ancestorsOf.destination_city, personas),
    per_persona_top_cities: Object.fromEntries(
      personas.map((persona) => [persona.id, rankAll(data.cityFile.entities, data.ancestorsOf.destination_city, persona, 8)])
    ),
  };
}

// ---- console output ---------------------------------------------------------

function printSingle(result) {
  if (result.recommended_cities) {
    console.log(`Recommended cities (of ${result.recommended_cities.length} eligible):`);
    for (const c of result.recommended_cities.slice(0, 17)) {
      console.log(`  ${c.score_0_10.toFixed(1).padStart(4)}  ${c.name.padEnd(28)} ${c.why?.[0] ?? ''}`);
    }
  }
  console.log(`Recommended activities (of ${result.recommended_activities.length} eligible):`);
  for (const a of result.recommended_activities.slice(0, 15)) {
    console.log(`  ${a.score_0_10.toFixed(1).padStart(4)}  ${a.name.padEnd(38)} ${a.city ?? ''}`);
  }
  console.log(`Recommended hotels (of ${result.recommended_hotels.length} eligible):`);
  for (const h of result.recommended_hotels.slice(0, 8)) {
    console.log(`  ${h.score_0_10.toFixed(1).padStart(4)}  ${h.name.padEnd(38)} ${h.city ?? ''}`);
  }
  if (result.excluded_options.length) {
    console.log(`Excluded (${result.excluded_options.length}):`);
    for (const e of result.excluded_options.slice(0, 10)) {
      console.log(`  [${e.type}] ${e.name.padEnd(36)} ${e.reason}`);
    }
    if (result.excluded_options.length > 10) console.log(`  ... and ${result.excluded_options.length - 10} more`);
  }
}

function printCompare(result) {
  const table = result.cities_comparison || result.activities_comparison;
  const label = result.cities_comparison ? 'cities' : 'activities';
  console.log(`\nMost persona-differentiating ${label} (top 15 of ${table.length} by score spread):`);
  for (const row of table.slice(0, 15)) {
    const cells = result.personas
      .map((pid) => `${pid}=${row.scores[pid].toFixed(1)}${row.eligible[pid] ? '' : 'x'}`)
      .join('   ');
    console.log(`  ${row.name.padEnd(36)} ${cells}`);
  }
  if (result.hotels_comparison?.length) {
    console.log(`\nMost persona-differentiating hotels (top 8 of ${result.hotels_comparison.length} by score spread):`);
    for (const row of result.hotels_comparison.slice(0, 8)) {
      const cells = result.personas
        .map((pid) => `${pid}=${row.scores[pid].toFixed(1)}${row.eligible[pid] ? '' : 'x'}`)
        .join('   ');
      console.log(`  ${row.name.padEnd(36)} ${cells}`);
    }
  }
  console.log(`\n(x = excluded by a hard gate for that persona)`);
}

// ---- one query --------------------------------------------------------------

const isOn = (v) => v === true || v === 'true';

/**
 * Explicit --persona=a,b (or its shorthand) defaults to a side-by-side
 * compare — a deliberate "how do these personas differ" test. Personas
 * derived from one free-text trip description default to a single blended
 * ranking instead — it's one trip, not a comparison — unless --compare
 * forces the side-by-side view anyway. Computed once here so the recipe and
 * the ranking can never disagree about which mode they're in.
 */
function determineCompareMode({ flags, personaSource, personaIds }) {
  return isOn(flags.compare) || (personaSource === 'explicit' && personaIds.length > 1 && !isOn(flags.stack));
}

/**
 * Resolve city + personas and compose the persona(s) into one scoring
 * "recipe" — the weights/gates configuration, kept conceptually separate
 * from the ranked entities it produces (see writeAndSummarize, which writes
 * the two as separate files).
 */
function buildExtraction({ flags, text }) {
  const city = resolveCity(flags, text);
  const pr = resolvePersonas(flags, text);
  const compareMode = determineCompareMode({ flags, personaSource: pr.source, personaIds: pr.ids });
  // In compare mode each persona is scored on its own — a blended weight
  // vector across e.g. senior_citizen + bachelor_trip would represent
  // neither and would contradict the ranked.json, which scores them
  // separately. Only single/stack mode gets one true composed persona.
  const composed = compareMode
    ? pr.ids.map((id) => composePersonas([id], data.personasById))
    : composePersonas(pr.ids, data.personasById);
  return {
    flags,
    text,
    city,
    personaIds: pr.ids,
    personaSource: pr.source,
    derived: pr.derived,
    brief: pr.brief,
    compareMode,
    composed,
  };
}

/** Weights sorted descending so the most-influential signals read first — order carries information here. */
function sortWeightsDesc(weights) {
  return Object.fromEntries(
    Object.entries(weights)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, Number(v.toFixed(4))])
  );
}

function formatComposed(composed) {
  return {
    id: composed.id,
    label: composed.label,
    composed_from: composed.composed_from,
    weights: sortWeightsDesc(composed.weights), // sums to 1
    hard_gates: composed.hard_gates,
    soft_gates: composed.soft_gates,
    tag_modifiers: composed.tag_modifiers,
  };
}

/**
 * What we actually know vs. guessed vs. don't have — three buckets instead
 * of one flat notes/roster dump, so a caller (human or LLM) can see at a
 * glance what's solid, what's an assumption worth double-checking, and what
 * would sharpen the recipe if asked for.
 */
function buildConstraintSummary(ext) {
  const known = [];
  const missing = [];
  const roster = ext.derived?.roster;
  const brief = ext.brief;

  if (ext.city) known.push(`destination city: ${ext.city.name}`);
  else if (ext.text) missing.push('destination city not specified — scored across all cities');

  if (roster) {
    if (roster.adults !== null) known.push(`${roster.adults} adult(s)`);
    else missing.push('group size not specified');
    if (roster.gender !== 'unspecified') known.push(`traveller gender: ${roster.gender}`);
    if (roster.children_ages.length > 0) known.push(`${roster.children_ages.length} child(ren), ages: ${roster.children_ages.join(', ')}`);
    if (roster.age_assumed) missing.push('exact child age(s) not given — assumed ~6 for scoring; state real ages for accurate gating (an infant hard-gates very differently than a 6-year-old)');
    if (roster.has_senior_adult) known.push('senior traveller present');
  }

  if (brief?.duration) known.push(`duration: ${brief.duration}`);
  else if (ext.text) missing.push('travel duration not specified');
  if (brief?.dates) known.push(`dates: ${brief.dates}`);
  else if (ext.text) missing.push('travel dates not specified');
  if (brief?.budget) known.push(`budget: ${brief.budget}`);
  else if (ext.text) missing.push('budget not specified');

  for (const extra of ext.derived?.unmatched_extras ?? []) {
    missing.push(`captured but not yet folded into scoring weights: ${extra.label} = ${extra.value}`);
  }

  return {
    known, // stated directly, or unambiguous (a resolved city, an explicit count)
    inferred: ext.derived?.notes ?? [], // heuristic reasoning this layer applied — assumptions, persona-selection rationale
    missing, // would sharpen the recipe if provided; scored on reasonable defaults in the meantime
  };
}

/**
 * How much of the persona detection is solid vs. guessed. 'explicit' input
 * (--persona=...) is always high confidence — the caller said exactly what
 * they wanted. Free text with zero notes means every signal was
 * unambiguous. Any note (an assumption, a "no dedicated persona" fallback)
 * drops it to medium; the fallback persona with no text at all is low.
 */
function classifyConfidence(ext) {
  if (ext.personaSource === 'explicit') return { level: 'high', reason: 'persona(s) specified explicitly' };
  if (ext.personaSource === 'fallback') return { level: 'low', reason: 'no input text or persona given' };
  const noteCount = ext.derived?.notes?.length ?? 0;
  if (noteCount === 0) return { level: 'high', reason: 'persona(s) derived cleanly, no assumptions needed' };
  return { level: 'medium', reason: `persona derivation involved ${noteCount} assumption(s) — see constraints.inferred` };
}

function recipeToJSON(ext) {
  const base = {
    input_text: ext.text || null,
    resolved_city: ext.city ? { id: ext.city.id, name: ext.city.name } : null,
    personas: ext.personaIds,
    persona_source: ext.personaSource, // 'explicit' | 'derived' | 'fallback'
    confidence: classifyConfidence(ext),
    mode: ext.compareMode ? 'compare' : 'single',
    constraints: buildConstraintSummary(ext),
    brief: ext.brief, // Maya-shaped: destinationType, dates, duration, budget, groupComposition, extras[] — raw, for programmatic use
    roster: ext.derived?.roster ?? null, // same info as brief.groupComposition, pre-parsed
  };
  // The actual scoring recipe: apply this to ANY entity (via engine/score.js::scoreEntity)
  // to get a score — this is the "optimized JSON" for this trip.
  if (ext.compareMode) {
    base.composed_personas = ext.composed.map(formatComposed); // one per persona, NOT blended — matches ranked.json's compare mode
  } else {
    base.composed_persona = formatComposed(ext.composed);
  }
  return base;
}

function printRecipeJSON(ext) {
  console.log('\n' + '-'.repeat(64));
  console.log('Recipe — the optimized scoring JSON for this trip (nothing ranked yet):');
  console.log(JSON.stringify(recipeToJSON(ext), null, 2));
}

let queryCounter = 0;

/**
 * Writes TWO separate files per query — always, no flag needed:
 *   - <n>.recipe.json  — persona(s), brief, composed weights/gates/tag_modifiers. Nothing ranked.
 *   - <n>.ranked.json  — real cities/activities/hotels scored and sorted against that recipe.
 * Handing both to an LLM gives it the "why" (recipe) and the "what" (ranked)
 * as separate documents rather than one large mixed blob.
 */
function writeAndSummarize(ext) {
  const { city, personaIds, compareMode } = ext;
  const recipe = recipeToJSON(ext);

  // ext.composed is an array (one composed persona per id) in compare mode,
  // and a single composed persona otherwise — see buildExtraction.
  const rankedResult = compareMode ? runCompare(city, personaIds) : runSingle(city, ext.composed);
  const ranked = {
    mode: compareMode ? 'compare' : 'single',
    query: { text: ext.text || null, resolved_city: city?.id ?? null, personas: personaIds },
    ...rankedResult,
  };

  queryCounter += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const n = String(queryCounter).padStart(3, '0');
  const recipePath = writeJSON(`output/thailand/queries/${stamp}_${n}.recipe.json`, recipe);
  const rankedPath = writeJSON(`output/thailand/queries/${stamp}_${n}.ranked.json`, ranked);
  writeJSON('output/thailand/query_result.recipe.json', recipe); // always-latest convenience copies
  writeJSON('output/thailand/query_result.ranked.json', ranked);

  if (compareMode) {
    const summary = ext.composed
      .map((c) => `${c.label} (${Object.keys(c.weights).length}w/${c.hard_gates.length + c.soft_gates.length}g)`)
      .join('  vs  ');
    console.log(`\nComparing: ${summary}`);
  } else {
    const weightCount = Object.keys(ext.composed.weights).length;
    const gateCount = ext.composed.hard_gates.length + ext.composed.soft_gates.length;
    console.log(`\nPersona: ${ext.composed.label}  (${weightCount} weighted signals, ${gateCount} gates)`);
  }

  if (compareMode) printCompare(rankedResult);
  else printSingle(rankedResult);

  console.log(`\nRecipe JSON (weights/gates/brief):        ${path.relative(ROOT, recipePath)}`);
  console.log(`Ranked JSON (cities/activities/hotels):    ${path.relative(ROOT, rankedPath)}`);
  console.log(`Latest copies: output/thailand/query_result.recipe.json, output/thailand/query_result.ranked.json`);
  console.log('-'.repeat(64) + '\n');
}

/** One-shot mode (argv args) — no one to confirm with, so show the full recipe once, then write it. */
function handleQueryOnce(input) {
  let ext;
  try {
    ext = buildExtraction(input);
  } catch (err) {
    console.log(`\n! ${err.message}\n`);
    return;
  }
  printRecipeJSON(ext);
  writeAndSummarize(ext);
}

// ---- entry points -----------------------------------------------------------

function printHelp() {
  console.log(`
Travelomore Core Engine — query CLI

Every query writes TWO files: a .recipe.json (resolved persona(s), the
Maya-shaped brief parsed from your prompt, and the composed scoring
configuration — weights, hard/soft gates, tag modifiers) and a .ranked.json
(real Thailand cities/activities/hotels scored and sorted against that
recipe). Both print a summary to console too.

Usage:
  node engine/cli.js "<free text prompt>"
  node engine/cli.js --city=<name|code> --persona=<id[,id...]> [--stack]
  node engine/cli.js                      (interactive mode)

Examples:
  node engine/cli.js "family trip to Phuket with 2 kids, need wheelchair access for grandma"
  node engine/cli.js --city=HKT --persona=senior_citizen
  node engine/cli.js --city=HKT --persona=senior_citizen,bachelor_trip     # side-by-side compare, same city
  node engine/cli.js --persona=senior_citizen,bachelor_trip                # compare across all cities
  node engine/cli.js --city=HKT --persona=family_trip,wheelchair_friendly --stack   # compose into one blended persona
  node engine/cli.js "family trip to Phuket, need wheelchair access" --compare      # force compare view on derived personas

In interactive mode, either type free text or the shorthand:
  city:HKT persona:bachelor_trip

Valid persona ids:
  ${data.ALL_PERSONA_IDS.join(', ')}

Known cities:
  ${data.cityFile.entities.map((c) => c.name).join(', ')}
`);
}

/**
 * A single 'line' listener feeding a queue, so any number of sequential
 * `next()` calls can consume lines one at a time — regardless of whether
 * they arrive interactively (typed one at a time) or all at once (piped
 * input). Plain chained `rl.question()` calls lose lines in the piped case,
 * because each call only attaches its listener after the previous one
 * resolves, and readline doesn't buffer 'line' events for a listener that
 * isn't there yet.
 */
function createLineReader(rl) {
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return {
    next(prompt) {
      if (prompt) process.stdout.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function lineToInput(line) {
  const shorthand = parseShorthandLine(line);
  return shorthand ? { flags: shorthand, text: '' } : { flags: {}, text: line };
}

const QUIT = Symbol('quit');

/** Extract, show the recipe JSON, then let the user correct it (merging overrides) before it's written — the "ask if anything to add" step. */
async function confirmExtraction(reader, initialInput) {
  let ext;
  try {
    ext = buildExtraction(initialInput);
  } catch (err) {
    console.log(`\n! ${err.message}\n`);
    return null;
  }

  while (true) {
    printRecipeJSON(ext);
    const raw = await reader.next(
      '\nLooks right? [Enter = continue] or correct it (e.g. "persona:friends_trip", "city:Bangkok", or free text to add) — "cancel" to drop, "quit" to exit:\n> '
    );
    if (raw === null) return null; // stream closed
    const answer = raw.trim();

    if (!answer) return ext;
    if (/^(quit|exit)$/i.test(answer)) return QUIT;
    if (/^(cancel|no|skip)$/i.test(answer)) {
      console.log('Cancelled.\n');
      return null;
    }

    const override = parseShorthandLine(answer);
    const mergedFlags = override ? { ...ext.flags, ...override } : ext.flags;
    const mergedText = override ? ext.text : ext.text ? `${ext.text} ${answer}` : answer;

    try {
      ext = buildExtraction({ flags: mergedFlags, text: mergedText });
    } catch (err) {
      console.log(`\n! ${err.message}`);
    }
  }
}

async function runInteractive() {
  console.log('Travelomore Core Engine — interactive query mode. Type a prompt, or "help", or "quit".\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const reader = createLineReader(rl);

  while (true) {
    const raw = await reader.next('> ');
    if (raw === null) break; // stream closed (e.g. piped input ran out, or Ctrl-D)
    const line = raw.trim();
    if (!line) continue;
    if (/^(quit|exit)$/i.test(line)) break;
    if (/^help$/i.test(line)) {
      printHelp();
      continue;
    }

    const ext = await confirmExtraction(reader, lineToInput(line));
    if (ext === QUIT) break;
    if (ext) writeAndSummarize(ext);
  }
  rl.close();
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  printHelp();
} else if (argv.length === 0) {
  await runInteractive();
} else {
  handleQueryOnce(parseArgv(argv));
}
