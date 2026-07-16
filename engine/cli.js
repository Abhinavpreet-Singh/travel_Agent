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
import { pathToFileURL } from 'node:url';

import { loadThailand, writeJSON, ROOT } from './loadData.js';
import { scoreEntity, rankEntities, composePersonas } from './score.js';
import { buildExplanation } from './explain.js';
import { derivePersonas, parseFreeTextToBrief } from './personaFromBrief.js';
import { experienceFitFor, BLENDS, deriveBucketListValue, classifyPersonaRoles } from './experienceFit.js';
import { cityCoverage } from './coverage.js';

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
const RECOGNIZED_FLAG_KEYS = new Set(['city', 'persona', 'compare', 'stack', 'rank']);

function parseShorthandLine(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((t) => /^[a-zA-Z_]+:.+$/.test(t))) return null;
  const flags = {};
  for (const t of tokens) {
    const idx = t.indexOf(':');
    flags[t.slice(0, idx).toLowerCase()] = t.slice(idx + 1);
  }
  // Only treat this as recognized shorthand if at least one key is something
  // actually read downstream. Otherwise a hopeful "budget:50000" (typed after
  // being told budget is missing) would silently vanish: parsed as a flag,
  // but nothing reads flags.budget, and the free-text merge path is skipped
  // whenever `override` is truthy — so it wouldn't even reach
  // parseFreeTextToBrief's own budget regex. Falling back to null here makes
  // the caller treat the whole line as free text instead, which does work.
  const hasRecognizedKey = Object.keys(flags).some((k) => RECOGNIZED_FLAG_KEYS.has(k));
  return hasRecognizedKey ? flags : null;
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

const WEATHER_DEPENDENT_CATEGORIES = new Set([
  'beach',
  'beach_club',
  'water_sports',
  'island_hopping',
  'diving',
  'nature',
  'adventure',
  'scenic',
  'road_trip',
]);
const WEATHER_DEPENDENT_TAGS = new Set(['boat', 'boat_only_access', 'hiking', 'kayak', 'sunset_spot', 'sunrise_spot', 'viewpoint']);

/** Rain/heat washes out an outdoor day; an indoor museum day doesn't care. Cheap category+tag heuristic, same spirit as best_time. */
function weatherDependency(entity) {
  const cat = (entity.category ?? '').toLowerCase();
  const tags = entity.tags ?? [];
  if (tags.includes('indoor')) return 'low';
  if (WEATHER_DEPENDENT_CATEGORIES.has(cat) || tags.some((t) => WEATHER_DEPENDENT_TAGS.has(t))) return 'high';
  return 'low';
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
      weather_dependency: weatherDependency(entity),
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

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseDurationDays(durationStr) {
  if (!durationStr) return null;
  const m = durationStr.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** How many cities is it realistic to combine for a trip this long? Nobody spends a 7-day trip in one city, and nobody meaningfully combines 3 cities in 4 days. */
function comboSizeForDuration(days) {
  if (days === null || days < 4) return null;
  if (days < 8) return 2;
  return 3;
}

function kCombinations(arr, k) {
  if (k === 1) return arr.map((x) => [x]);
  const result = [];
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of kCombinations(arr.slice(i + 1), k - 1)) result.push([arr[i], ...rest]);
  }
  return result;
}

/**
 * The gap this actually fills: every other output here answers "best
 * single city," but nobody spends a week-long trip in one place. Scores
 * combinations of the top eligible cities by their average individual
 * score, minus a distance penalty computed from real coordinates
 * (haversine) — not a travel-time API, just a proxy for "how much does
 * combining these cost you." Editorial heuristic (every ~300km of average
 * inter-city distance costs about a point, capped at -2), documented as
 * such, not a hardcoded per-destination opinion table.
 */
function buildCityCombinations(recommendedCities, durationDays) {
  const size = comboSizeForDuration(durationDays);
  if (!size || !recommendedCities || recommendedCities.length < size) return null;

  const pool = recommendedCities.slice(0, 8); // keep combinatorics small and quality high
  const coordsById = new Map(data.cityFile.entities.map((c) => [c.id, c.coordinates]));

  const combos = kCombinations(pool, size).map((group) => {
    const avgScore = group.reduce((s, c) => s + c.score_0_10, 0) / group.length;
    let totalDistance = 0;
    let legs = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        totalDistance += haversineKm(coordsById.get(group[i].entity_id), coordsById.get(group[j].entity_id));
        legs++;
      }
    }
    const avgDistanceKm = Math.round(totalDistance / legs);
    const distancePenalty = Math.min(avgDistanceKm / 300, 2);
    return {
      cities: group.map((c) => c.name),
      combined_score: Number((avgScore - distancePenalty).toFixed(1)),
      individual_scores: Object.fromEntries(group.map((c) => [c.name, c.score_0_10])),
      avg_distance_km: avgDistanceKm,
    };
  });

  return combos.sort((a, b) => b.combined_score - a.combined_score).slice(0, 5);
}

// Logistics vs. exploration signals — a documented, fixed split, not tuned
// per-persona or per-destination. Whichever cities happen to score well on
// either side is an output of the math, never an input to it.
const LOGISTICS_SIGNALS = ['direct_flight_access', 'flight_time_ease', 'arrival_transfer_ease', 'intracity_transport_quality'];
const EXPLORATION_SIGNALS = ['photogenic_quality', 'iconic_landmark_density', 'content_novelty', 'golden_hour_access'];

/**
 * Short trips can't absorb travel friction the way long ones can — losing
 * half of a 2-day trip to a bad transfer is a much bigger fraction of the
 * trip than losing half a day out of two weeks. Scales LOGISTICS_SIGNALS up
 * and EXPLORATION_SIGNALS down for CITY scoring only (once you've picked a
 * city, whether an activity is a temple or a market doesn't depend on trip
 * length the same way) — applied uniformly regardless of which specific
 * cities that favors, so it can't be reverse-engineered into a
 * destination preference. Only fires for a persona that actually weights at
 * least one logistics signal already (renormalizing zero still gives zero —
 * this amplifies an existing signal, it doesn't invent one from nothing).
 */
