/**
 * Travelomore Core — Experience-Fit Layer
 *
 * The scoring engine (score.js) answers "is this PHYSICALLY suitable?" — safety,
 * exertion, hospital access. It does NOT answer "is this the RIGHT KIND of
 * experience for this traveller?" — which is why a rooftop bar scored 8.7 for a
 * 72-year-old (physically easy) and a bar crawl surfaced for a solo woman.
 *
 * This layer fills that gap with a DERIVED appropriateness vector per entity —
 * no hand-authored score sheet. Each activity gets an experience_fit ∈ [0,1] per
 * traveller axis, computed from its tags / category / constraints / attributes
 * via rules. A small OVERRIDES table corrects the handful of cases where the
 * rule default is wrong (Vertigo rooftop is `adult_only` but perfectly fine for
 * a senior — the tag can't tell it apart from Walking Street, so we override it).
 *
 * Deterministic and pure. Same entity → same vector.
 */

export const FIT_AXES = ['family', 'honeymoon', 'friends', 'senior', 'solo_female', 'pregnancy', 'luxury', 'backpacker'];

const BASELINE = 0.7; // most activities are broadly appropriate; rules push up/down from here
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// tag → per-axis delta. Down-deltas encode "wrong kind of experience for X",
// up-deltas "especially good for X". Magnitudes: ~0.5 strong, ~0.3 medium, ~0.15 mild.
const TAG_RULES = {
  party: { family: -0.6, senior: -0.45, pregnancy: -0.5, solo_female: -0.25, honeymoon: -0.35, friends: 0.25 },
  nightlife: { family: -0.4, senior: -0.2, pregnancy: -0.3, honeymoon: -0.1, friends: 0.2 },
  unsafe_night: { solo_female: -0.6, family: -0.6, senior: -0.35, pregnancy: -0.4, honeymoon: -0.2 },
  adult_only: { family: -0.7 }, // per audit: ONLY family — adult_only alone is fine for senior/solo/luxury (rooftop lounges)
  rowdy: { senior: -0.5, pregnancy: -0.5, family: -0.5, honeymoon: -0.3 },
  backpacker: { luxury: -0.5, senior: -0.2, honeymoon: -0.2 },
  hostel_scene: { luxury: -0.5, senior: -0.3, family: -0.2, honeymoon: -0.3 },
  extreme_adventure: { pregnancy: -0.7, senior: -0.5, family: -0.35 },
  adventure: { pregnancy: -0.3, senior: -0.2 },
  diving: { pregnancy: -0.6, senior: -0.3, family: -0.2 },
  snorkelling: { pregnancy: -0.15 },
  hiking: { pregnancy: -0.35, senior: -0.3 },
  stairs_heavy: { pregnancy: -0.3, senior: -0.4, family: -0.1 },
  climbing: { pregnancy: -0.6, senior: -0.45, family: -0.25 },
  high_altitude: { pregnancy: -0.5, senior: -0.35 },
  trekking: { pregnancy: -0.4, senior: -0.4 },
  remote: { senior: -0.3, pregnancy: -0.3, family: -0.2, backpacker: 0.2 },
  boat_only_access: { senior: -0.15, pregnancy: -0.1 },
  romantic: { honeymoon: 0.4, friends: -0.1 },
  slow_travel: { senior: 0.3, honeymoon: 0.2, pregnancy: 0.2, friends: -0.15 },
  quiet: { senior: 0.25, honeymoon: 0.25, pregnancy: 0.15, friends: -0.2 },
  calm_beach: { honeymoon: 0.2, senior: 0.2, family: 0.2, pregnancy: 0.15 },
  cultural: { senior: 0.25, family: 0.2 },
  heritage: { senior: 0.2, family: 0.15 },
  spiritual: { senior: 0.15 },
  wellness: { honeymoon: 0.25, senior: 0.2, pregnancy: 0.2 },
  budget: { backpacker: 0.35, luxury: -0.35 },
  family_friendly: { family: 0.35, senior: 0.1 },
  kids: { family: 0.35 },
  interactive: { family: 0.2 },
  beach_club: { family: -0.5, senior: -0.2, friends: 0.25, honeymoon: 0.1, pregnancy: -0.2 },
  senior_focused: { senior: 0.45 },
  step_free: { senior: 0.2, pregnancy: 0.15 },
  solo_friendly: { solo_female: 0.25 },
  offbeat: { backpacker: 0.25, senior: -0.15, family: -0.1 },
  overtouristed: { honeymoon: -0.15 },
  crowded: { honeymoon: -0.15, senior: -0.1, pregnancy: -0.1 },
  photogenic: { honeymoon: 0.1 },
  ethical: { family: 0.1 },
};

