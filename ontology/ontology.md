# Travelomore Master Travel Ontology

This is the data model the entire core engine is built on. If you are adding a
new country, a new signal, or a new agent that reads this data, start here.

Everything downstream — persona weights, hard/soft gates, tag modifiers, the
scoring engine, the explainability layer — is expressed _only_ in terms of the
entities and signals defined in this document. There is no ranking logic
anywhere in this system that touches a raw attribute directly; it always goes
through a signal.

## 1. Entity types

Six entity types exist today. Each is a JSON file (or pair of files) under
`data/<country>/`, validated against the matching file in `schemas/`.

| Entity                | ID pattern                        | File(s)             | Parent                |
| --------------------- | --------------------------------- | ------------------- | --------------------- |
| `destination_country` | `country:<ISO2>`                  | `country.json`      | — (root)              |
| `destination_city`    | `city:<ISO2>:<CODE>`              | `cities.json`       | `destination_country` |
| `activity`            | `act:<ISO2>:<CITY>:<slug>`        | `activities_*.json` | `destination_city`    |
| `hotel`               | `hotel:<ISO2>:<CITY>:<slug>`      | `hotels.json`       | `destination_city`    |
| `flight`              | `flight:<ISO2>:<ORIGIN>-<DEST>`   | `flights.json`      | `destination_country` |
| `visa`                | `visa:<ISO2>:for:<PASSPORT_ISO2>` | `visa.json`         | `destination_country` |

Every entity carries the same skeleton:

```
{
  "id": "...", "type": "...", "name": "...", "parent_id": "...",
  "tags": [...],            // free-form vocabulary, read by tag_modifiers
  "attributes": {...},      // raw signal-dictionary attributes, native units
  "meta": {...},            // data_confidence, last_verified, review_status
  "provenance": [...],      // OPTIONAL but required on volatile entities (e.g. visa)
  "persona_scores": {...}   // ENGINE-WRITTEN ONLY — never hand-authored
}
```

`activity` additionally carries a `constraints` object (`min_age`, `infant_ok`,
`pregnancy_safe`, `wheelchair_viable`, ...) — these are read directly by persona
hard-gates scoped to `"activity"`, bypassing the signal-normalization path
entirely, because they're already booleans/enums, not measurements.

## 2. Signal dictionary — the attribute contract

`ontology/signal_dictionary.json` is the single most important file in the repo.
It defines ~70 **signals** — normalized, directional, [0,1] measures of "how
good is this for a traveller" — and the exact raw attribute + normalizer each
one is computed from.

**Contract:** every persona weight key must be a signal id. Every raw attribute
on an entity must map to exactly one signal's `attribute` field. Nothing scores
against a raw attribute directly.

### 2.1 Facets (how signals are grouped)