function applyDurationAdjustment(weights, durationDays) {
  if (durationDays === null || durationDays > 3) return { weights, applied: false };
  const logisticsMultiplier = durationDays <= 1 ? 2.5 : durationDays === 2 ? 2.0 : 1.5;
  const explorationMultiplier = durationDays <= 1 ? 0.5 : durationDays === 2 ? 0.6 : 0.75;

  const adjusted = {};
  for (const [signal, w] of Object.entries(weights)) {
    if (LOGISTICS_SIGNALS.includes(signal)) adjusted[signal] = w * logisticsMultiplier;
    else if (EXPLORATION_SIGNALS.includes(signal)) adjusted[signal] = w * explorationMultiplier;
    else adjusted[signal] = w;
  }
  const total = Object.values(adjusted).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(adjusted)) adjusted[k] /= total;

  return {
    weights: adjusted,
    applied: true,
    duration_days: durationDays,
    logistics_multiplier: logisticsMultiplier,
    exploration_multiplier: explorationMultiplier,
    note: `Trip is ${durationDays} day(s) — scaled ${LOGISTICS_SIGNALS.join('/')} up ${logisticsMultiplier}x and ${EXPLORATION_SIGNALS.join('/')} down ${explorationMultiplier}x for city selection, then renormalized. Applies to city ranking only, not activities/hotels within a chosen city.`,
  };
}

// A trip is not a catalogue. The engine scores the WHOLE pool internally, but
// what leaves the engine (ranked.json) is a trip-sized shortlist —
// and its LENGTH is adaptive, not a fixed top-N. How many we hand over should
// track actual NEED, driven by three things at once:
//   1. Quality — only entities near the top score and above a floor. A persona
//      with only a few strong matches returns only those, however big the pool.
//   2. Feasibility — how many a trip of this length can realistically use
//      (~3 activity candidates per day; cities scale with duration).
//   3. A hard ceiling, so a huge pool can never bloat the payload.
// So a 3-day trip or a weak-match persona might get ~8 activities; a rich
// week-long one ~20 — never a flat 40. Hotels are omitted here entirely: a
// hotel is chosen AFTER city and dates are fixed, so it's a later fetch step.
const ACT_SHORTLIST = { floor: 6.5, band: 1.5, perDay: 3, defaultCount: 15, ceiling: 40 };
const CITY_SHORTLIST = { floor: 6.0, band: 2.0, ceiling: 5 };
const MAX_EXCLUDED = 20; // keep the "avoid" list tight and useful, not exhaustive

/**
 * Adaptive quality-and-need cut over an already best-first list. Keeps only
 * entries within `band` of the top score and at/above `floor`, then takes at
 * most `feasible` of those (capped by `ceiling`). Returns as FEW as the data
 * and the need justify — down to a handful — rather than padding to a target.
 */
function qualityShortlist(list, { floor, band, feasible, ceiling }) {
  if (!list.length) return [];
  const top = list[0].score_0_10;
  const cutoff = Math.max(floor, top - band);
  const strong = list.filter((r) => r.score_0_10 >= cutoff);
  return strong.slice(0, Math.min(strong.length, feasible, ceiling));
}

/** Cities a trip of this length can actually anchor in, plus a buffer of extra CANDIDATES (the itinerary agent picks the final 2-3 from these, so a little generosity here just widens choice, it doesn't lengthen the trip). Unknown duration -> a sensible middle. */
function citiesNeeded(durationDays) {
  const base = durationDays == null ? 2 : durationDays < 4 ? 1 : durationDays < 8 ? 2 : 3;
  return base + 3;
}

// How much a city's OWN activity lineup lifts its rank. A city is more than its
// ambient qualities: a couple's week in Bangkok is carried by its activities
// even though Bangkok scores mid as a "couple city" (crowded, noisy). Raised
// from 0.4 → 0.5 because for a multi-DAY trip, what you can actually DO all week
// weighs nearly as much as how nice the place is to sit in. Set to 0 to go back
// to pure ambient-attribute city ranking.
const CITY_ACTIVITY_BLEND = 0.5;
// Activity strength has three parts:
//   peak      — how good the best few are.
//   breadth   — how MANY genuinely strong options exist (a hub you can fill a
//               week in beats a town with three things to do).
//   diversity — how many distinct CATEGORIES those strong options span. This is
//               the "best week, not best city" fix: a place with a beach, an
//               aquarium, elephants and a show makes a richer week than one with
//               six variations of the same beach day, even if the counts match.
//               Without it the engine happily recommended beach-x-7 (safe, dull).
// Both breadth and diversity saturate so a big catalogue can't run away with it.
const ACTIVITY_STRENGTH = {
  topK: 5,
  peakWeight: 0.5,
  breadthWeight: 0.2,
  diversityWeight: 0.3,
  breadthScale: 6,
  diversityScale: 4,
  strongFloor: 7,
};

// The raw `category` field has near-duplicate sub-types (a data-audit finding):
// `beach_club` is a `beach`, `diving` is `water_sports`, etc. For the DIVERSITY
// count these must collapse — otherwise a city with a beach AND a beach club
// reads as "two kinds of experience" when it's one, inflating variety. Only the
// unambiguous sub-type merges are listed; genuinely distinct kinds (heritage vs
// culture, adventure vs nature) are left alone. Used for variety scoring only —
// the raw category is untouched in the data and everywhere else.
const CANONICAL_CATEGORY = { beach_club: 'beach', diving: 'water_sports', heritage_wellness: 'wellness', dining: 'food' };
const canonicalCategory = (c) => CANONICAL_CATEGORY[c] ?? c;

/** peak+breadth+diversity strength (0-1) of a city's own activities for this persona, or null if it has none eligible. */
function cityActivityStrength(cityEntity, persona) {
  const acts = data.activities.filter((a) => a.parent_id === cityEntity.id);
  if (!acts.length) return null;
  const categoryById = new Map(acts.map((a) => [a.id, a.category]));
  const ranked = rankEntities(
    acts.map((a) => ({ entity: a, ancestors: [cityEntity, data.country] })),
    persona,
    data.dictionary
  ).filter((r) => r.eligible);
  if (!ranked.length) return null;
  const topK = ranked.slice(0, ACTIVITY_STRENGTH.topK);
  const peak = topK.reduce((s, r) => s + r.score_0_1, 0) / topK.length;
  const strong = ranked.filter((r) => r.score_0_10 >= ACTIVITY_STRENGTH.strongFloor);
  const strongCount = strong.length;
  const varietyCount = new Set(strong.map((r) => canonicalCategory(categoryById.get(r.entity_id))).filter(Boolean)).size;
  const breadth = 1 - Math.exp(-strongCount / ACTIVITY_STRENGTH.breadthScale);
  const diversity = 1 - Math.exp(-varietyCount / ACTIVITY_STRENGTH.diversityScale);
  const strength01 =
    ACTIVITY_STRENGTH.peakWeight * peak + ACTIVITY_STRENGTH.breadthWeight * breadth + ACTIVITY_STRENGTH.diversityWeight * diversity;
  return { strength01, strongCount, varietyCount };
}