const CATEGORY_RULES = {
  nightlife: { family: -0.5, senior: -0.3, pregnancy: -0.4, friends: 0.2 },
  wellness: { honeymoon: 0.25, senior: 0.2, pregnancy: 0.15 },
  theme_park: { family: 0.3, friends: 0.1 },
  adventure: { pregnancy: -0.3, senior: -0.25 },
  water_sports: { pregnancy: -0.35, senior: -0.2 },
  diving: { pregnancy: -0.5, senior: -0.3 },
  beach_club: { family: -0.5, friends: 0.2 },
  heritage: { senior: 0.15, family: 0.1 },
  culture: { senior: 0.15, family: 0.1 },
  show: { family: 0.1, friends: 0.1 },
};

// Sparse overrides — ONLY where the derived default is wrong. A rooftop cocktail
// lounge and a party street are both tagged `adult_only`/`nightlife`, but they
// are opposite experiences; the tags can't distinguish them, so we correct the
// few that matter. Matched by case-insensitive name substring.
const OVERRIDES = [
  {
    match: 'sky-bar rooftop',
    fit: { family: 0.0, senior: 0.75, solo_female: 0.8, honeymoon: 0.85, luxury: 0.9, friends: 0.85, pregnancy: 0.45, backpacker: 0.3 },
  },
];

function applyDeltas(vec, deltas, contribs, source) {
  if (!deltas) return;
  for (const [axis, d] of Object.entries(deltas)) {
    vec[axis] = (vec[axis] ?? BASELINE) + d;
    if (contribs) contribs[axis].push({ source, delta: d });
  }
}

/**
 * Derive the full experience_fit vector for an entity from its own data, plus a
 * per-axis contribution log so a score is always explainable (the `fit_reason`).
 * @returns {{ vector: {[axis:string]: number}, contributions: {[axis:string]: {source,delta}[]} }}
 */
export function deriveExperienceFit(entity) {
  const vec = Object.fromEntries(FIT_AXES.map((a) => [a, BASELINE]));
  const contributions = Object.fromEntries(FIT_AXES.map((a) => [a, []]));

  for (const tag of entity.tags ?? []) applyDeltas(vec, TAG_RULES[tag], contributions, tag);
  applyDeltas(vec, CATEGORY_RULES[entity.category], contributions, `category:${entity.category}`);

  // constraints
  const c = entity.constraints ?? {};
  if (c.pregnancy_safe === 'unsafe') applyDeltas(vec, { pregnancy: -0.7 }, contributions, 'pregnancy_unsafe');
  else if (c.pregnancy_safe === 'caution') applyDeltas(vec, { pregnancy: -0.25 }, contributions, 'pregnancy_caution');
  if (c.infant_ok === false) applyDeltas(vec, { family: -0.15 }, contributions, 'no_infants');
  if (c.wheelchair_viable === false) applyDeltas(vec, { senior: -0.15, pregnancy: -0.1 }, contributions, 'not_wheelchair_viable');

  // attributes: exertion
  const ex = entity.attributes?.exertion_level_1_5;
  if (ex === 4) applyDeltas(vec, { senior: -0.25, pregnancy: -0.3, family: -0.15 }, contributions, 'high_exertion');
  else if (ex >= 5) applyDeltas(vec, { senior: -0.4, pregnancy: -0.45, family: -0.25 }, contributions, 'very_high_exertion');
  // attributes: cost → luxury/backpacker tilt
  const cost = entity.attributes?.avg_daily_cost_per_pax_inr;
  if (typeof cost === 'number') {
    if (cost >= 8000) applyDeltas(vec, { luxury: 0.3, backpacker: -0.3 }, contributions, 'premium_cost');
    else if (cost <= 2500) applyDeltas(vec, { backpacker: 0.25, luxury: -0.2 }, contributions, 'low_cost');
  }

  // override (replace, not add) — marks the axis so fit_reason reads "override".
  const name = (entity.name ?? '').toLowerCase();
  const ov = OVERRIDES.find((o) => name.includes(o.match));
  if (ov) for (const [axis, v] of Object.entries(ov.fit)) { vec[axis] = v; contributions[axis] = [{ source: `override:${ov.match}`, delta: null }]; }

  for (const a of FIT_AXES) vec[a] = Number(clamp01(vec[a]).toFixed(3));
  return { vector: vec, contributions };
}

// Which fit-axis each engine persona id cares about. Personas with no clear
// appropriateness axis (adventure, foodie, wheelchair, default, …) are omitted →
// no experience-fit adjustment applies to them (neutral 1.0).
export const PERSONA_TO_AXIS = {
  senior_citizen: 'senior',
  child_friendly: 'family',
  family_trip: 'family',
  infant_friendly: 'family',
  honeymoon: 'honeymoon',
  couple: 'honeymoon',
  friends_trip: 'friends',
  young_couple: 'friends',
  bachelor_trip: 'friends',
  bachelorette_trip: 'friends',
  female_solo: 'solo_female',
  pregnancy_friendly: 'pregnancy',
  luxury: 'luxury',
  budget: 'backpacker',
};