| Facet           | Signals (examples)                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safety`        | safety_general, safety_female_solo, night_safety, scam_pressure_low, street_harassment_low, water_activity_safety, road_safety, emergency_response                                                                                                                                  |
| `health`        | healthcare_quality, hospital_proximity, pharmacy_access, medevac_ease, vector_disease_risk_low, zika_risk_low, food_hygiene, tap_water_safety, air_quality, pediatric_care_access, obstetric_care_access                                                                            |
| `accessibility` | wheelchair_access, step_free_access, elevator_availability, accessible_transport, accessible_toilets, public_toilet_availability, walking_load_low, terrain_ease, physical_exertion_low, altitude_safety, rest_stop_availability, seating_shade_availability, stroller_friendliness |
| `comfort`       | heat_stress_low, weather_comfort, crowd_pressure_low, noise_low                                                                                                                                                                                                                     |
| `connectivity`  | direct_flight_access, flight_time_ease, arrival_transfer_ease, intracity_transport_quality, transport_comfort, motion_sickness_low                                                                                                                                                  |
| `road_trip`     | self_drive_feasibility, road_quality, scenic_drive_quality, fuel_stop_density, parking_availability                                                                                                                                                                                 |
| `cost`          | cost_efficiency, value_for_money, group_cost_efficiency, alcohol_affordability                                                                                                                                                                                                      |
| `social`        | nightlife_density, party_scene_quality, alcohol_availability, late_night_food, group_activity_density, adult_entertainment_access, wellness_spa_quality, beach_club_quality                                                                                                         |
| `family`        | kid_activity_density, infant_amenities, kids_dining_ease, shallow_calm_beach, family_room_availability                                                                                                                                                                              |
| `first_timer`   | english_prevalence, tourist_infrastructure, tourist_police_presence, payment_ease, visa_ease, vegetarian_food_access, indian_food_availability                                                                                                                                      |
| `content`       | photogenic_quality, iconic_landmark_density, content_novelty, drone_permissiveness, wifi_quality, coworking_density, golden_hour_access                                                                                                                                             |

### 2.2 Normalizer types

Every signal declares exactly one of these. All of them are pure functions — see
`engine/normalize.js::applyNormalizer`.

| Type                              | Formula                    | Use case                                                                             |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `index_100`                       | `v / 100`                  | Editorial 0-100 indices where higher = better                                        |
| `index_100_inverse`               | `1 - v/100`                | 0-100 indices where higher = worse (crowding, scams)                                 |
| `ratio`                           | `v` (already 0-1)          | Pre-normalized ratios (step_free_ratio)                                              |
| `linear_clamp`                    | `(v-min)/(max-min)`        | Physical measures where higher = better (wifi Mbps)                                  |
| `linear_inverse_clamp`            | `1-(v-min)/(max-min)`      | Physical measures where higher = worse (km to hospital, °C heat, road fatality rate) |
| `scale_1_5` / `scale_1_5_inverse` | `(v-1)/4` / inverse        | 5-point editorial scales (exertion level)                                            |
| `boolean`                         | `v ? 1 : 0`                | True/false facts                                                                     |
| `enum_map`                        | explicit literal→[0,1] map | Categorical (zika risk level, drone policy, tap water)                               |
| `count_saturating`                | `1 - e^(-v/k)`             | Counts with diminishing returns (weekly direct flights)                              |

### 2.3 Inheritance

```
country  →  city  →  activity | hotel
country  →  flight
country  →  visa
```

A signal marked `inheritable: true` resolves **entity → parent city → country**
(first non-null wins). Non-inheritable signals (e.g. `physical_exertion_low` —
an activity's own exertion level is never its city's) must be present on the
entity itself or the engine treats it as missing and substitutes a neutral prior
of `0.5` rather than silently scoring it as 0 (a real data gap must never look
like "this is terrible," which would be indistinguishable from bad data). See
`engine/normalize.js::resolveAttribute`.

**Naming note:** `signal.scope` uses the short vocabulary declared in
`signal_dictionary.json.scopes` (`"country"`, `"city"`, `"hotel"`, `"activity"`,
`"flight"`, `"visa"`), while `entity.type` uses the fuller descriptive names
(`"destination_country"`, `"destination_city"`). `engine/normalize.js`
reconciles the two with a small alias map — if you add a new entity type, add
its alias there too, or every signal will silently resolve as "out of scope" for
it.

## 3. Adding a new country

1. Create `data/<country>/{country,cities,activities,hotels,flights,visa}.json`
   following the schemas in `schemas/`.
2. Every `attributes` key must already exist in `signal_dictionary.json`, or add
   the signal there first (with both templates and a normalizer).
3. Run `npm run generate` — it will score the new country against every persona
   with zero code changes, because personas are expressed over signals, never
   over countries.

## 4. Adding a new signal

1. Add it to `ontology/signal_dictionary.json` with a unique `id`, `facet`,
   `scope`, `attribute`, `normalizer`, and both templates.
2. Reference it from any persona's `weights`, `required_attributes`, or
   `nice_to_have_attributes` in `personas/personas.json`.
3. Backfill the raw attribute on relevant entities (or leave it missing — the
   engine degrades gracefully to a neutral prior and reports reduced
   `signal_coverage`, it does not crash or silently zero out).
