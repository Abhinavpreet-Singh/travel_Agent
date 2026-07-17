/**
 * Travelomore Core — benchmark dataset.
 *
 * Each case is a real free-text query plus the properties its output MUST hold.
 * This is the regression net: run `npm run benchmark` after any engine change to
 * confirm the persona layer still steers recommendations the way it should,
 * instead of eyeballing outputs by hand.
 *
 * Assertion keys (all optional; a case asserts only what it cares about):
 *   country           string|null  ranked.country must equal this — null asserts "must NOT resolve one"
 *   countryVia        string    how it resolved: brief_country | brief_destination | city_flag | country_name | city | unresolved
 *   needsConfirmation string[]  each must appear in needs_confirmation in the planner, context AND ranked docs
 *   needsConfirmationFirst string  the FIRST question asked must be this one
 *   nothingPlanned    true      no route, no cities, no activities, and a null planner destination
 *   personas          string[]  derived personas must equal this set exactly (order-independent)
 *   personasInclude   string[]  each of these must be among the derived personas (stacked-persona cases)
 *   topCityOneOf      string[]  the #1 recommended city must be one of these
 *   citiesInShortlist string[]  each must appear in recommended_cities
 *   citiesNotInShortlist string[] none may appear in recommended_cities
 *   citiesExcluded    string[]  each must appear in excluded_options as a city (hard-gated out)
 *   minActivities     number    at least this many recommended activities
 *   maxActivities     number    at most this many
 * City names match by case-insensitive substring, so "Krabi" matches
 * "Krabi (Ao Nang / Railay)".
 *
 * Every case also gets one free invariant checked automatically by the runner:
 * ACTIVITY COHERENCE — every recommended activity must belong to a recommended
 * city (no orphan activity in a city we're not sending you to).
 */