/**
 * Combined experience_fit for a (possibly composed) persona. Uses the MIN across
 * the traveller's mapped axes — appropriateness is a floor: an activity must be
 * right for EVERY hat the traveller wears (a pregnant honeymooner needs it fine
 * for both pregnancy AND honeymoon). Returns 1.0 (no effect) if no axis maps.
 */
export function experienceFitFor(entity, personaIds) {
  const axes = [...new Set(personaIds.map((id) => PERSONA_TO_AXIS[id]).filter(Boolean))];
  const { vector, contributions } = deriveExperienceFit(entity);
  if (!axes.length) return { fit: 1, axes: [], binding_axis: null, fit_reason: [], vector };

  // MIN across the traveller's axes — the binding (most-restrictive) one decides.
  let binding = axes[0];
  for (const a of axes) if (vector[a] < vector[binding]) binding = a;
  const fit = vector[binding];

  // fit_reason: the drivers of the BINDING axis, biggest-magnitude first, signed
  // (+ helps this traveller, - hurts). Answers "why did Walking Street score 4?"
  // without reading scoring code.
  const drivers = contributions[binding] ?? [];
  const fit_reason =
    drivers.length === 1 && drivers[0].delta === null
      ? [drivers[0].source] // override
      : [...drivers]
          .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
          .slice(0, 3)
          .map((c) => `${c.delta < 0 ? '-' : '+'}${c.source}`);

  return { fit, axes, binding_axis: binding, fit_reason, vector };
}

// "Why do people fly to Thailand for THIS?" — a 0-100 iconic/bucket-list value,
// DERIVED (no hand-authoring). Landmarks already carry an explicit
// iconic_landmark_index; trust it. Everything else falls back to a category
// prior (a cooking class / elephant sanctuary / island day is a real reason to
// visit; a mall / café / aquarium is not). This is the signal that stops a
// planner from building "aquarium → café → spa → mall" for a first-time visitor.
const BUCKET_CATEGORY_PRIOR = {
  heritage: 70, wildlife: 65, island_hopping: 60, beach: 58, food: 55, dining: 55, diving: 55, culture: 55,
  scenic: 55, nature: 50, road_trip: 45, stay_experience: 45, adventure: 45, heritage_wellness: 45, show: 40,
  nightlife: 35, beach_club: 30, sport: 25, wellness: 25, lifestyle: 20, shopping: 20, theme_park: 20, indoor_attraction: 15,
};
export function deriveBucketListValue(entity) {
  const attr = entity.attributes ?? {};
  const tags = entity.tags ?? [];
  let v = attr.iconic_landmark_index_0_100;
  if (v == null) {
    v = BUCKET_CATEGORY_PRIOR[entity.category] ?? 30;
    if (tags.includes('iconic')) v = Math.max(v, 60);
    if (tags.includes('offbeat')) v -= 5;
  }
  return Math.max(0, Math.min(100, Math.round(v)));
}

// Step 1: split the detected personas into the majority (drives itinerary STYLE),
// constraints (define EXCLUSIONS), and special (deserve dedicated MOMENTS).
const CONSTRAINT_PERSONAS = new Set(['pregnancy_friendly', 'wheelchair_friendly', 'infant_friendly']);
const SPECIAL_PERSONAS = new Set(['honeymoon', 'bachelor_trip', 'bachelorette_trip']);
// Which style-persona wins "majority" when several are present, highest first.
const MAJORITY_PRIORITY = [
  'friends_trip', 'family_trip', 'senior_citizen', 'young_couple', 'couple', 'luxury', 'budget', 'adventure',
  'wellness', 'foodie', 'digital_nomad', 'female_solo', 'content_creator', 'road_trip_friendly', 'first_international_trip', 'child_friendly', 'default',
];
export function classifyPersonaRoles(personaIds) {
  const constraints = personaIds.filter((p) => CONSTRAINT_PERSONAS.has(p));
  const special = personaIds.filter((p) => SPECIAL_PERSONAS.has(p));
  const style = personaIds.filter((p) => !CONSTRAINT_PERSONAS.has(p) && !SPECIAL_PERSONAS.has(p));
  const majority = MAJORITY_PRIORITY.find((p) => style.includes(p)) ?? style[0] ?? special[0] ?? personaIds[0] ?? 'default';
  return { majority, constraints, special };
}

/** The two blends the mission asks us to compare. physical, expfit ∈ [0,1]. */
export const BLENDS = {
  additive: (physical, expfit) => 0.6 * physical + 0.4 * expfit,
  multiplicative: (physical, expfit) => physical * expfit,
};
