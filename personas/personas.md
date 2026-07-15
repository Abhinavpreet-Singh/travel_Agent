# Traveller Personas

Human-readable rendering of `personas/personas.json` — the machine copy is the
source of truth; this file is for humans reviewing or extending it. All 22
personas below share one contract:

- **Eligibility** decides *whether a persona activates* for a given trip (fed
  by `engine/personaFromBrief.js` from Maya's extracted brief).
- **Hard gates** decide *whether an entity can be shown at all* under this
  persona. Failing one means "do not show," not "show but rank low."
- **Soft gates** decide *whether an entity's score gets capped* — still
  shown, but honestly flagged as marginal.
- **Weights** are relative, expressed over signal ids (never raw attributes),
  and the engine renormalizes them over whatever subset of signals actually
  applies to the entity type being scored.
- **Tag modifiers** are a small, bounded (±0.12) nudge applied after the
  weighted score, keyed off the entity's free-form `tags[]`.

A trip can activate more than one persona at once (e.g. `family_trip` +
`infant_friendly`, or `bachelorette_trip` + `wheelchair_friendly`). See
`engine/score.js::composePersonas` for how stacked personas are blended, and
`docs/ARCHITECTURE.md` for the composition math.

---

## 1. Default Traveller (`default`)

No declared constraints. Balanced ranking optimising for experience quality,
value, safety and ease of travel. This is the fallback when no other persona
trigger fires.

- **Eligibility:** `no_other_persona_detected`
- **Required attributes:** safety_general, tourist_infrastructure, value_for_money
- **Nice to have:** photogenic_quality, weather_comfort, direct_flight_access
- **Hard / soft gates:** none
- **Weights:** value_for_money 12 · safety_general 10 · tourist_infrastructure 10 · cost_efficiency 10 · weather_comfort 8 · direct_flight_access 8 · photogenic_quality 8 · flight_time_ease 6 · visa_ease 6 · crowd_pressure_low 4 · food_hygiene 4 · english_prevalence 4 · intracity_transport_quality 4 · healthcare_quality 3 · iconic_landmark_density 3

## 2. Friends Trip (`friends_trip`)

Group of 3-8 adults, no children, mixed budget sensitivity, high appetite for
shared activities, nightlife and photo-worthy moments. Per-head cost matters
more than luxury.

- **Eligibility:** `group_size>=3 AND children==0 AND relationship=='friends'`
- **Required attributes:** group_activity_density, group_cost_efficiency, nightlife_density
- **Nice to have:** beach_club_quality, late_night_food, photogenic_quality, alcohol_affordability
- **Soft gate:** `safety_general >= 0.35` (cap 0.6) — baseline safety not met for an unsupervised group trip
- **Weights:** group_activity_density 15 · nightlife_density 12 · group_cost_efficiency 12 · cost_efficiency 10 · party_scene_quality 8 · alcohol_affordability 6 · photogenic_quality 6 · value_for_money 6 · late_night_food 5 · beach_club_quality 5 · safety_general 5 · direct_flight_access 5 · intracity_transport_quality 5
- **Tag boosts:** nightlife, group_friendly (+0.03) · island, adventure (+0.02) — **penalties:** honeymoon_only (-0.03), senior_focused (-0.02)

## 3. Family Trip (`family_trip`)

Two or more adults travelling with children (3-17). Optimises for safety, kid
engagement, short transfers, dining ease and medical fallback. Nightlife is
actively de-prioritised.

- **Eligibility:** `children_count>=1 AND min_child_age>=3`
- **Required attributes:** safety_general, kid_activity_density, kids_dining_ease, healthcare_quality
- **Nice to have:** shallow_calm_beach, family_room_availability, arrival_transfer_ease, vegetarian_food_access
- **Hard gate:** `safety_general >= 0.4` — below the safety floor for travelling with children
- **Soft gate:** `hospital_proximity >= 0.25` (cap 0.7) — no hospital within a reasonable radius
- **Weights:** kid_activity_density 15 · safety_general 12 · kids_dining_ease 9 · healthcare_quality 8 · shallow_calm_beach 7 · hospital_proximity 6 · family_room_availability 6 · arrival_transfer_ease 6 · food_hygiene 6 · vegetarian_food_access 5 · walking_load_low 5 · value_for_money 5 · heat_stress_low 4 · crowd_pressure_low 3 · transport_comfort 3
- **Tag boosts:** family_friendly (+0.04) · theme_park (+0.03) · wildlife, calm_beach (+0.02) — **penalties:** nightlife, party (-0.04), adult_only (-0.06), extreme_adventure (-0.03)

## 4. Bachelor Trip (`bachelor_trip`)

All-male (or predominantly male) pre-wedding group. Nightlife, adult
entertainment, day-drinking, adventure and per-head cost dominate.
Cultural/heritage weight near zero.

- **Eligibility:** `occasion=='bachelor' OR (group_size>=4 AND gender_mix=='male' AND occasion=='pre_wedding')`
- **Required attributes:** nightlife_density, party_scene_quality, alcohol_availability, group_cost_efficiency
- **Nice to have:** adult_entertainment_access, beach_club_quality, late_night_food, group_activity_density
- **Hard gate:** `alcohol_availability >= 0.35` — alcohol restrictions make this unsuitable for a bachelor trip
- **Weights:** party_scene_quality 18 · nightlife_density 16 · alcohol_availability 10 · group_cost_efficiency 10 · adult_entertainment_access 8 · alcohol_affordability 7 · beach_club_quality 7 · group_activity_density 7 · late_night_food 5 · cost_efficiency 5 · night_safety 4 · direct_flight_access 3
- **Tag boosts:** nightlife, party (+0.05) · adult_only (+0.03) · adventure (+0.02) — **penalties:** dry_zone (-0.08), family_friendly (-0.03), spiritual (-0.03), heritage (-0.02)

## 5. Bachelorette Trip (`bachelorette_trip`)

All-female (or predominantly female) pre-wedding group. Balances nightlife and
photo-forward experiences with a materially higher safety floor, plus
wellness/spa and beach-club weighting.

- **Eligibility:** `occasion=='bachelorette' OR (group_size>=3 AND gender_mix=='female' AND occasion=='pre_wedding')`
- **Required attributes:** safety_female_solo, night_safety, nightlife_density, wellness_spa_quality
- **Nice to have:** photogenic_quality, beach_club_quality, group_cost_efficiency, street_harassment_low
- **Hard gate:** `safety_female_solo >= 0.5` — below the safety floor for an all-female group
- **Soft gate:** `night_safety >= 0.45` (cap 0.65) — night-time safety is marginal
- **Weights:** safety_female_solo 14 · nightlife_density 12 · photogenic_quality 11 · wellness_spa_quality 10 · night_safety 9 · beach_club_quality 8 · party_scene_quality 7 · group_cost_efficiency 7 · street_harassment_low 6 · alcohol_availability 5 · value_for_money 5 · scam_pressure_low 3 · late_night_food 3
- **Tag boosts:** nightlife, wellness (+0.04) · photogenic, island (+0.03/+0.02) — **penalties:** unsafe_night (-0.06), adult_only (-0.05), dry_zone (-0.05)

## 6. First International Trip (`first_international_trip`)

Traveller has never left the country. Optimises for low-friction entry,
English usability, mature tourist infrastructure, low scam pressure, direct
flights and food familiarity. Novelty is secondary to confidence.

- **Eligibility:** `prior_international_trips==0`
- **Required attributes:** visa_ease, english_prevalence, tourist_infrastructure, direct_flight_access
- **Nice to have:** indian_food_availability, payment_ease, tourist_police_presence, scam_pressure_low
- **Hard gate:** `visa_ease >= 0.35` — entry process is too heavy for a first international trip
- **Soft gate:** `tourist_infrastructure >= 0.5` (cap 0.7) — infrastructure too raw for a first-timer
- **Weights:** visa_ease 14 · tourist_infrastructure 13 · english_prevalence 11 · direct_flight_access 10 · scam_pressure_low 8 · flight_time_ease 7 · indian_food_availability 7 · safety_general 7 · payment_ease 6 · vegetarian_food_access 5 · value_for_money 5 · tourist_police_presence 4 · healthcare_quality 3
- **Tag boosts:** beginner_friendly (+0.04), package_ready (+0.03) — **penalties:** remote (-0.05), offbeat (-0.04), language_barrier (-0.03)

## 7. Content Creator (`content_creator`)

Traveller monetising or building an audience. Optimises for visual payload,
novelty (low saturation), drone legality, golden-hour logistics and upload
bandwidth. Comfort is traded away for shot quality.

- **Eligibility:** `self_declared_creator==true OR primary_goal=='content'`
- **Required attributes:** photogenic_quality, content_novelty, wifi_quality
- **Nice to have:** drone_permissiveness, golden_hour_access, iconic_landmark_density, coworking_density, crowd_pressure_low
- **Soft gate:** `wifi_quality >= 0.25` (cap 0.75) — bandwidth too low for video upload workflows
- **Weights:** photogenic_quality 18 · content_novelty 13 · iconic_landmark_density 10 · golden_hour_access 9 · drone_permissiveness 9 · wifi_quality 9 · crowd_pressure_low 8 · cost_efficiency 6 · coworking_density 5 · intracity_transport_quality 5 · safety_general 4 · weather_comfort 4
- **Tag boosts:** photogenic (+0.05), offbeat (+0.04), sunrise_spot/drone_friendly (+0.03) — **penalties:** no_photography (-0.08), overtouristed (-0.05)

## 8. Senior Citizen (`senior_citizen`)

Traveller aged 60+. Optimises for medical fallback, low physical load,
comfortable transport, rest stops, toilets, heat management and step-free
access. Novelty and nightlife are near-zero weight.

- **Eligibility:** `max_traveller_age >= 60`
- **Required attributes:** hospital_proximity, healthcare_quality, walking_load_low, transport_comfort, rest_stop_availability, public_toilet_availability
- **Nice to have:** elevator_availability, wheelchair_access, heat_stress_low, altitude_safety, seating_shade_availability
- **Hard gates:** `altitude_safety >= 0.35` (unsafe without medical clearance) · `hospital_proximity >= 0.2` (no reachable hospital in an emergency)
- **Soft gate:** `physical_exertion_low >= 0.4` (cap 0.55)
- **Weights:** hospital_proximity 13 · healthcare_quality 12 · walking_load_low 11 · transport_comfort 9 · rest_stop_availability 8 · wheelchair_access 8 · public_toilet_availability 7 · physical_exertion_low 7 · elevator_availability 6 · heat_stress_low 6 · terrain_ease 5 · emergency_response 4 · seating_shade_availability 4 · crowd_pressure_low 4 · altitude_safety 4 · arrival_transfer_ease 4 · food_hygiene 3 · pharmacy_access 3
- **Tag boosts:** senior_focused (+0.04), step_free/slow_travel (+0.03), cultural (+0.02) — **penalties:** high_altitude (-0.08), trekking/extreme_adventure (-0.06)

## 9. Child Friendly, 3-12 (`child_friendly`)

Applied at entity level when children aged 3-12 are present. Stricter than
`family_trip`: enforces age minimums on activities, weights engagement, safety
and short attention-span logistics.

- **Eligibility:** `any_child_age BETWEEN 3 AND 12`
- **Required attributes:** kid_activity_density, safety_general, food_hygiene, public_toilet_availability
- **Nice to have:** shallow_calm_beach, walking_load_low, kids_dining_ease, pediatric_care_access
- **Hard gates:** activity `min_age <= 6` (activity's minimum age must not exceed the child's) · `safety_general >= 0.4`
- **Weights:** kid_activity_density 18 · safety_general 11 · food_hygiene 8 · kids_dining_ease 8 · shallow_calm_beach 8 · walking_load_low 8 · public_toilet_availability 7 · pediatric_care_access 6 · heat_stress_low 6 · hospital_proximity 5 · crowd_pressure_low 5 · physical_exertion_low 5 · transport_comfort 5
- **Tag boosts:** family_friendly (+0.05), theme_park (+0.04), wildlife/interactive (+0.03) — **penalties:** adult_only (-0.1), nightlife (-0.06), extreme_adventure (-0.05)

## 10. Infant Friendly, 0-2 (`infant_friendly`)

Applied when an infant under 3 travels. Dominated by hygiene, medical
proximity, stroller access, nap logistics, heat exposure, transfer duration
and cot/changing availability. Most adventure activities are hard-gated out.

- **Eligibility:** `any_child_age < 3`
- **Required attributes:** infant_amenities, hospital_proximity, pediatric_care_access, stroller_friendliness, food_hygiene
- **Nice to have:** arrival_transfer_ease, noise_low, heat_stress_low, family_room_availability, tap_water_safety
- **Hard gates:** activity `infant_ok == true` · `hospital_proximity >= 0.3` · `altitude_safety >= 0.5`
- **Soft gate:** `arrival_transfer_ease >= 0.35` (cap 0.65)
- **Weights:** infant_amenities 16 · hospital_proximity 12 · pediatric_care_access 10 · stroller_friendliness 10 · arrival_transfer_ease 8 · food_hygiene 8 · heat_stress_low 7 · family_room_availability 6 · tap_water_safety 5 · noise_low 5 · walking_load_low 5 · vector_disease_risk_low 5 · crowd_pressure_low 3
- **Tag boosts:** family_friendly (+0.04), calm_beach/resort_stay (+0.03) — **penalties:** extreme_adventure/high_altitude (-0.1), long_transfer (-0.05), nightlife (-0.06)

## 11. Female Solo Traveller (`female_solo`)

Woman travelling alone. Optimises for night safety, harassment levels,
transport reliability, solo-dining and hostel/solo-social infrastructure, plus
scam pressure. Hard safety floor.

- **Eligibility:** `group_size==1 AND gender=='female'`
- **Required attributes:** safety_female_solo, night_safety, street_harassment_low, intracity_transport_quality
- **Nice to have:** english_prevalence, scam_pressure_low, tourist_police_presence, emergency_response, wifi_quality
- **Hard gates:** `safety_female_solo >= 0.5` · `night_safety >= 0.4`
- **Soft gate:** `emergency_response >= 0.4` (cap 0.7)
- **Weights:** safety_female_solo 18 · night_safety 13 · street_harassment_low 11 · intracity_transport_quality 9 · scam_pressure_low 8 · english_prevalence 7 · tourist_police_presence 6 · emergency_response 6 · tourist_infrastructure 6 · value_for_money 5 · wifi_quality 4 · healthcare_quality 4 · photogenic_quality 3
- **Tag boosts:** solo_friendly (+0.05), hostel_scene (+0.03), walkable (+0.02) — **penalties:** unsafe_night (-0.1), isolated (-0.05), adult_only (-0.04)

## 12. Pregnancy Friendly (`pregnancy_friendly`)

Pregnant traveller (typically 2nd-trimester travel window). Dominated by
obstetric access, Zika/vector risk, heat stress, exertion limits, food/water
hygiene, motion sickness and flight duration. Hard-gates high-risk activities
outright.

- **Eligibility:** `pregnant==true`, gestational week 12-28, no high-risk flag
- **Required attributes:** obstetric_care_access, zika_risk_low, food_hygiene, heat_stress_low, physical_exertion_low
- **Nice to have:** hospital_proximity, tap_water_safety, motion_sickness_low, walking_load_low, rest_stop_availability
- **Hard gates:** activity `pregnancy_safe in [safe, caution]` · `zika_risk_low >= 0.5` · `obstetric_care_access >= 0.4` · `altitude_safety >= 0.6`
- **Soft gate:** `flight_time_ease >= 0.4` (cap 0.7)
- **Weights:** obstetric_care_access 14 · zika_risk_low 12 · hospital_proximity 10 · food_hygiene 10 · heat_stress_low 9 · physical_exertion_low 9 · vector_disease_risk_low 7 · tap_water_safety 6 · walking_load_low 6 · motion_sickness_low 5 · rest_stop_availability 5 · flight_time_ease 5 · healthcare_quality 5 · public_toilet_availability 4 · noise_low 2
- **Tag boosts:** wellness (+0.04), resort_stay/slow_travel (+0.03) — **penalties:** extreme_adventure/diving (-0.12), high_altitude (-0.1), nightlife (-0.04)
- **Known Thailand-specific finding:** Thailand carries a country-wide `zika_risk_level: moderate` (`zika_risk_low` ≈ 0.35), which fails this persona's `zika_risk_low >= 0.5` hard gate almost everywhere in the country. This is the engine correctly surfacing a real medical caution, not a bug — see `docs/ARCHITECTURE.md`.

## 13. Wheelchair Friendly (`wheelchair_friendly`)

Traveller is a wheelchair user or has a mobility device. Hard-gates anything
without step-free viability. Weighted on step-free routing, accessible
transport and toilets, lift availability, and surface quality.

- **Eligibility:** `mobility_aid=='wheelchair' OR accessibility_need==true`
- **Required attributes:** wheelchair_access, step_free_access, accessible_transport, accessible_toilets, elevator_availability
- **Nice to have:** parking_availability, rest_stop_availability, hospital_proximity, terrain_ease, crowd_pressure_low
- **Hard gates:** `wheelchair_access >= 0.4` · `step_free_access >= 0.4`
- **Soft gate:** `accessible_toilets >= 0.35` (cap 0.65)
- **Weights:** wheelchair_access 20 · step_free_access 16 · accessible_transport 12 · accessible_toilets 11 · elevator_availability 9 · terrain_ease 7 · crowd_pressure_low 5 · hospital_proximity 5 · rest_stop_availability 5 · parking_availability 5 · transport_comfort 3 · walking_load_low 2
- **Tag boosts:** step_free (+0.06), accessible_certified (+0.05) — **penalties:** trekking (-0.12), stairs_heavy (-0.1), boat_only_access (-0.08), sand_access (-0.05)

## 14. Road Trip Friendly (`road_trip_friendly`)

Traveller wants to self-drive or use a private vehicle across a route.
Weighted on drivability, road quality, scenic value, fuel/rest cadence,
parking and road safety. Applies mostly to country/city/route entities.

- **Eligibility:** `travel_mode=='self_drive' OR trip_type=='road_trip'`
- **Required attributes:** self_drive_feasibility, road_quality, road_safety, fuel_stop_density
- **Nice to have:** scenic_drive_quality, parking_availability, rest_stop_availability, cost_efficiency
- **Hard gate:** `self_drive_feasibility >= 0.35`
- **Soft gate:** `road_safety >= 0.3` (cap 0.7) — recommend a driver rather than self-drive
- **Weights:** self_drive_feasibility 16 · road_quality 14 · scenic_drive_quality 13 · road_safety 12 · fuel_stop_density 9 · parking_availability 8 · rest_stop_availability 7 · cost_efficiency 7 · public_toilet_availability 5 · transport_comfort 5 · crowd_pressure_low 4
- **Tag boosts:** scenic_route (+0.05), road_trip (+0.04) — **penalties:** boat_only_access (-0.08), island_hopping (-0.06), traffic_hell (-0.05)

## 15. Couple Trip (`couple`)

Two adults in a relationship, no children, no specific milestone occasion
(that's honeymoon, below). Optimises for shared quality time, privacy, food
and photogenic moments over group activities or nightlife. The default for
an unadorned "me and my wife/husband/partner" trip once no other persona is
detected — added specifically to close that gap (previously fell to
`default` with just a note).

- **Eligibility:** `group_size==2 AND relationship=='couple' AND occasion!='honeymoon'`
- **Required attributes:** safety_general, photogenic_quality, crowd_pressure_low
- **Nice to have:** wellness_spa_quality, weather_comfort, noise_low, iconic_landmark_density
- **Hard gate:** `safety_general >= 0.35`
- **Soft gate:** `crowd_pressure_low >= 0.3` (cap 0.7) — too overtouristed for quiet time as a couple
- **Weights:** photogenic_quality 14 · crowd_pressure_low 12 · wellness_spa_quality 12 · weather_comfort 10 · value_for_money 9 · safety_general 8 · noise_low 8 · food_hygiene 6 · direct_flight_access 6 · iconic_landmark_density 6 · english_prevalence 5 · intracity_transport_quality 4
- **Tag boosts:** romantic (+0.04), photogenic (+0.03), wellness (+0.02), calm_beach (+0.02) — **penalties:** party (-0.03), backpacker (-0.02), nightlife (-0.02)

## 16. Honeymoon (`honeymoon`)

Newly married couple celebrating a milestone occasion. Distinct from
`couple` by materially higher weight on privacy/exclusivity and wellness,
and near-zero weight on cost efficiency — this is the one trip type where
value-for-money is deliberately not the point.

- **Eligibility:** `occasion=='honeymoon'`
- **Required attributes:** wellness_spa_quality, crowd_pressure_low, photogenic_quality
- **Nice to have:** noise_low, iconic_landmark_density, safety_general, weather_comfort
- **Hard gate:** `safety_general >= 0.4`
- **Soft gate:** `crowd_pressure_low >= 0.35` (cap 0.65) — privacy is the whole point of a honeymoon
- **Weights:** wellness_spa_quality 16 · photogenic_quality 14 · crowd_pressure_low 13 · noise_low 10 · safety_general 8 · weather_comfort 8 · iconic_landmark_density 7 · direct_flight_access 6 · food_hygiene 5 · value_for_money 5 · english_prevalence 4 · intracity_transport_quality 4
- **Tag boosts:** honeymoon (+0.05), romantic (+0.05), resort_stay (+0.03), wellness (+0.03), adult_only (+0.02), photogenic (+0.02) — **penalties:** backpacker (-0.06), party (-0.06), nightlife (-0.05)

## 17. Luxury Traveller (`luxury`)

Optimises purely for quality — premium hospitality, low crowds, high safety
and healthcare standards, mature tourist infrastructure — with deliberately
**no weight on cost efficiency at all** (not opposed to spending, just
indifferent to price). A modifier persona meant to stack with others
(`couple` + `luxury`, `family_trip` + `luxury`) as much as stand alone.

- **Eligibility:** `budget_tier=='luxury' OR explicit_luxury_request==true`
- **Required attributes:** wellness_spa_quality, crowd_pressure_low, tourist_infrastructure
- **Nice to have:** healthcare_quality, photogenic_quality, safety_general, iconic_landmark_density
- **Hard gate:** `safety_general >= 0.4`
- **Soft gate:** `tourist_infrastructure >= 0.5` (cap 0.7) — too raw to deliver a genuine luxury experience
- **Weights:** wellness_spa_quality 16 · photogenic_quality 14 · crowd_pressure_low 13 · healthcare_quality 10 · tourist_infrastructure 10 · safety_general 9 · noise_low 8 · food_hygiene 6 · iconic_landmark_density 6 · direct_flight_access 4 · intracity_transport_quality 4
- **Tag boosts:** resort_stay (+0.04), wellness (+0.03), romantic (+0.02), honeymoon (+0.02) — **penalties:** backpacker (-0.08), hostel_scene (-0.06), budget (-0.05)

## 18. Budget Traveller (`budget`)

Cost-conscious traveller optimising for low daily spend and genuine value,
not luxury. The mirror image of `luxury` — weights cost efficiency and
value heavily, gives no special weight to spa/wellness/exclusivity, and is
comfortable with hostel/backpacker-tier infrastructure as long as it's safe.

- **Eligibility:** `budget_tier=='budget' OR explicit_budget_request==true`
- **Required attributes:** cost_efficiency, value_for_money, safety_general
- **Nice to have:** tourist_infrastructure, english_prevalence, direct_flight_access
- **Hard gate:** `safety_general >= 0.35` — cheap is not worth unsafe
- **Soft gates:** none
- **Weights:** cost_efficiency 20 · value_for_money 16 · safety_general 10 · group_cost_efficiency 8 · tourist_infrastructure 8 · food_hygiene 7 · english_prevalence 6 · direct_flight_access 6 · intracity_transport_quality 6 · crowd_pressure_low 5 · photogenic_quality 4 · visa_ease 4
- **Tag boosts:** budget (+0.05), value (+0.04), backpacker (+0.04), hostel_scene (+0.03) — no penalties

## 19. Adventure Traveller (`adventure`)

Seeks physically engaging, outdoor, adrenaline-forward experiences —
trekking, diving, ziplining, self-drive scenic routes. Deliberately does
**not** weight low physical exertion (high exertion is often the draw, not
a deterrent) — instead weights the safety *standards* around adventure
activities (regulated water sports, road safety) and content novelty.

- **Eligibility:** `primary_goal=='adventure' OR self_declared_adventure==true`
- **Required attributes:** water_activity_safety, content_novelty, road_safety
- **Nice to have:** scenic_drive_quality, self_drive_feasibility, photogenic_quality, group_activity_density
- **Hard gates:** none
- **Soft gate:** `road_safety >= 0.3` (cap 0.7) — high road fatality rate makes self-drive/road-based adventure genuinely risky here
- **Weights:** water_activity_safety 12 · scenic_drive_quality 10 · content_novelty 10 · photogenic_quality 10 · self_drive_feasibility 8 · road_safety 8 · group_activity_density 8 · safety_general 8 · crowd_pressure_low 8 · value_for_money 6 · direct_flight_access 6 · weather_comfort 6
- **Tag boosts:** adventure (+0.06), extreme_adventure (+0.04), offbeat (+0.03), hiking (+0.03), diving (+0.03) — **penalties:** resort_stay (-0.02), senior_focused (-0.02)

## 20. Wellness Traveller (`wellness`)

Optimises for relaxation, spa, yoga and mindfulness — low crowds, quiet,
comfortable weather, clean food, minimal physical exertion. Distinct from
`luxury` by weighting comfort/calm over exclusivity/status, and distinct
from `couple`/`honeymoon` by not weighting romance-adjacent signals at all —
this persona applies equally to a solo wellness retreat.

- **Eligibility:** `primary_goal=='wellness' OR self_declared_wellness==true`
- **Required attributes:** wellness_spa_quality, crowd_pressure_low, noise_low
- **Nice to have:** weather_comfort, physical_exertion_low, vegetarian_food_access, air_quality
- **Hard gates:** none
- **Soft gate:** `crowd_pressure_low >= 0.3` (cap 0.65) — too crowded for a genuine retreat atmosphere
- **Weights:** wellness_spa_quality 22 · crowd_pressure_low 14 · noise_low 12 · weather_comfort 10 · physical_exertion_low 8 · food_hygiene 8 · vegetarian_food_access 6 · air_quality 6 · safety_general 6 · photogenic_quality 4 · tap_water_safety 4
- **Tag boosts:** wellness (+0.07), slow_travel (+0.05), quiet (+0.04), spiritual (+0.03) — **penalties:** nightlife (-0.06), party (-0.06), overtouristed (-0.05)

## 21. Foodie Traveller (`foodie`)

Trip organised around culinary experiences — street food, cooking classes,
food markets, fine dining. Weights food hygiene heavily (eating widely and
often is more exposure than an average trip) alongside variety/accessibility
signals (vegetarian/Indian food access, English for ordering).

- **Eligibility:** `primary_goal=='food' OR self_declared_foodie==true`
- **Required attributes:** food_hygiene, vegetarian_food_access, late_night_food
- **Nice to have:** indian_food_availability, value_for_money, group_activity_density, photogenic_quality
- **Hard gate:** `food_hygiene >= 0.3`
- **Soft gates:** none
- **Weights:** food_hygiene 16 · late_night_food 8 · vegetarian_food_access 8 · value_for_money 8 · photogenic_quality 8 · indian_food_availability 6 · group_activity_density 6 · crowd_pressure_low 6 · safety_general 6 · intracity_transport_quality 6 · english_prevalence 4 · tourist_infrastructure 4
- **Tag boosts:** food (+0.07), cultural (+0.02), walkable (+0.02) — no penalties

## 22. Digital Nomad (`digital_nomad`)

Remote worker travelling with a laptop, needs reliable connectivity and a
livable base for weeks at a time, not a sightseeing sprint. Hard-gates on
workable wifi — everything else is secondary if the connection can't
support a work day.

- **Eligibility:** `primary_goal=='remote_work' OR self_declared_digital_nomad==true`
- **Required attributes:** wifi_quality, coworking_density, cost_efficiency
- **Nice to have:** safety_general, english_prevalence, healthcare_quality, weather_comfort
- **Hard gate:** `wifi_quality >= 0.25` — connectivity too weak to support remote work
- **Soft gate:** `coworking_density >= 0.3` (cap 0.7) — workable but not built for long stays
- **Weights:** wifi_quality 20 · coworking_density 16 · cost_efficiency 10 · safety_general 8 · english_prevalence 8 · food_hygiene 6 · weather_comfort 6 · healthcare_quality 6 · intracity_transport_quality 6 · value_for_money 6 · crowd_pressure_low 4 · visa_ease 4
- **Tag boosts:** digital_nomad (+0.06), slow_travel (+0.03), solo_friendly (+0.02) — **penalties:** party (-0.02), nightlife (-0.02)

---

## Persona stacking

Real trips are rarely one persona. `composePersonas()` blends N personas by:

1. Normalising each persona's own weights to sum to 1.
2. Averaging those normalised distributions across the stack (so a persona in
   a 3-way stack keeps its proportionate voice rather than being diluted to
   1/3 of a un-normalised sum).
3. Taking the **union** of hard gates and soft gates (an entity must clear
   every gate from every active persona — the strictest cap wins on overlap).
4. Summing tag-modifier boosts/penalties across personas (still bounded to
   ±0.12 at the final score step).

See `docs/ARCHITECTURE.md#ranking-engine-design` for the full formula and a
worked example.