export const cases = [
  {
    name: 'senior_72',
    query: 'trip to thailand with my 72 year old grandfather for a week',
    note: 'Senior persona → calm, hospital-accessible cities; remote islands hard-gated out on hospital reach.',
    expect: {
      personas: ['senior_citizen'],
      topCityOneOf: ['Hua Hin'],
      citiesInShortlist: ['Hua Hin', 'Bangkok'],
      citiesExcluded: ['Koh Phi Phi', 'Koh Tao', 'Koh Phangan', 'Koh Lanta'],
      minExperienceFit: 0.4, // no bar crawl / party street for a 72-year-old
    },
  },
  {
    name: 'young_couple_20s',
    query: 'thailand with my girlfriend, we both are 20, 7 days',
    note: 'Young-adult duo → young_couple archetype: beaches/islands, not the calm hill towns a generic couple gets.',
    expect: {
      personas: ['young_couple'],
      topCityOneOf: ['Phuket'],
      citiesInShortlist: ['Phuket', 'Koh Samui'],
      beachEssential: true, // beach persona + beach city in route ⇒ a beach activity must surface
    },
  },
  {
    name: 'friends_20s',
    query: 'friends trip to thailand, 5 of us in our 20s, 1 week',
    note: 'Group of friends → nightlife/beach-club weighting; Phuket/Bangkok/Pattaya lead.',
    expect: {
      personas: ['friends_trip'],
      topCityOneOf: ['Phuket'],
      citiesInShortlist: ['Phuket', 'Bangkok', 'Pattaya'],
    },
  },
  {
    name: 'family_with_kids',
    query: 'family trip to thailand with 2 kids aged 6 and 9, 1 week',
    note: 'Family with young kids. After the activity-diversity fix (Round 13) Hua Hin/Koh Samui/Phuket are a tight cluster, so all three must be shortlisted — Phuket must NOT be buried despite lower ambient safety, because its 6-category activity variety makes a richer week. Hua Hin still leads on calm/safety.',
    expect: {
      personasInclude: ['family_trip', 'child_friendly'],
      topCityOneOf: ['Hua Hin', 'Koh Samui'],
      citiesInShortlist: ['Hua Hin', 'Koh Samui', 'Phuket'],
      minExperienceFit: 0.4, // no adult_only / nightlife venue in a kids' itinerary
    },
  },
  {
    name: 'backpacker_solo',
    query: 'backpacking solo trip across thailand for 2 weeks',
    note: 'Budget archetype. Human guess was Chiang Mai #1; the engine ranks Bangkok #1 (value + activity breadth) with Chiang Mai #2 — accepted, hence topCityOneOf lists both.',
    expect: {
      personas: ['budget'],
      topCityOneOf: ['Bangkok', 'Chiang Mai'],
      citiesInShortlist: ['Chiang Mai', 'Bangkok'],
    },
  },
  {
    name: 'luxury_couple',
    query: 'luxury couple trip to thailand for a week',
    note: 'couple + luxury stacked. Human guess was Koh Samui; engine ranks Chiang Mai #1, Samui #2 — both accepted.',
    expect: {
      personasInclude: ['couple', 'luxury'],
      topCityOneOf: ['Chiang Mai', 'Koh Samui'],
      citiesInShortlist: ['Koh Samui', 'Chiang Mai'],
    },
  },
  {
    name: 'pregnant_honeymoon',
    query: 'pregnant honeymoon in thailand for 1 week',
    note: 'honeymoon + pregnancy. After the Destination Strategy layer (Round 17) the MAJORITY (honeymoon) drives destinations — romantic/photogenic Koh Samui & Phuket now rank over calm-but-plain Hua Hin — while the pregnancy CONSTRAINT only GATES (hospital-less islands hard-excluded). Intended majority-vs-constraint routing: a honeymoon gets romantic destinations that happen to be pregnancy-safe, not the single safest town.',
    expect: {
      personasInclude: ['honeymoon', 'pregnancy_friendly'],
      topCityOneOf: ['Chiang Mai', 'Koh Samui'],
      citiesInShortlist: ['Koh Samui'],
      citiesExcluded: ['Koh Phi Phi', 'Koh Tao', 'Koh Phangan'],
      minExperienceFit: 0.4, // no strenuous / party activity in a pregnancy itinerary
    },
  },
  {
    name: 'destination_strategy_majority_over_constraint',
    query: '5 friends and one pregnant honeymoon couple travelling thailand for a week',
    note: 'Destination Strategy (Round 17): the MAJORITY (friends_trip) drives destination selection even with a pregnancy constraint present — must route to beach/social cities (Phuket top), NOT be pulled inland to Chiang Rai/Hua Hin by the constraint (those are rejected as "underserves majority"). Pregnancy still GATES: hospital-less islands excluded.',
    expect: {
      personasInclude: ['friends_trip', 'pregnancy_friendly', 'honeymoon'],
      topCityOneOf: ['Phuket', 'Bangkok'],
      citiesInShortlist: ['Phuket'],
      citiesNotInShortlist: ['Chiang Rai'],
      citiesExcluded: ['Koh Phi Phi', 'Koh Tao'],
    },
  },
  {
    name: 'solo_female',
    query: 'solo female traveller to thailand for a week',
    note: 'Solo female → female_solo. Safety-forward destinations (Chiang Mai/Bangkok). Experience-fit floor keeps bar crawls / unsafe-night venues out of the recommendations (per audit: female_solo had them eligible but un-penalised before this layer).',
    expect: {
      personas: ['female_solo'],
      topCityOneOf: ['Chiang Mai', 'Bangkok'],
      minExperienceFit: 0.4,
    },
  },
  {
    name: 'retiree_age_triggers_senior_safety',
    query: 'luxury trip to thailand with my retired 70 year old husband for a week',
    note: 'P0 SAFETY GUARD: a stated traveller age >= 65 must trigger senior_citizen regardless of relation word ("husband", not "parent"), so the hospital hard-gate fires. Before the fix this parsed as luxury+couple only and hospital-less islands stayed eligible for a 70-year-old. Must exclude the no-hospital islands.',
    expect: {
      personasInclude: ['senior_citizen', 'luxury'],
      citiesExcluded: ['Koh Phi Phi', 'Koh Tao', 'Koh Phangan'],
    },
  },
  {
    name: 'couple_week_activity_blend',
    query: 'travelling with my girlfriend for 1 week to thailand',
    note: 'Regression guard for the city↔activity blend: Bangkok scores mid as a couple CITY but earns a shortlist spot on the strength of its couple activities.',
    expect: {
      personas: ['couple'],
      topCityOneOf: ['Chiang Mai'],
      citiesInShortlist: ['Bangkok'],
    },
  },

  // ---- country_catalog_isolation (Round 22) ---------------------------------
  // The multi-country guarantee, asserted from BOTH directions. These are the
  // cases that would catch a shared/leaky catalog loader, a cached `data`
  // singleton bleeding across queries, or a country fork in the planning code.
  {
    name: 'country_catalog_isolation_uae',
    query: 'trip to Dubai',
    note: 'A UAE query must be planned from the UAE catalog ALONE. No Thai city may appear anywhere in any of the four output documents.',
    expect: {
      country: 'uae',
      countryVia: 'city', // "Dubai" uniquely identifies the UAE — no country named
      noCatalogLeakage: ['Bangkok', 'Phuket', 'Chiang Mai', 'Pattaya'],
    },
  },
  {
    name: 'country_catalog_isolation_thailand',
    query: 'trip to Thailand',
    note: 'The mirror case: adding the UAE catalog must not leak a single Emirati entity into a Thailand trip.',
    expect: {
      country: 'thailand',
      countryVia: 'country_name',
      noCatalogLeakage: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Burj Khalifa', 'Ras Al Khaimah'],
    },
  },
  {
    name: 'country_catalog_isolation_cross_query',
    query: 'family trip to Sharjah with 2 kids aged 6 and 9',
    note: 'Catalogs are cached and reused across queries — this runs after Thailand cases in the same process, so a leak through the cache or a stale module-level catalog shows up here.',
    expect: {
      country: 'uae',
      personas: ['child_friendly', 'family_trip'],
      noCatalogLeakage: ['Bangkok', 'Phuket', 'Chiang Mai', 'Pattaya', 'Krabi', 'Koh '],
    },
  },

  // ---- UAE v1: the same engine, a different catalog -------------------------
  // These assert BEHAVIOUR, not just isolation: if the planning engine is truly
  // country-agnostic, personas must steer a UAE trip the same way they steer a
  // Thai one — driven purely by the catalog's data.
  {
    name: 'uae_friends_week',
    query: '5 friends travelling to Dubai for a week',
    note: 'The Round 22 success criterion. Must run the identical pipeline and produce all four documents. Desert safari is the group/party-weighted headline; the UAE essentials vocabulary (desert/souk) comes from the catalog, never from engine code.',
    expect: {
      country: 'uae',
      personas: ['friends_trip'],
      activitiesInShortlist: ['Desert Safari'],
      essentials: { desert: true, souk: true },
      minActivities: 5,
    },
  },
  {
    name: 'uae_senior_week',
    query: 'trip to UAE with my 72 year old grandfather for a week',
    note: 'Persona logic must transfer to a new catalog with no new code: a 72-year-old gets cool, step-free, hospital-near culture — and must NOT be sent dune-bashing (pregnancy/exertion/heat data on the safari, not a UAE special case).',
    expect: {
      country: 'uae',
      personas: ['senior_citizen'],
      citiesInShortlist: ['Dubai', 'Abu Dhabi'],
      minExperienceFit: 0.4,
      essentials: { desert: false }, // the desert safari is correctly not in a senior shortlist
    },
  },
  {
    name: 'uae_family_kids',
    query: 'family trip to abu dhabi with 2 kids aged 6 and 9, 1 week',
    note: 'Kid-activity density in the catalog — not a hardcoded rule — is what surfaces Ferrari World / Yas Island for a family.',
    expect: {
      country: 'uae',
      personas: ['child_friendly', 'family_trip'],
      activitiesInShortlist: ['Ferrari World'],
    },
  },
  // ---- unresolved_country_requires_confirmation (Round 23) ------------------
  // The engine used to answer a question nobody asked: with no country signal at
  // all it defaulted to Thailand and returned a confident Thai itinerary, with
  // nothing in the output admitting the destination had been GUESSED. Now it
  // asks. Each case asserts BOTH halves: the question is raised, and nothing was
  // planned in the meantime — a Thai plan plus a "which country?" note would
  // still be the same bug, because the plan is what a reader acts on.
  {
    name: 'unresolved_country_requires_confirmation',
    query: 'trip with friends',
    note: 'The canonical case. A real trip signal (friends) and no destination whatsoever — personas still derive (the persona library is country-independent), the country does not, and no catalog is loaded to fake it.',
    expect: {
      country: null,
      countryVia: 'unresolved',
      personas: ['friends_trip'],
      needsConfirmation: ['destination country'],
      needsConfirmationFirst: 'destination country', // the blocker leads; budget/dates are refinements
      nothingPlanned: true,
      // The no-silent-Thailand guarantee, asserted the same way Round 22 asserts
      // catalog isolation: scan every output document. Before this round, all of
      // these leaked — a Thai route, Thai activities, a "Thailand friends trip"
      // brief label — into a query that never named a country.
      noCatalogLeakage: ['Thailand', 'Bangkok', 'Phuket', 'Chiang Mai', 'Dubai', 'Abu Dhabi'],
    },
  },
  {
    name: 'unresolved_country_duration_only',
    query: '7 day vacation',
    note: 'A duration is not a destination. The trip is plannable in every respect EXCEPT the one that decides the catalog — which is exactly when the old default was most tempting and most wrong.',
    expect: {
      country: null,
      countryVia: 'unresolved',
      needsConfirmation: ['destination country'],
      nothingPlanned: true,
      noCatalogLeakage: ['Thailand', 'Bangkok', 'Dubai'],
    },
  },
  {
    name: 'unresolved_country_dates_only',
    query: 'traveling next month',
    note: 'Neither does a date. Guards the third example from the round spec.',
    expect: {
      country: null,
      countryVia: 'unresolved',
      needsConfirmation: ['destination country'],
      nothingPlanned: true,
      noCatalogLeakage: ['Thailand', 'Bangkok', 'Dubai'],
    },
  },
  {
    name: 'unresolved_country_no_city_question',
    query: 'honeymoon for 5 days',
    note: 'With no country, "which city" must NOT be asked — it is unanswerable until the country is known, and its wording ("scored across all cities") would be a lie about work that never happened. Ask one question, the one that unblocks the rest.',
    expect: {
      country: null,
      needsConfirmation: ['destination country'],
      needsConfirmationNotIncluding: ['which city'],
      nothingPlanned: true,
    },
  },

  // ---- country resolution priority (Round 23) --------------------------------
  // explicit brief.country > explicit brief.destination > city lookup > text inference.
  // Each case pits one tier against a WEAKER tier that names a different country,
  // so a regression in the order shows up as the wrong catalog, not a near-miss.
  {
    name: 'country_priority_brief_country_beats_text',
    query: { brief: { country: 'uae', groupComposition: '5 friends' }, text: 'friends trip, we stop in Bangkok on the way' },
    note: 'An explicit country field outranks anything inferred from prose. A Bangkok layover mentioned in the text must not reroute a stated UAE trip to Thailand.',
    expect: {
      country: 'uae',
      countryVia: 'brief_country',
      noCatalogLeakage: ['Chiang Mai', 'Phuket', 'Pattaya'],
    },
  },
  {
    name: 'country_priority_brief_destination_city',
    query: { brief: { destination: 'Dubai', groupComposition: '2 adults' }, text: 'a week away' },
    note: 'brief.destination names a city as readily as a country — it resolves the country AND pins the city, the same way --city= would.',
    expect: {
      country: 'uae',
      countryVia: 'brief_destination',
      resolvedCity: 'Dubai',
    },
  },
  {
    name: 'country_priority_city_flag_beats_text',
    query: { flags: { city: 'DXB' }, text: 'friends trip to thailand' },
    note: 'A pinned city is a stronger statement than a country named in prose — the flag wins, and the text is not allowed to half-apply a different catalog.',
    expect: {
      country: 'uae',
      countryVia: 'city_flag',
      resolvedCity: 'Dubai',
    },
  },

  {
    name: 'uae_sharjah_dry_emirate',
    query: 'bachelor trip to UAE for 5 days',
    note: 'Sharjah is legally dry (alcohol_access 0, nightlife ~0 in the catalog). A bachelor trip must therefore not anchor there — and that must fall out of the DATA through the universal scoring path, with no `if (city === Sharjah)` anywhere.',
    expect: {
      country: 'uae',
      personasInclude: ['bachelor_trip'],
      citiesNotInShortlist: ['Sharjah'],
    },
  },
];