/**
 * Fold each eligible city's activity strength back into its score, then re-sort.
 * This is what lets an activity-rich but ambient-mediocre city (Bangkok for a
 * couple) climb into the shortlist instead of being ranked purely on how calm/
 * photogenic the place itself is. `persona` here is the plain (non
 * duration-adjusted) persona — activity fit isn't a function of trip length.
 */
function blendCityActivityStrength(rankedCities, persona) {
  if (CITY_ACTIVITY_BLEND <= 0) return rankedCities;
  return rankedCities
    .map((c) => {
      if (!c.eligible && c.eligible !== undefined) return c; // recommended list is all-eligible, but stay safe
      const entity = data.citiesById[c.entity_id];
      const s = entity ? cityActivityStrength(entity, persona) : null;
      if (!s) return c;
      const base01 = c.score_0_10 / 10;
      const blended01 = (1 - CITY_ACTIVITY_BLEND) * base01 + CITY_ACTIVITY_BLEND * s.strength01;
      const score_0_10 = Number((blended01 * 10).toFixed(1));
      const why = [...(c.why ?? [])];
      // Only cite the activity lineup when it's what actually carried the city.
      if (s.strength01 * 10 >= c.score_0_10 + 0.3 && s.strongCount >= 5) {
        why.unshift(`Rich, varied lineup — ${s.strongCount} strong activities across ${s.varietyCount} categories`);
      }
      return {
        ...c,
        score_0_10,
        city_score_0_10: c.score_0_10,
        activity_strength_0_10: Number((s.strength01 * 10).toFixed(1)),
        activity_variety: s.varietyCount,
        why,
      };
    })
    .sort((a, b) => b.score_0_10 - a.score_0_10);
}

// The chosen blend (see experienceFit.js::BLENDS and the additive-vs-multiplicative
// comparison). 0.6 physical + 0.4 experience_fit.
const EXPERIENCE_BLEND = 'additive';

/**
 * Re-score a ranked activity list by blending physical fit with experience_fit,
 * and attach the full trace (physical_fit / experience_fit / final) to each item.
 * `personaIds` are the composed persona's constituent ids → the fit axes.
 */
function applyExperienceFit(recommended, personaIds) {
  const actById = new Map(data.activities.map((a) => [a.id, a]));
  return recommended
    .map((a) => {
      const entity = actById.get(a.entity_id);
      if (!entity) return a;
      const { fit, axes, binding_axis, fit_reason } = experienceFitFor(entity, personaIds);
      const physical01 = a.score_0_10 / 10;
      const final01 = BLENDS[EXPERIENCE_BLEND](physical01, fit);
      return {
        ...a,
        physical_fit_0_10: a.score_0_10,
        experience_fit: Number(fit.toFixed(2)),
        experience_fit_axes: axes,
        experience_fit_binding: binding_axis,
        fit_reason,
        score_0_10: Number((final01 * 10).toFixed(1)),
      };
    })
    .sort((x, y) => y.score_0_10 - x.score_0_10);
}

// Travel-STYLE personas that co-drive the destination vibe (luxury beach vs
// budget beach) but don't define the group archetype. Everything not a
// constraint and not one of these is treated as the majority archetype driver.
const STYLE_MODIFIER_PERSONAS = new Set(['luxury', 'budget', 'wellness', 'adventure', 'foodie', 'digital_nomad', 'road_trip_friendly', 'content_creator', 'first_international_trip']);

/**
 * DESTINATION STRATEGY: build the persona that SELECTS destinations. The
 * majority persona (+ any style modifiers like luxury/budget) drives the STYLE
 * weights; constraint personas (pregnancy/wheelchair/infant) contribute ONLY
 * their gates. This is the "what's best for the majority, THEN can the
 * constraint do it safely?" ordering — so 5 friends + a pregnant honeymooner get
 * beach/social cities that happen to have hospitals, not a calm inland trip
 * chosen FOR the pregnancy. Special personas (honeymoon) don't drive the
 * destination unless they ARE the majority; they get dedicated activity moments.
 */
function buildDestinationPersona(roles, personaIds) {
  const modifiers = personaIds.filter((p) => STYLE_MODIFIER_PERSONAS.has(p) && p !== roles.majority);
  const stylePersonas = [...new Set([roles.majority, ...modifiers])];
  const style = composePersonas(stylePersonas, data.personasById);
  const constraintHard = roles.constraints.flatMap((id) => data.personasById[id]?.hard_gates ?? []);
  const constraintSoft = roles.constraints.flatMap((id) => data.personasById[id]?.soft_gates ?? []);
  return {
    ...style,
    hard_gates: [...(style.hard_gates ?? []), ...constraintHard],
    soft_gates: [...(style.soft_gates ?? []), ...constraintSoft],
    style_personas: stylePersonas,
  };
}

/**
 * DAY ALLOCATION (Round 21): decide nights-per-city so the planner LLM never has
 * to. Every route city gets >= 1 day (rule 4: special-moment cities are in the
 * route, so they're guaranteed an overnight); the remaining days are split by
 * ACTIVITY DENSITY (rule 2), with PACE skewing the split — relaxed concentrates
 * days into the richer cities (fewer changes, rule 3), active flattens it. Uses
 * largest-remainder so the total ALWAYS equals duration_days (rule 1).
 */
