/**
 * Travelomore Core — benchmark dataset.
 *
 * Each case is a real free-text query plus the properties its output MUST hold.
 * This is the regression net: run `npm run benchmark` after any engine change to
 * confirm the persona layer still steers recommendations the way it should,
 * instead of eyeballing outputs by hand.
 *
 * Assertion keys (all optional; a case asserts only what it cares about):
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
    note: 'Family with young kids → safety/kid-activity weighting; Hua Hin & Koh Samui lead.',
    expect: {
      personasInclude: ['family_trip', 'child_friendly'],
      topCityOneOf: ['Hua Hin', 'Koh Samui'],
      citiesInShortlist: ['Hua Hin', 'Koh Samui'],
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
    note: 'honeymoon + pregnancy_friendly. Zika soft-gate caps the islands, so Chiang Mai wins (#1) over Hua Hin (#2) — documented in project.md Round 10. Islands with no hospital are hard-excluded.',
    expect: {
      personasInclude: ['honeymoon', 'pregnancy_friendly'],
      topCityOneOf: ['Chiang Mai', 'Hua Hin'],
      citiesInShortlist: ['Hua Hin'],
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
];