function buildDayAllocation(route, durationDays, recommendedActivities, pace) {
  if (!durationDays || !route.length) return null;
  const n = route.length;
  if (durationDays <= n) return route.map((c) => ({ city: c, days: 1 })).slice(0, durationDays); // degenerate guard

  const density = Object.fromEntries(route.map((c) => [c, 0]));
  for (const a of recommendedActivities) if (a.city in density) density[a.city] += 1;
  const exp = pace === 'relaxed' ? 1.6 : pace === 'active' ? 0.7 : 1;
  // ANCHOR BIAS (Round 22): the route anchor (route[0], the #1 city) is the base
  // the trip is built around — it must not lose the majority of days just because
  // a secondary city has a denser catalogue. Bias its weight, then GUARANTEE it
  // keeps a plurality below.
  const weights = route.map((c, i) => Math.pow(Math.max(1, density[c]), exp) * (i === 0 ? ANCHOR_DAY_BIAS : 1));

  const remaining = durationDays - n; // after 1-per-city floor
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  const quotas = weights.map((w) => (remaining * w) / totalW);
  const alloc = quotas.map((q) => 1 + Math.floor(q));
  const leftover = durationDays - alloc.reduce((a, b) => a + b, 0);
  const byFrac = quotas.map((q, i) => ({ i, f: q - Math.floor(q) })).sort((a, b) => b.f - a.f);
  for (let k = 0; k < leftover; k++) alloc[byFrac[k % n].i] += 1;

  // Intent guarantee: while any non-anchor city has MORE days than the anchor,
  // move one day from the largest such city (that can spare it) to the anchor.
  // Density still decides the split AMONG the non-anchor cities; it just can't
  // override the anchor's primacy. Converges in <= duration steps.
  for (let guard = 0; guard < durationDays; guard++) {
    let take = -1;
    for (let i = 1; i < n; i++) if (alloc[i] > alloc[0] && alloc[i] > 1 && (take === -1 || alloc[i] > alloc[take])) take = i;
    if (take === -1) break;
    alloc[take] -= 1;
    alloc[0] += 1;
  }

  return route.map((c, i) => ({ city: c, days: alloc[i] }));
}

function runSingle(city, persona, durationDays = null) {
  const cityPool = city ? [city] : data.cityFile.entities;
  const personaIds = persona.composed_from ?? [persona.id];
  const roles = classifyPersonaRoles(personaIds);

  // Destinations are chosen by the MAJORITY (style), gated by CONSTRAINTS —
  // NOT by the constraint-blended full persona (that pulled a friends trip
  // inland because a pregnancy constraint out-weighted the friends).
  const destPersona = buildDestinationPersona(roles, personaIds);
  const styleStrengthPersona = composePersonas(destPersona.style_personas, data.personasById);
  const durationAdj = applyDurationAdjustment(destPersona.weights, durationDays);
  const cityPersona = durationAdj.applied ? { ...destPersona, weights: durationAdj.weights } : destPersona;

  // Rank cities FIRST — the recommended cities define where the trip goes, and
  // therefore which activities are even relevant. Then fold each city's own
  // activity lineup back into its score, so an activity-rich city (Bangkok for a
  // couple) can climb even if the place itself scores mid on ambient qualities.
  const cities = city ? null : splitRecommendedExcluded(rankAll(cityPool, data.ancestorsOf.destination_city, cityPersona, cityPool.length), 'city');
  const blendedCities = city ? [] : blendCityActivityStrength(cities.recommended, styleStrengthPersona);
  const recommendedCities = qualityShortlist(blendedCities, {
    floor: CITY_SHORTLIST.floor,
    band: CITY_SHORTLIST.band,
    feasible: citiesNeeded(durationDays),
    ceiling: CITY_SHORTLIST.ceiling,
  });

  // ROUTE GENERATION (Step 2/3): candidate_cities is the shortlist above; the
  // itinerary_route is the actual set of cities the trip VISITS, sized to
  // duration (1 for <4 days, 2 for 4-7, 3 for 8+) and chosen geographically via
  // the city combinations (avg score minus distance penalty). Activities are then
  // drawn from the ROUTE, not the whole candidate set.
  const combos = city ? null : buildCityCombinations(recommendedCities, durationDays);
  const routeSize = durationDays == null ? 2 : durationDays < 4 ? 1 : durationDays < 8 ? 2 : 3;
  let itinerary_route;
  if (city) {
    itinerary_route = [city.name];
  } else {
    // The #1 candidate ANCHORS the route — otherwise the combo's distance penalty
    // can drop a geographically-isolated top city (Phuket for friends) in favour
    // of a convenient-but-weaker pair. Fill the rest with the best combo that
    // KEEPS the anchor; fall back to the next-best candidates.
    const anchor = recommendedCities[0]?.name;
    if (routeSize <= 1 || !anchor) {
      itinerary_route = recommendedCities.slice(0, Math.max(1, routeSize)).map((c) => c.name);
    } else {
      const comboWithAnchor = combos?.find((c) => c.cities.includes(anchor) && c.cities.length === routeSize);
      itinerary_route = comboWithAnchor?.cities ?? [anchor, ...recommendedCities.slice(1, routeSize).map((c) => c.name)];
    }
  }

  // Destination strategy report (majority vs constraint routing, incl. cities
  // rejected for UNDERSERVING the majority — a concept the engine lacked before).
  let destination_strategy = null;
  if (!city) {
    const recSet = new Set(recommendedCities.map((c) => c.entity_id));
    let rejected_routes = [];
    if (roles.constraints.length) {
      const blended = splitRecommendedExcluded(rankAll(cityPool, data.ancestorsOf.destination_city, persona, cityPool.length), 'city').recommended;
      rejected_routes = blended
        .filter((c) => !recSet.has(c.entity_id))
        .slice(0, 3)
        .map((c) => ({ city: c.name, reason: `underserves majority persona (${roles.majority}) — scores on the constraint blend, not ${roles.majority} style` }));
    }
    destination_strategy = {
      majority_persona: roles.majority,
      constraint_personas: roles.constraints,
      special_personas: roles.special,
      candidate_cities: recommendedCities.map((c) => ({ city: c.name, reason: c.why?.[0] ?? `${roles.majority} fit` })),
      itinerary_route,
      rejected_routes,
    };
  }

  // ACTIVITY STRATEGY (Step 1): activities come from the ROUTE cities and are
  // ranked by the DESTINATION persona (majority style + constraint gates) — NOT
  // the full constraint-blended persona. So a friends trip surfaces beach/social
  // activities, pregnancy still GATES unsafe ones (pregnancy_safe/altitude), and
  // experience_fit demotes inappropriate ones. This is the Round-17 fix applied
  // one layer down: destinations AND activities are now majority-driven.
  const routeNames = new Set(itinerary_route);
  const scopeCityIds = city ? new Set([city.id]) : new Set(data.cityFile.entities.filter((c) => routeNames.has(c.name)).map((c) => c.id));
  const activityPool = data.activities.filter((a) => scopeCityIds.has(a.parent_id));
  const activities = splitRecommendedExcluded(
    rankAll(activityPool, data.ancestorsOf.activity, destPersona, city ? activityPool.length : ACT_SHORTLIST.ceiling),
    'activity'
  );
  const fitted = applyExperienceFit(activities.recommended, personaIds);

  const activityFeasible = durationDays ? Math.ceil(durationDays * ACT_SHORTLIST.perDay) : ACT_SHORTLIST.defaultCount;
  let recommendedActivities = qualityShortlist(fitted, {
    floor: ACT_SHORTLIST.floor,
    band: ACT_SHORTLIST.band,
    feasible: activityFeasible,
    ceiling: ACT_SHORTLIST.ceiling,
  });

  // SPECIAL MOMENTS (Step 1): each special persona (honeymoon, bachelor/ette)
  // gets ONE dedicated activity injected even if the majority ranking didn't
  // surface it — a romantic dinner on a friends trip. It must still be in-route,
  // pass constraints, and clear the experience-fit floor for everyone.
  if (!city && roles.special.length) {
    const chosen = new Set(recommendedActivities.map((a) => a.entity_id));
    for (const special of roles.special) {
      const specialP = composePersonas([special], data.personasById);
      const pool = rankAll(activityPool, data.ancestorsOf.activity, specialP, activityPool.length).filter((r) => r.eligible && !chosen.has(r.entity_id));
      const moment = applyExperienceFit(pool, personaIds).find((a) => a.experience_fit >= 0.5);
      if (moment) {
        recommendedActivities.push({ ...moment, moment_for: special });
        chosen.add(moment.entity_id);
      }
    }
  }

  // DAY ALLOCATION (Round 21): authoritative nights-per-city, computed from
  // activity density + pace, so the planner never guesses. Uses the final
  // recommendedActivities (incl. injected special moments) as the density signal.
  const city_allocation = buildDayAllocation(itinerary_route, durationDays, recommendedActivities, tripPace(personaIds));

  // Totals before the cut + why the shortlist is the size it is, so the output
  // is honest about being a needs-based subset ("8 of 47", not "the best 8").
  // Activity total is now the eligible count WITHIN the recommended cities.
  const eligibleTotals = {
    cities: city ? null : cities?.recommended.length ?? 0,
    activities: activities.recommended.length,
  };
  const shortlist_rationale =
    `Activities are drawn only from the recommended cities (${city ? city.name : recommendedCities.map((c) => c.name).join(', ') || 'none'}), so the two lists stay coherent for itinerary planning. ` +
    (city || CITY_ACTIVITY_BLEND <= 0
      ? ''
      : `City ranking blends ambient fit (${Math.round((1 - CITY_ACTIVITY_BLEND) * 100)}%) with the strength of each city's own activity lineup for this persona (${Math.round(
          CITY_ACTIVITY_BLEND * 100
        )}%) — so an activity-rich city (e.g. Bangkok for a couple) can earn a place even if the location itself scores only mid on ambient qualities; see city_score_0_10 vs activity_strength_0_10 on each city. `) +
    `Shortlist sized to trip need, not catalogue size: activities kept within ${ACT_SHORTLIST.band} pts of the top score ` +
    `(min ${ACT_SHORTLIST.floor}/10) and capped at ${activityFeasible} for ${durationDays ? `${durationDays} day(s)` : 'an unspecified duration'} ` +
    `(~${ACT_SHORTLIST.perDay}/day); cities capped at ${citiesNeeded(durationDays)}. Fewer are returned when fewer genuinely fit the persona.`;

  return {
    persona: { id: persona.id, label: persona.label, composed_from: persona.composed_from ?? [persona.id] },
    duration_adjustment: durationAdj.applied
      ? { applied: true, duration_days: durationAdj.duration_days, note: durationAdj.note }
      : { applied: false },
    recommended_cities: city ? undefined : recommendedCities, // candidate_cities
    itinerary_route, // the actual cities visited ([city.name] when a city is pinned)
    city_allocation, // authoritative nights-per-city (null if duration unknown)
    recommended_city_combinations: city ? undefined : combos,
    recommended_activities: recommendedActivities,
    excluded_options: [...(cities?.excluded ?? []), ...activities.excluded].slice(0, MAX_EXCLUDED),
    eligible_totals: eligibleTotals,
    shortlist_rationale,
    destination_strategy,
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
  if (result.duration_adjustment?.applied) {
    console.log(`Duration adjustment: ${result.duration_adjustment.note}`);
  }
  if (result.recommended_cities) {
    const cityTotal = result.eligible_totals?.cities ?? result.recommended_cities.length;
    console.log(`Recommended cities (${result.recommended_cities.length} of ${cityTotal} eligible — sized to trip need):`);
    for (const c of result.recommended_cities) {
      console.log(`  ${c.score_0_10.toFixed(1).padStart(4)}  ${c.name.padEnd(28)} ${c.why?.[0] ?? ''}`);
    }
  }
  if (result.recommended_city_combinations?.length) {
    console.log(`Recommended city combinations (for a multi-city trip):`);
    for (const combo of result.recommended_city_combinations) {
      console.log(`  ${combo.combined_score.toFixed(1).padStart(4)}  ${combo.cities.join(' + ').padEnd(28)} ~${combo.avg_distance_km}km apart`);
    }
  }
  const actTotal = result.eligible_totals?.activities ?? result.recommended_activities.length;
  console.log(`Recommended activities (${result.recommended_activities.length} of ${actTotal} eligible — sized to trip need):`);
  for (const a of result.recommended_activities.slice(0, 15)) {
    console.log(`  ${a.score_0_10.toFixed(1).padStart(4)}  ${a.name.padEnd(38)} ${a.city ?? ''}`);
  }
  if (result.recommended_activities.length > 15) {
    console.log(`  ... and ${result.recommended_activities.length - 15} more in the shortlist`);
  }
  console.log(`Hotels: deferred — fetched later once city & dates are fixed.`);
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

/**
 * Programmatic entry point — the same pipeline `writeAndSummarize` runs, but
 * with NO console output and NO files written. Returns the two source-of-truth
 * documents so callers (the benchmark suite, tests, future services) can assert
 * on real engine output instead of re-implementing scoring. Accepts a raw query
 * string or a `{ flags, text }` object (flags mirror the CLI: city, persona, …).
 */
export function evaluateQuery(input) {
  const parsed = typeof input === 'string' ? { flags: {}, text: input } : { flags: input.flags ?? {}, text: input.text ?? '' };
  const ext = buildExtraction(parsed);
  const durationDays = parseDurationDays(ext.brief?.duration);
  const rankedResult = ext.compareMode ? runCompare(ext.city, ext.personaIds) : runSingle(ext.city, ext.composed, durationDays);
  const recipe = recipeToJSON(ext);
  const ranked = {
    mode: ext.compareMode ? 'compare' : 'single',
    query: { text: ext.text || null, resolved_city: ext.city?.id ?? null, personas: ext.personaIds },
    ...rankedResult,
  };
  const context = ext.compareMode ? null : buildLLMContext(ext, rankedResult);
  const planner = ext.compareMode ? null : plannerContextBuilder(ext, rankedResult);
  return { ext, recipe, ranked, context, planner };
}

// Enough ranked candidates for the LLM to build a week from; it fleshes out the
// rest with its own knowledge. Kept modest so the payload stays token-cheap even
// with per-item signal breakdowns.
const CONTEXT_ACTIVITY_CAP = 10;

// Cheap persona-derived trip hints the itinerary LLM values but shouldn't have
// to infer. All three are pure lookups over the derived persona ids.
const RELAXED_PERSONAS = new Set(['senior_citizen', 'family_trip', 'child_friendly', 'infant_friendly', 'pregnancy_friendly', 'wheelchair_friendly', 'honeymoon', 'couple', 'wellness']);
const ACTIVE_PERSONAS = new Set(['friends_trip', 'young_couple', 'bachelor_trip', 'bachelorette_trip', 'adventure']);
const HIGH_SAFETY_PERSONAS = new Set(['family_trip', 'child_friendly', 'infant_friendly', 'senior_citizen', 'pregnancy_friendly', 'female_solo']);
const tripPace = (ids) => (ids.some((p) => RELAXED_PERSONAS.has(p)) ? 'relaxed' : ids.some((p) => ACTIVE_PERSONAS.has(p)) ? 'active' : 'moderate');
const safetyPriority = (ids) => (ids.some((p) => HIGH_SAFETY_PERSONAS.has(p)) ? 'high' : 'normal');
const mobilityRequirement = (ids) =>
  ids.includes('wheelchair_friendly') ? 'step_free_required' : ids.includes('senior_citizen') || ids.includes('infant_friendly') ? 'low_walking' : 'normal';

/**
 * The signals that most drove THIS entity's fit for THIS persona, as {signal: 0-100}.
 * Sorted by the persona's weight (most-relevant dimension first), so the itinerary
 * LLM sees the same axes the engine judged on and can re-reason for the traveller
 * (a family reads kid/safety; a couple reads romance/quiet). This is the "feed the
 * reasoning, not just the verdict" part — a decomposed score, not one opaque number.
 */
function signalBreakdown(entity, ancestors, persona, n) {
  const r = scoreEntity(entity, ancestors, persona, data.dictionary);
  return Object.fromEntries(
    [...r.contributions]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, n)
      .map((c) => [c.signal_id, Math.round(c.value * 100)])
  );
}

/**
 * The hand-off document sent to an itinerary LLM. Design (industry-standard
 * agentic hand-off): STRUCTURED and MACHINE-COMPARABLE, not prose. Explicit
 * 0-100 scores (comparable across items), a per-item signal breakdown (so the
 * model reasons from real dimensions, not a verdict), a structured trip_profile,
 * and a hard `avoid` list. No weights/gates, no empty fields — compact but
 * information-dense. Order still encodes rank; the score makes the gaps legible.
 */
export function buildLLMContext(ext, rankedResult) {
  const roster = ext.derived?.roster;
  const persona = ext.composed; // single composed persona in this mode
  const ids = ext.personaIds;
  const missing = [...new Set(buildConstraintSummary(ext).missing.map(shortMissingLabel))];
  const durationDays = parseDurationDays(ext.brief?.duration);

  const group = {};
  if (roster?.adults != null) group.adults = roster.adults;
  if (roster?.children_ages?.length) group.children = roster.children_ages;
  if (roster?.has_senior_adult) group.seniors = true;

  const trip_profile = {
    destination: ext.city?.name ? `Thailand — ${ext.city.name}` : 'Thailand',
    ...(durationDays ? { duration_days: durationDays } : {}),
    ...(Object.keys(group).length ? { group } : {}),
    personas: ids,
    // STEP 1: majority persona drives itinerary STYLE, constraints define
    // EXCLUSIONS, special personas get dedicated MOMENTS. The planner must not
    // let a minority constraint persona dominate the whole trip.
    persona_roles: classifyPersonaRoles(ids),
    pace: tripPace(ids),
    safety_priority: safetyPriority(ids),
    mobility_requirement: mobilityRequirement(ids),
    ...(ext.brief?.dates ? { dates: ext.brief.dates } : {}),
    ...(ext.brief?.budget ? { budget: ext.brief.budget } : {}),
    ...(missing.length ? { needs_confirmation: missing } : {}),
  };

  const city_ranking = (rankedResult.recommended_cities ?? []).map((c) => {
    const entity = data.citiesById[c.entity_id];
    return {
      city: c.name,
      score: Math.round(c.score_0_10 * 10),
      // How many distinct kinds of strong experience the city offers — the
      // "best week" signal. A high score with low variety = one great thing
      // repeated; high variety = a genuinely diverse week. The itinerary LLM
      // should prefer variety for multi-day trips (esp. families/kids).
      ...(c.activity_variety != null ? { activity_variety: c.activity_variety } : {}),
      ...(entity ? { breakdown: signalBreakdown(entity, [data.country], persona, 5) } : {}),
    };
  });

  const activityById = new Map(data.activities.map((a) => [a.id, a]));
  const activity_ranking = (rankedResult.recommended_activities ?? []).slice(0, CONTEXT_ACTIVITY_CAP).map((a) => {
    const entity = activityById.get(a.entity_id);
    const parentCity = entity ? data.citiesById[entity.parent_id] : null;
    return {
      activity: a.name,
      city: a.city,
      ...(a.moment_for ? { moment_for: a.moment_for } : {}),
      score: Math.round(a.score_0_10 * 10), // final = physical ⊕ experience_fit
      // bucket_list_value: how much this is a REASON to visit Thailand (Grand
      // Palace 98, aquarium ~15). The planner uses this so a first-timer's trip
      // isn't mall/café/spa — it's NOT folded into the score, it's a separate
      // axis the planner balances (see the planner prompt).
      ...(entity ? { bucket_list_value: deriveBucketListValue(entity) } : {}),
      ...(entity?.category ? { style: entity.category } : {}),
      ...(a.physical_fit_0_10 != null ? { physical_fit: Math.round(a.physical_fit_0_10 * 10) } : {}),
      ...(a.experience_fit != null ? { experience_fit: Math.round(a.experience_fit * 100) } : {}),
      ...(a.fit_reason?.length ? { fit_reason: a.fit_reason } : {}),
      ...(a.duration_hours != null ? { duration_hours: a.duration_hours } : {}),
      ...(entity ? { signals: signalBreakdown(entity, [parentCity, data.country], persona, 4) } : {}),
    };
  });

  // STEP 7 support: which "first-time Thailand" essentials the candidate pool
  // covers, so the planner (and we) can see at a glance if the trip would miss
  // culture / beach / thai food / market / an iconic experience. Derived from
  // category + bucket_list, not authored.
  const firstTimer = { culture: false, beach: false, thai_food: false, market: false, iconic: false };
  for (const a of activity_ranking) {
    const cat = a.style ?? '';
    if (['heritage', 'culture', 'heritage_wellness'].includes(cat)) firstTimer.culture = true;
    if (['beach', 'island_hopping', 'beach_club'].includes(cat)) firstTimer.beach = true;
    if (['food', 'dining'].includes(cat)) firstTimer.thai_food = true;
    if (cat === 'shopping' || /market/i.test(a.activity)) firstTimer.market = true;
    if ((a.bucket_list_value ?? 0) >= 80) firstTimer.iconic = true;
  }

  // Exclusions grouped by reason so `avoid` is a few lines, not 20 rows.
  const avoidMap = new Map();
  for (const e of rankedResult.excluded_options ?? []) {
    if (e.type === 'hotel') continue;
    if (!avoidMap.has(e.reason)) avoidMap.set(e.reason, []);
    avoidMap.get(e.reason).push(e.name);
  }
  const avoid = [...avoidMap].map(([why, names]) => ({ what: names.join(', '), why }));

  return {
    query: ext.text || null,
    trip_profile,
    ...(rankedResult.destination_strategy ? { destination_strategy: rankedResult.destination_strategy } : {}),
    city_ranking,
    activity_ranking,
    first_timer_essentials: firstTimer,
    ...(avoid.length ? { avoid } : {}),
  };
}

/**
 * The COMPRESSED planner hand-off — what the itinerary LLM actually receives.
 * context.json is the rich, score-laden analysis doc (audit); this strips ALL
 * ranking-engine internals (signal breakdowns, 0-100 scores, bucket values,
 * physical/experience fit) and keeps only what a planner needs to SCHEDULE:
 * the authoritative route, the allowed activities, the constraints, the avoid
 * list, and the rules. Target < ~1000 input tokens. The engine has already
 * ranked; the planner must not re-rank or invent — those are encoded as rules.
 */
export function plannerContextBuilder(ext, rankedResult) {
  const roster = ext.derived?.roster;
  const strategy = rankedResult.destination_strategy;
  const missing = [...new Set(buildConstraintSummary(ext).missing.map(shortMissingLabel))];
  const durationDays = parseDurationDays(ext.brief?.duration);
  const ids = ext.personaIds;
  const activityById = new Map(data.activities.map((a) => [a.id, a]));

  const group = {};
  if (roster?.adults != null) group.adults = roster.adults;
  if (roster?.children_ages?.length) group.children = roster.children_ages;
  if (roster?.has_senior_adult) group.seniors = true;

  const brief = {
    destination: ext.city?.name ? `Thailand — ${ext.city.name}` : 'Thailand',
    ...(durationDays ? { duration_days: durationDays } : {}),
    ...(Object.keys(group).length ? { group } : {}),
    majority: strategy?.majority_persona ?? ids[0] ?? 'default',
    ...(strategy?.constraint_personas?.length ? { constraints: strategy.constraint_personas } : {}),
    ...(strategy?.special_personas?.length ? { special_moments_for: strategy.special_personas } : {}),
    pace: tripPace(ids),
    ...(safetyPriority(ids) === 'high' ? { safety_priority: 'high' } : {}),
    ...(mobilityRequirement(ids) !== 'normal' ? { mobility: mobilityRequirement(ids) } : {}),
    ...(ext.brief?.budget ? { budget: ext.brief.budget } : {}),
    ...(ext.brief?.dates ? { dates: ext.brief.dates } : {}),
    ...(missing.length ? { needs_confirmation: missing } : {}),
  };

  // Route: the ACTUAL itinerary route (the cities the trip visits), authoritative
  // and terse — ordered city names only. The engine already decided; the planner
  // schedules within them and needs no reasons.
  const selected_route = rankedResult.itinerary_route ?? (rankedResult.recommended_cities ?? []).map((c) => c.name);
  // Authoritative nights-per-city — the planner allocates activities within these
  // day budgets, it does not decide how long to stay anywhere.
  const day_allocation = rankedResult.city_allocation ?? null;

  // Activities: grouped by city, name + style + hours only. No scores/fit/bucket/signals.
  const selected_activities = {};
  const firstTimer = { culture: false, beach: false, thai_food: false, market: false, iconic: false };
  for (const a of rankedResult.recommended_activities ?? []) {
    const entity = activityById.get(a.entity_id);
    const cat = entity?.category ?? '';
    (selected_activities[a.city] ??= []).push({ name: a.name, ...(cat ? { style: cat } : {}), ...(a.duration_hours != null ? { hrs: a.duration_hours } : {}), ...(a.moment_for ? { moment_for: a.moment_for } : {}) });
    if (['heritage', 'culture', 'heritage_wellness'].includes(cat)) firstTimer.culture = true;
    if (['beach', 'island_hopping', 'beach_club'].includes(cat)) firstTimer.beach = true;
    if (['food', 'dining'].includes(cat)) firstTimer.thai_food = true;
    if (cat === 'shopping' || /market/i.test(a.name)) firstTimer.market = true;
    if (entity && deriveBucketListValue(entity) >= 80) firstTimer.iconic = true;
  }

  // Avoid: since the planner may pick ONLY from selected_activities, enumerating
  // every excluded activity by name is redundant — keep the reason + a few
  // examples so the intent is clear without paying for the full list.
  const avoidMap = new Map();
  for (const e of rankedResult.excluded_options ?? []) {
    if (e.type === 'hotel') continue;
    if (!avoidMap.has(e.reason)) avoidMap.set(e.reason, []);
    avoidMap.get(e.reason).push(e.name);
  }
  const avoid = [...avoidMap].map(([why, names]) => {
    const shown = names.slice(0, 4).join(', ');
    return { what: names.length > 4 ? `${shown} (+${names.length - 4} more)` : shown, why };
  });

  // Catalog gaps for the ROUTE cities: a style the city is known for but that the
  // catalog has no activity for (Round 20). Tells the planner a route city can't
  // fully deliver its own vibe from the provided list — so it should note the gap
  // (or fill it from general knowledge) rather than silently omitting it.
  const catalog_gaps = selected_route
    .map((name) => {
      const cityEntity = data.cityFile.entities.find((c) => c.name === name);
      if (!cityEntity) return null;
      const cov = cityCoverage(cityEntity, data.activities);
      return cov.missing_styles.length ? { city: name, missing_styles: cov.missing_styles } : null;
    })
    .filter(Boolean);

  const planning_rules = [
    'The route is AUTHORITATIVE — schedule within these cities; never re-rank, add, or drop a city.',
    ...(day_allocation ? ['day_allocation is AUTHORITATIVE — give each city exactly its allocated number of days; do not change the split.'] : []),
    'Schedule ONLY activities listed in selected_activities — never invent or substitute one.',
    'brief.majority drives the trip style; brief.constraints only restrict; special_moments_for get 1-2 dedicated moments each.',
    'Max 2 activities of the same style across the whole trip — vary temple / market / beach / food / cruise.',
    'Cover every first_timer_essentials that is true; if one is false, say so (do not fabricate a place).',
    'Honor avoid, safety_priority, mobility and children ages; cluster by city; minimize transfers; fit the duration exactly.',
    ...(catalog_gaps.length ? ['catalog_gaps: these route cities lack an activity for a style they are known for — note it or fill from general knowledge, do not pretend it is covered.'] : []),
  ];

  return {
    brief,
    selected_route,
    ...(day_allocation ? { day_allocation } : {}),
    selected_activities,
    planning_rules,
    first_timer_essentials: firstTimer,
    ...(catalog_gaps.length ? { catalog_gaps } : {}),
    ...(avoid.length ? { avoid } : {}),
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
    if (roster.ages?.length) known.push(`traveller age(s): ${roster.ages.join(', ')}${roster.young_adults ? ' (young-adult band)' : ''}`);
    if (roster.romantic) known.push('romantic-partner trip');
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
 * Writes up to three files per query — always, no flag needed:
 *   - <n>.context.json — the LEAN hand-off actually sent to an itinerary LLM:
 *       persona + party + a short candidate shortlist + hard "avoid" list. No
 *       scores (order = rank), no weights/gates, no empty fields. This is the
 *       token-cheap document; everything else is audit.
 *   - <n>.recipe.json  — audit: persona(s), brief, roster, constraints, composed
 *       weights/gates/tag_modifiers. The "why", for debugging — not for the LLM.
 *   - <n>.ranked.json  — audit: the full scored/sorted/shortlisted lists +
 *       excluded_options + shortlist_rationale. The "what", in full detail.
 * Only context.json is meant to leave the system; recipe/ranked exist so any
 * ranking decision can be traced back to a real attribute. (context is
 * single/blend mode only — compare mode is a persona-analysis view.)
 */
function writeAndSummarize(ext) {
  const { city, personaIds, compareMode } = ext;
  const recipe = recipeToJSON(ext);

  // ext.composed is an array (one composed persona per id) in compare mode,
  // and a single composed persona otherwise — see buildExtraction.
  const durationDays = parseDurationDays(ext.brief?.duration);
  const rankedResult = compareMode ? runCompare(city, personaIds) : runSingle(city, ext.composed, durationDays);
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

  let plannerPath = null;
  if (!compareMode) {
    const context = buildLLMContext(ext, rankedResult);
    writeJSON(`output/thailand/queries/${stamp}_${n}.context.json`, context);
    writeJSON('output/thailand/query_result.context.json', context);
    const planner = plannerContextBuilder(ext, rankedResult);
    plannerPath = writeJSON(`output/thailand/queries/${stamp}_${n}.planner.json`, planner);
    writeJSON('output/thailand/query_result.planner.json', planner);
  }

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

  if (plannerPath) console.log(`\n► Planner JSON (send THIS to the itinerary LLM — compressed): ${path.relative(ROOT, plannerPath)}`);
  console.log(`  Context JSON (audit: rich, scores + fit + breakdowns):     ${path.relative(ROOT, recipePath.replace('recipe', 'context'))}`);
  console.log(`  Recipe JSON  (audit: weights/gates/brief):                 ${path.relative(ROOT, recipePath)}`);
  console.log(`  Ranked JSON  (audit: full scored lists):                   ${path.relative(ROOT, rankedPath)}`);
  console.log(`  Latest copies: query_result.planner.json (+ .context/.recipe/.ranked audit copies)`);
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

Every query writes a lean .context.json (the token-cheap hand-off actually
sent to an itinerary LLM: persona + party + candidate shortlist + hard "avoid"
list, no scores) plus two audit files — .recipe.json (resolved persona(s),
parsed brief, composed weights/gates/tag modifiers) and .ranked.json (full
scored/sorted lists). A summary also prints to console.

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

/** "destination city not specified — scored across all cities" -> "which city" — short enough to list several on one line. */
function shortMissingLabel(entry) {
  if (/destination city/i.test(entry)) return 'which city';
  if (/group size/i.test(entry)) return 'group size';
  if (/travel dates/i.test(entry)) return 'travel dates';
  if (/^budget/i.test(entry)) return 'budget';
  if (/child age/i.test(entry)) return 'exact child ages';
  return entry.split(/[—:]/)[0].trim();
}

/**
 * A single free-text line is rarely a complete trip description — this is
 * the actual answer to "how do I check this through more thoroughly": after
 * every recipe preview, proactively name what's still missing (from
 * constraints.missing, already computed) instead of a generic "looks
 * right?". Plain-language hint, not a shorthand flag — see
 * parseShorthandLine's comment on why "budget:50000" doesn't reliably work,
 * but "budget 50000" typed as free text does (it reaches
 * parseFreeTextToBrief's own regex on the next pass).
 */
function missingHint(ext) {
  const missing = buildConstraintSummary(ext).missing;
  if (missing.length === 0) return '';
  const labels = [...new Set(missing.map(shortMissingLabel))].slice(0, 4);
  return `\nCould sharpen this — you could still tell me: ${labels.join(', ')}. Just type it as text and I'll fold it in.`;
}

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
      `${missingHint(ext)}\nLooks right? [Enter = continue] or correct it (e.g. "persona:friends_trip", "city:Bangkok", or free text to add) — "cancel" to drop, "quit" to exit:\n> `
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

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
  } else if (argv.length === 0) {
    await runInteractive();
  } else {
    handleQueryOnce(parseArgv(argv));
  }
}

// Only run the CLI when this file is executed directly (`node engine/cli.js`),
// not when it's imported (e.g. by the benchmark runner, which uses evaluateQuery).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
