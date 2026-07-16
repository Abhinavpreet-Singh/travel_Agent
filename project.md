# Travelomore Core Engine — Project Status

**What this is:** the deterministic travel intelligence layer behind
Travelomore's future AI agents (destination, hotel, flight, visa, budget,
itinerary, conflict-resolution, and 21 persona-specific agents). It is *not*
a chatbot and it does not call an LLM to rank anything — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and
[`ontology/ontology.md`](ontology/ontology.md) / [`personas/personas.md`](personas/personas.md)
for the data model.

Scope so far: **Thailand only**, used as the proving ground before this
pattern is repeated for Dubai, Bali, Vietnam, Ladakh, Spiti, Maldives, etc.
Nothing in the engine is Thailand-specific — a new country is just new JSON
files under `data/<country>/` (see ontology.md §3).

---

## Status

### Done
- [x] **Signal dictionary** (`ontology/signal_dictionary.json`) — 70 canonical,
      normalized, directional signals across 11 facets (safety, health,
      accessibility, comfort, connectivity, road_trip, cost, social, family,
      first_timer, content), each with its normalizer and both explanation
      templates.
- [x] **14 personas** (`personas/personas.json`) — default, friends, family,
      bachelor, bachelorette, first-international, content creator, senior
      citizen, child-friendly, infant-friendly, female solo, pregnancy,
      wheelchair, road-trip. Each with eligibility trigger, required/nice-to-have
      attributes, hard gates, soft gates, weights, tag modifiers.
- [x] **Thailand data**: 1 country, **17 cities** (Bangkok, Pattaya, Phuket,
      Krabi, Koh Phi Phi, Koh Samui, Koh Phangan, Koh Tao, Chiang Mai, Chiang
      Rai, Pai, Hua Hin, Ayutthaya, Kanchanaburi, Khao Lak, Koh Lanta, Koh
      Chang — effectively every prominent Thai destination city), **80
      activities**, **14 hotels**, **8 flight routes**, **1 visa record**.
- [x] **JSON Schemas** (draft 2020-12) for all 6 entity types + a shared
      `common.schema.json` (meta, provenance, persona_score, gate_failure).
- [x] **Scoring engine** (`engine/score.js`, `engine/normalize.js`) — gate
      evaluation (hard/soft), weighted scoring with per-entity-type weight
      renormalization, bounded tag modifiers, and `composePersonas()` for
      stacked personas (e.g. family + wheelchair).
- [x] **Explainability layer** (`engine/explain.js`) — template-rendered
      `{persona, score, reasons, cautions}`, always traceable to a specific
      signal + its raw value, never freehand text.
- [x] **Persona extraction bridge** (`engine/personaFromBrief.js`) — maps
      Maya's real `chat_sessions.brief` JSON shape (confirmed from the
      Developer Onboarding Guide §9.1) to persona ids via regex/keyword
      heuristics. Documented as a first pass, not an NLU system.
- [x] **Generator CLI** (`engine/generate.js`) — scores every entity against
      every persona, writes `output/thailand/*.scored.json` per type plus
      one consolidated `thailand.full.json`, and runs one full demo query
      end-to-end (brief → personas → ranked + explained candidates).
- [x] **Query/test CLI** (`engine/cli.js`, `npm run query`) — free-text or
      explicit `--city`/`--persona` queries, interactive mode, and a
      side-by-side persona-comparison view built specifically for "same
      city, different personas" testing (sorted by score spread so the
      most-differentiating entities surface first). See "How to test it"
      below.
- [x] **Verified sanity**: after fixing a scope-naming bug (below), rankings
      are directionally correct — `senior_citizen` puts Hua Hin (8.8/10) and
      Chiang Mai (7.6/10) on top and hard-gates out remote/boat-only islands
      with no reachable hospital (Koh Tao, Koh Lanta, Koh Chang, Pai — all
      excluded, not just scored low); `bachelor_trip` puts Pattaya (10/10),
      Koh Phangan (9.3), Koh Phi Phi (8.7) on top. A worked-by-hand example
      (Bangkok × senior_citizen = 6.7/10) is reproduced exactly in
      `docs/ARCHITECTURE.md`.

### Bugs found and fixed this session
1. `signal_dictionary.json`'s `scope` arrays use short names (`"country"`,
   `"city"`) but entity `type` fields use the fuller ontology names
   (`"destination_country"`, `"destination_city"`). Before the fix, every
   country/city entity resolved an **empty signal vector** (activities/hotels
   were unaffected — their `type` matches scope literally) — every persona
   scored every country/city near 0 regardless of persona. Fixed with a small
   alias map in `engine/normalize.js::buildSignalVector`. If you add a new
   entity type, add its alias there too, or its signals will silently resolve
   as "out of scope."
2. `personaFromBrief.js::parseGroupComposition` defaulted `adults = 1`
   whenever no explicit number was found in the text, and `derivePersonas`
   then added `female_solo` for *any* `group_size === 1` — regardless of
   stated gender. Caught via manual testing: **"solo traveller 20 male"**
   and **"married couple honeymoon"** (which has no number either, so also
   fell into the `group_size===1` bucket) both incorrectly scored against
   `female_solo`. Fixed: headcount is now `null` (not 0, not 1) unless there
   is real evidence (an explicit number, "solo"/"alone", or
   "couple"/"honeymoon"/"my wife" → 2), and `female_solo` only activates on
   solo **+** an explicit female signal. A solo male, a solo
   gender-unspecified traveller, and a couple/honeymoon trip all now fall
   back to `default` with an explicit note explaining why (there is no
   dedicated male-solo or honeymoon/couple persona in the current 14-persona
   catalog — a real product question, not a bug to silently paper over).
3. `engine/cli.js`'s interactive mode initially mixed `rl.question()` calls
   in a way that could drop input lines when multiple lines arrived at once
   (only manifests with piped/scripted input, not real typing) — fixed with
   a single shared line-queue (`createLineReader`) so no input is ever lost
   regardless of timing.

### Round 12 (2026-07-15) — an architectural bug (roster info destroying itself), plus guided follow-up
**"a trip with my mom and dad for 7 days in thailand"** → `["default"]`.
Two compounding bugs, one of them a real design flaw worth documenting
carefully:

1. No signal at all recognized "mom and dad" as a relationship — no count,
   no relation flag. Added detection (`isParentsPhrase` in
   `parseGroupComposition`) treating "mom and dad"/"my parents"/etc. as
   implying 3 people (narrator + 2 parents), consistent with how "my wife"
   already implies 2.
2. **That fix alone made it worse.** `parseFreeTextToBrief` reconstructs
   `brief.groupComposition` as a canonical string ("3 adults") from whatever
   roster it parsed — and `derivePersonas` then **re-parses that string from
   scratch**, discarding the original text entirely. Once `isParentsPhrase`
   started successfully setting `adults=3`, the reconstructed string no
   longer contained "mom and dad" for the second parse to find — the
   relationship signal destroyed itself by being detected. The
   `group_size>=3` fallback then fired and mislabeled it `friends_trip`
   (family, not friends — a real mischaracterization, not just an
   under-detection). Root-caused and fixed architecturally: `brief` now
   carries the original, non-reconstructed roster as a non-enumerable
   `_roster` property (invisible to `JSON.stringify`, so it never leaks into
   `recipe.json`/`ranked.json`), which `derivePersonas` prefers over re-parsing
   whenever present. A real Maya brief (no `_roster`) still re-parses
   `groupComposition` as before — that's the correct behavior there, since
   Maya's `groupComposition` *is* the authoritative source, not a lossy
   reconstruction of something richer. Verified: "mom and dad" (no age) now
   correctly stays `default` with an honest note ("no dedicated
   multi-generational persona yet, mention age for senior_citizen"); "elderly
   mom and dad" correctly resolves to `senior_citizen`.

**Second ask**: "how do I actually check this properly, one line isn't
enough — can it keep asking follow-up questions?" Built exactly that: the
interactive confirm loop now surfaces `constraints.missing` as a plain-
language hint after every recipe preview ("Could sharpen this — you could
still tell me: which city, travel dates, budget"), instead of a generic
"looks right?". Verified end-to-end: typed the mom-and-dad query, saw the
hint, replied `budget 60000 per person` as plain text, and it correctly
folded in on the next pass (confidence went `medium` → `high`, `budget`
persona picked up from the keyword). While building this, found and fixed
one more real gap: a user following a hint like "add budget" might
reasonably type `"budget:50000"` (colon syntax) — which used to parse as an
unrecognized flag and get **silently dropped** (nothing reads `flags.budget`,
and the free-text merge path is skipped whenever any shorthand parses at
all). `parseShorthandLine` now only treats input as shorthand if at least
one key is actually acted on (`city`/`persona`/`compare`/`stack`/`rank`);
otherwise it falls back to free text, which does reach
`parseFreeTextToBrief`'s own budget/date regexes.

### Round 11 (2026-07-15) — found the real bug behind "why isn't Bangkok on top," fixed it without hardcoding
User's own words: "lets refine... rate bangkok high idk how it has rated it,"
"whats the deal with hardcoded values of yours" — worth being direct about
this. I did **not** hardcode anything. What actually happened: checked the
contribution breakdown for a `couple`, 2-day query and found two personas
(`couple`, `honeymoon`) were missing `arrival_transfer_ease` and
`flight_time_ease` entirely from their weight tables — real signals,
already in the dictionary, already used by other personas, just never
added to these two. That's why Pai's 3.5-hour gateway transfer cost it
*nothing* in scoring. Fixed both personas' weight tables (small, justified
additions — not a rebalance for effect).

Then built the actual missing capability: **duration-aware city scoring**.
For trips ≤3 days, `applyDurationAdjustment()` (`engine/cli.js`) scales a
fixed, documented set of logistics signals (`direct_flight_access`,
`flight_time_ease`, `arrival_transfer_ease`, `intracity_transport_quality`)
up and exploration signals (`photogenic_quality`, `iconic_landmark_density`,
`content_novelty`, `golden_hour_access`) down, renormalizes, and uses that
adjusted weight vector for CITY ranking only (not activities/hotels within
an already-chosen city, where trip length doesn't change the tradeoff the
same way). The signal split is fixed and uniform — it doesn't know or care
which cities that favors, so it can't be quietly turned into a destination
preference table. The adjustment is fully transparent in the output
(`duration_adjustment: {applied, duration_days, note}`) printed to console
and included in `recipe`/`ranked.json`, not a silent transformation.

Verified against the exact reported query ("date with girlfriend, 2 days"):
Bangkok/Phuket/Koh Samui/Chiang Mai now cluster tightly at the top (7.0-7.3)
instead of Chiang Rai/Pai dominating; Pai dropped to 6.1 and Koh Phi Phi
(3.2-hour transfer) dropped to 4.7 — both correctly penalized for genuinely
bad logistics on a trip too short to absorb them. Every one of those numbers
still traces back to a cited attribute (`~0.4h transfer`), which is the
whole point — "Bangkok should rank high because it's obviously popular"
and "Bangkok ranks high because its logistics signals score well and this
trip is short enough for that to matter a lot" produce the same answer here,
but only one of them is auditable, extends correctly to a country this
system has never seen, and doesn't quietly break the moment "obvious common
sense" is wrong for a specific persona (a wellness solo retreat, for
instance, correctly should *not* over-weight transfer speed the way a
2-day couple trip does — and doesn't, since the adjustment only touches
short trips).

**On "refine city information from the web/reviews"**: a genuine, worthwhile
ask, but scoped honestly — verifying 17 cities × ~70 signals each against
real sources is real research work (many hours), not something to
half-do silently in the background. Holding off starting it speculatively;
tell me which cities or which specific claims matter most (e.g. "verify
Phuket's safety/hospital data" or "check Pai's actual transfer time") and
I'll do a properly-scoped pass with cited sources, rather than a shallow
pass across everything that looks thorough but isn't reliable.

### Round 21 (2026-07-15) — Day Allocation layer (nights-per-city, out of the LLM's hands)
The "unresolved decision layer": how many nights per city. `buildDayAllocation()`
now decides it deterministically. Every route city gets >= 1 day (rule 4:
special-moment cities are in-route, so guaranteed an overnight); the remaining
days split by ACTIVITY DENSITY (rule 2 — count of recommended activities per
city), with PACE skewing it (relaxed exponent 1.6 concentrates into the richer
cities → fewer changes, rule 3; active 0.7 flattens). Largest-remainder
distribution guarantees the total ALWAYS equals duration_days (rule 1).

Output `city_allocation = [{city, days}]` (in ranked + planner as `day_allocation`,
flagged AUTHORITATIVE in planning_rules). Examples: friends+pregnancy 7d relaxed →
Phuket 4 + Koh Samui 3; young_couple 7d active → Phuket 5 + Krabi 2; backpacker
14d → Bangkok 5 + Chiang Mai 4 + Pattaya 5. Null when duration unknown (falls to
needs_confirmation). Benchmarks `allocation_sums_to_duration` +
`allocation_matches_route` (+ every-city->=1-day) as universal invariants; 11/11
green. The planner now receives route + nights-per-city + activities — it
sequences days, it no longer decides structure.

### Round 20 (2026-07-15) — Catalog coverage analysis (surface DATA gaps, not scoring gaps)
Round 19 hit a data hole (a beach city routed but no calm-beach activity existed).
This round makes such holes visible. `engine/coverage.js`: for each city, compare
its style-bearing tags (beach/nightlife/heritage/cultural/wellness/food/nature/
island) against the activity CATEGORIES actually present, and emit the missing
styles — `{ city, city_tags, available_styles, missing_styles }`.

Real finding: 1/17 cities has a gap — **Chiang Mai is tagged `wellness` but has NO
wellness-category activity** (a genuine authoring hole; Chiang Mai is famous for
spa/wellness retreats). The rest are clean.

Runnable via `npm run coverage` (full report). Also wired into the planner:
`plannerContextBuilder` now emits `catalog_gaps` for the ROUTE cities plus a
planning rule — so a wellness trip routing through Chiang Mai tells the planner
"this city can't deliver wellness from the list; note it or fill from general
knowledge," instead of silently omitting the vibe. Fixed a latent bug found in
passing: `itinerary_route` was returned as undefined in single-city (pinned) mode,
which blanked planner.selected_route for `--city=` queries. 11/11 benchmark green.

### Round 19 (2026-07-15) — Activity Strategy layer + real route generation
Completes the Round-17 symmetry (deferred there): the majority-drives /
constraints-gate split now applies to ACTIVITIES too, and the engine generates an
actual duration-sized route.

1. **Activity Strategy** — activities are ranked by the DESTINATION persona
   (majority style + constraint gates), not the full constraint-blended persona.
   So a friends trip surfaces beach/social activities while pregnancy still gates
   unsafe ones and experience_fit demotes inappropriate ones. Verified:
   young_couple now yields beach activities (beach:true); the deferred Round-17
   "beach:false" is fixed for unconstrained beach personas.
2. **candidate_cities vs itinerary_route** — separated. `recommended_cities` is
   the candidate shortlist; new `itinerary_route` is the ACTUAL cities visited,
   sized to duration (1/<4d, 2/4-7d, 3/8d+). The route ANCHORS on the #1 candidate
   (else the combo distance-penalty dropped geographically-isolated Phuket for a
   friends trip), then fills via the best anchor-containing city combination.
3. **Special moments** — each special persona (honeymoon…) gets ONE dedicated
   in-route activity injected (`moment_for`) even if the majority ranking didn't
   surface it — a "Chao Phraya dinner cruise ★ moment_for honeymoon" on a friends
   trip. Must still pass constraints + the experience-fit floor.
4. **first_timer_essentials recomputed** from the post-strategy, route-scoped
   activity pool (it derives from recommended_activities, which is now the
   activity-strategy output).
5. Benchmark `beach_city_implies_beach_activity` on young_couple; the same-route
   invariant now checks planner.selected_route === itinerary_route. 11/11 green.

Activities now come from the ROUTE (not all candidates); planner `selected_route`
is the itinerary_route. Known data gap (not an engine bug): a PREGNANT beach trip
still shows beach:false because the dataset's Phuket/Samui beach activities are
all boat/party/water-sports (constraint-demoted) — there is no "calm beach day"
activity authored; the route does now visit the beach cities regardless.

### Round 18 (2026-07-15) — Planner context compression (< 1000 tokens, route authoritative)
`context.json` grew rich (scores, signal breakdowns, physical/experience fit,
bucket values) — great for audit, wasteful to send to the planner LLM. Added
`plannerContextBuilder()` producing the COMPRESSED hand-off actually sent to the
planner: `{ brief, selected_route, selected_activities, planning_rules,
first_timer_essentials, avoid }`. It strips ALL ranking internals (verified: no
score/breakdown/bucket/physical_fit/experience_fit/signals/*_0_10 anywhere) and
keeps only what a planner needs to SCHEDULE.

Compression choices: `selected_route` is a bare ordered city-name array (route is
AUTHORITATIVE — encoded as rule #1, no reasons needed); `selected_activities` is
grouped by city with name/style/hrs only; `avoid` caps names to 4 + "(+N more)"
since the planner may pick ONLY from selected_activities (rule #2), making a full
avoid enumeration redundant. Result: ~650-720 tokens per query, ALL under the
1000 target — an 85-93% reduction vs the full `ranked.json` engine output (47-57%
vs the already-lean context.json).

`planner.json` is now the "send this" doc; context/recipe/ranked demoted to audit
copies. Benchmark: added a UNIVERSAL invariant
`compressed_context_produces_same_route` (planner.selected_route must equal the
ranked route, in order) — guards every case, so compression can never silently
change the route. 11/11 green.

### Round 17 (2026-07-15) — Destination Strategy layer: majority drives, constraints only gate
The weakest remaining layer (per audit): city selection blended ALL personas into
one score, so a pregnancy CONSTRAINT out-weighted a friends MAJORITY and pulled a
5-friends trip inland to Chiang Mai — "5 friends + pregnant honeymoon → beach:false".
The engine had no concept of a city "underserving the majority persona."

Fix (`buildDestinationPersona` in cli.js): destinations are now selected by the
MAJORITY persona (+ style modifiers like luxury/budget) for the STYLE weights,
with CONSTRAINT personas (pregnancy/wheelchair/infant) contributing ONLY their
gates. Ordering is now "what's best for the majority, THEN can the constraint do
it safely?" — so friends+pregnancy routes to Phuket/Bangkok/Pattaya/Samui (beach +
social, all with hospitals) and rejects Chiang Rai/Hua Hin as "underserves
majority (friends_trip)". Special personas (honeymoon) no longer drive the
destination unless they ARE the majority; they get dedicated activity moments.

New output `destination_strategy = { majority_persona, constraint_personas,
special_personas, recommended_route[], rejected_routes[] }` (in ranked + context)
— the `rejected_routes` "underserves majority" concept is the piece the engine
lacked. Single-persona and style-only cases (senior, family, luxury_couple) are
UNCHANGED (majority == the persona). `pregnant_honeymoon` intentionally shifted:
honeymoon (majority) now favours romantic Koh Samui/Phuket over calm-plain Hua Hin,
pregnancy still gates the hospital-less islands — benchmark updated with that note,
plus a new `destination_strategy_majority_over_constraint` guard. 11/11 green.

KNOWN NEXT STEP (not done this round): ACTIVITY ranking still uses the full
constraint-blended persona, so the activity CANDIDATE pool for friends+pregnancy
is still calm/cultural (beach activities not surfaced even though beach cities are
now chosen) — the destination is fixed, the activity pool isn't yet. Applying the
same majority-drives / constraint-gates split to activity physical scoring
(experience_fit already applies the constraint appropriateness) is the clean
completion, deferred to keep this change reviewable.

### Round 16 (2026-07-15) — plan like a travel agent, not a score-sorter (planner inputs, not more weights)
A reviewer's key point: the engine's SCORING is strong, but the itinerary
generation behaved like a score-sorter (top city + top activities → build),
producing café/spa/repetitive days that miss iconic Thailand and under-serve the
majority group. The fix belongs in the PLANNER, not more scoring weights — so
this round adds only DERIVED planner INPUTS to the context (no new score blend,
no hand-authored tables) and rewrites the itinerary prompt.

Context additions (all derived):
- `trip_profile.persona_roles = {majority, constraints, special}` (Step 1) —
  "5 friends + pregnant honeymoon" → majority friends_trip, constraint
  pregnancy_friendly, special honeymoon. Majority drives style; constraints
  exclude; special get moments.
- `activity.bucket_list_value` 0-100 (Step 3) — derived from
  `iconic_landmark_index` (Grand Palace 98, Maya Bay 95) with a category prior
  fallback (cooking class 55, aquarium 15, café 20). NOT folded into score — a
  separate axis the planner balances so a first-timer trip isn't mall/café/spa.
- `activity.style` (the category) + `first_timer_essentials`
  {culture, beach, thai_food, market, iconic} coverage flags (Step 7) — the
  planner (and we) can see if the candidate pool would miss an essential.

Finding surfaced immediately: "5 friends + pregnant honeymoon" returns
`first_timer_essentials.beach=false, iconic=false` — the pregnancy constraint
pulled the whole candidate set inland (Chiang Mai), so 5 friends would get a
beachless, non-iconic trip. The instrumentation caught the exact "constraint
dominates majority" failure. City ranking left UNTOUCHED per the reviewer
(destination ranking audited as mostly-good; the planner + these flags handle
majority-balance for now).

Steps 2/4/5/6/8 (destination-fit reasoning, daily diversity, group fairness,
majority audit, explainability) are encoded in the rewritten planner prompt —
they are LLM-planner behaviours, not engine code (there is no in-repo LLM
planner). Benchmark stays 10/10.

### Round 15 (2026-07-15) — Experience-Fit layer (derived appropriateness, not a hand-authored score sheet)
The engine judged PHYSICAL suitability (safe/easy) but not EXPERIENTIAL fit (right
KIND of thing) — so a rooftop bar out-scored a temple for a 72-year-old. Added a
derived experience-fit layer (`engine/experienceFit.js`): every activity gets an
`experience_fit ∈ [0,1]` per traveller axis (family/honeymoon/friends/senior/
solo_female/pregnancy/luxury/backpacker), computed from its tags/category/
constraints/attributes via a rules table — NO per-activity authoring. A sparse
OVERRIDES list corrects only the cases the rules can't (Vertigo/Sky-bar is
`adult_only` but fine for a senior; the tag can't tell it from a bar crawl).

Combined with physical fit as `final = 0.6·physical + 0.4·experience_fit`.
ADDITIVE was chosen over MULTIPLICATIVE empirically: both cut contradictions
equally (4→2 at fit<0.5 across the persona set) but additive preserved the most
recommendation diversity (35 vs 34 vs 33 baseline) — the mission's exact
criterion. Each recommended activity now carries the full trace: `physical_fit`,
`experience_fit`, and the blended score.

Each recommended activity also carries `fit_reason` — the signed drivers of the
binding axis (e.g. Walking Street → `-party, -unsafe_night, -nightlife`; Wat Pho
→ `+slow_travel, +heritage, +wellness`; Sky-bar → `override`), so a score is
explainable without reading code.

Additive-vs-multiplicative, verified on one consistent metric (`fit<0.4`, summed
over 6 personas): both cut top-10 contradictions 2→0 and top-20 6→5 IDENTICALLY;
the entire-pool count (29) is unchanged by either because the layer RE-RANKS, it
does not delete (a bar crawl is still the #1 pick for friends). So additive was
chosen purely on diversity preservation, not contradiction reduction.

Result (senior trace): party/unsafe-night venues (Khao San bar crawl, Walking
Street, Bangla Road) drop to experience_fit 0 → final ~4 → bottom of the list;
Sky-bar rooftop stays mid (override, fit 0.75) — the exact rowdy-vs-refined
distinction the reviewer asked for. Locked with `minExperienceFit >= 0.4` guards
on the senior/family/pregnancy/solo-female benchmark cases (now 10 cases green).
Applied to activities only; city ranking unchanged. Follows Round 14's decision
to model `party`/`unsafe_night`, NOT the broad `adult_only`.

### Round 14 (2026-07-15) — P0 safety: age >= 65 must trigger senior (parser gap disabled a real gate)
An audit trace across six personas found a genuine safety bug: "luxury trip with
my retired 70 year old husband" parsed as `[luxury, couple]` — NOT
`senior_citizen`. The age (70) was captured in `roster.ages`, but the senior
detector's numeric clause required an accompanying relation word from a short
list (`adult|senior|parent|grandparent`) and "husband" wasn't in it. Net effect:
the `senior_citizen` hospital hard-gate never activated, so hospital-less islands
(Koh Phi Phi/Tao/Phangan…) stayed ELIGIBLE for a 70-year-old. The gate logic was
fine; the parser just never armed it.

Fix (`parseGroupComposition`): `ages.some(a => a >= 65)` now forces senior
regardless of relation, plus the relation whitelist gained husband/wife/spouse/
partner and `retired husband/wife/couple`. Verified: 70yo retiree, 68yo dad, and
"66 and 70" all now → senior with islands excluded; young couples/families do NOT
misfire. Locked with a benchmark case (`retiree_age_triggers_senior_safety`).

Also audited the pregnancy "Zika gate" (a reviewer flagged over-restriction):
it is NOT deleting the tropics — it's a mild SOFT cap (0.55), already softened
from a hard exclude on 2026-07-14 for exactly that reason. What actually removes
islands for pregnancy is `obstetric_care_access` (hard gate), which is medically
sound. The `zika_risk_level` data itself is `review_status: editorial_draft`
(hand-authored, not a CDC/WHO feed) — flagged for re-sourcing rather than
building more logic on top of it.

Deliberately did NOT hard-block `adult_only` for seniors/solo-female (an earlier
over-reach): a rooftop cocktail lounge and a rowdy party street are both
`adult_only` but opposite experiences. The right model is per-activity
per-persona APPROPRIATENESS vectors (planned), targeting `party`/`unsafe_night`,
not the broad `adult_only` tag. Families with young kids are already protected by
the `min_age` gate (the trace showed zero family conflicts).

### Round 13 (2026-07-15) — "best week ≠ best city": activity DIVERSITY, and the lean context v2
A reviewer ran the family query end-to-end into an itinerary and found the
engine's blind spot: it optimizes *best CITY* (safest calm beach) when a 7-day
trip needs *best WEEK* (varied, memory-dense experiences). Faithfully following
the ranking produced a "beach ×7" itinerary; a plan that IGNORED the ranking
(Bangkok+Phuket: safari, aquarium, elephants, waterpark) was the better holiday.
Root cause confirmed in data: for a family, Phuket has 7 strong activities across
**6 categories** (culture, wildlife, show, adventure, island, beach) vs Hua Hin's
3 across 3 — but the old `activity_strength` rewarded only COUNT (breadth), blind
to variety, and the ambient family score (safety/calm-beach) buried Phuket at #3.

Fix (engine objective, not the prompt — the mismatch was in the recipe):
1. **Diversity term** added to `cityActivityStrength`: `0.5·peak + 0.2·breadth +
   0.3·diversity`, where diversity = distinct activity *categories* among a
   city's strong options (saturating). A place with a beach, an aquarium,
   elephants and a show now beats one with six variations of the same beach day.
2. **`CITY_ACTIVITY_BLEND` 0.4 → 0.5** — for a multi-day trip, what you can DO all
   week weighs nearly as much as how nice the place is to sit in.
3. **`activity_variety` exposed** on each city in `ranked.json` and the context,
   so the itinerary LLM can optimize the week itself.

Deliberately took the honest MIDDLE, not a forced flip: at blend 0.6 Phuket would
top the family list outright, but that risks pushing safety-sensitive personas
(senior/pregnancy) toward busier cities. At 0.5 the family result is a truthful
tight cluster — Hua Hin 78 (variety 3), Koh Samui 78 (4), Phuket 76 (6) — where
Phuket is clearly competitive and flagged as most diverse, and the LLM/user picks
the vibe. Verified safety personas are undisturbed: senior still Hua Hin #1,
pregnant-honeymoon still Chiang Mai #1, islands still hard-gated. Benchmark stays
green; the family case now asserts Phuket must be shortlisted (regression guard).

Also this round: the query→LLM hand-off was reshaped twice based on real
findings. First to a token-lean `context.json` (no scores — order = rank) after
discovering a raw-prompt itinerary (A) beat a fat-JSON one (B) because B
straitjacketed the model to a small catalog. Then to a STRUCTURED context v2
after a reviewer noted prose like "rich lineup of 7" is not machine-comparable:
explicit 0-100 scores + a per-item **signal breakdown** (persona-adaptive: a
family reads kid/safety, a couple reads beach/romance) + a structured
`trip_profile` + grouped `avoid`. `recipe.json`/`ranked.json` demoted to audit;
only `context.json` is sent to the LLM. The itinerary prompt was updated to
"reason from the breakdown, not the number; prefer variety for multi-day trips."

### Round 12 (2026-07-15) — a repeatable benchmark suite (stop eyeballing outputs)
Manual spot-checking works for 10 queries, not 500. Added a real regression net
under `tests/`:
- `tests/cases.js` — a dataset of real free-text queries (senior_72, young_couple,
  friends_20s, family_with_kids, backpacker, luxury_couple, pregnant_honeymoon,
  couple+activity-blend), each with the properties its output must hold: derived
  personas, top-city membership, cities that must appear / be hard-excluded, and
  a universal activity-coherence invariant.
- `tests/benchmark.js` + `npm run benchmark [name-filter]` — drives the **real**
  pipeline (no reimplementation that could drift) and exits non-zero on any
  failure, so it drops into a pre-commit hook or CI.

To make this possible without the CLI running on import, `engine/cli.js` now
exports `evaluateQuery(query) -> { ext, recipe, ranked }` (the same pipeline
`writeAndSummarize` runs, minus console/files) and guards its CLI entry behind
an `import.meta.url === process.argv[1]` check.

Expectations encode current *correct* behavior as the baseline (so a future
change that moves a ranking fails loudly), with `topCityOneOf` used where the
engine defensibly diverges from the naive human guess (backpacker → Bangkok not
Chiang Mai; pregnant-honeymoon → Chiang Mai not Hua Hin, per Round 10's Zika
gate). When a case fails, the discipline is: decide whether it's a regression
(fix code) or an intended improvement (update the expectation *and* its note) —
never a silent drift. All 8 cases green at introduction.

### Round 11 (2026-07-15) — young-couple archetype, needs-based shortlist, city↔activity coherence, and dropping llm.json
A run of product-alignment work, all driven by real queries:

1. **`children of age 20+` no longer hallucinates a 6-year-old.** The bare
   word "children" fired an assume-age-6 fallback even when an explicit adult
   age was attached. Reworked `parseGroupComposition` age handling into a
   proper classify-by-adjacency step: an age <18 is a minor; an age ≥18 next
   to a kid word is a grown-up *offspring* (an extra adult, no `child_friendly`
   / age-gate); an age ≥18 *not* near a kid word is a traveller's own age
   ("55 year old couple" — recorded, not double-counted). Also captures a
   stated group total ("family trip of 5").

2. **`young_couple` persona added.** "with my girlfriend, we both are 20" was
   scoring against generic `couple`, which weights calm/photogenic/wellness and
   so ranked Chiang Mai/Chiang Rai top — mathematically fine, but not what a
   young couple pictures for Thailand. Captured traveller ages + a `young_adults`
   flag + a `romantic` flag; a young-adult duo now composes `young_couple`
   (beach/island/value-weighted, nightlife-tolerant). Flips the ranking to
   Phuket/Samui/Krabi/Phi Phi. Framed in the output as a **product prior**,
   overridable with `persona:couple`.

3. **Shortlist length is now adaptive, not a fixed top-N.** `runSingle` returns
   as few as genuinely fit: a quality band (within 1.5 pts of top, ≥6.5/10)
   ∩ feasibility (~3 activities/day × trip length; cities scale with duration)
   ∩ a hard ceiling. A 3-day trip gets ~9 activities, a fortnight ~31, a
   weak-match persona fewer. `shortlist_rationale` explains the size.

4. **Cities and activities are now coherent.** They used to be ranked in two
   independent country-wide passes, so a top activity could surface in a city
   that didn't make the shortlist (a Bangkok dinner cruise for a couple headed
   to Chiang Mai + Samui). Activities are now scoped to the recommended cities.

5. **A city's own activity lineup lifts its rank** (`CITY_ACTIVITY_BLEND = 0.4`):
   `city_final = 0.6·ambient + 0.4·activity_strength`, where strength = peak
   (top-5 avg) + breadth (how many ≥7, saturating). This is what the user
   explicitly asked for — an activity-rich hub (Bangkok for a couple) can earn
   a place even when the place itself scores mid on ambient qualities. Bangkok
   went #9 → #5 for the couple query; Chiang Mai keeps #1 (it has peak *and*
   breadth). Each city carries `city_score_0_10` + `activity_strength_0_10`.
   Note: this rewards big hubs generally (breadth ∝ city size) — make the blend
   per-persona if a small focused destination should ever win.

6. **Removed `llm.json` (reverses Round 8).** It was `recipe.json` +
   `ranked.json` merged — a redundant replica. `ranked.json` already carries
   `shortlist_rationale` and `eligible_totals`; `recipe.json` carries roster/
   constraints/confidence. Deleted `buildLLMJSON()` and both `query_result.llm.json`
   and per-query `<n>.llm.json` outputs. A consumer reads recipe (the "why")
   + ranked (the "what"). Hotels also dropped from the per-query output — a
   hotel is chosen after city and dates are fixed, so it's a later fetch step.

### Round 10 (2026-07-15) — city combinations, and holding the line on two asks
User asked directly: "why isn't Bangkok recommended — aren't we being too
strict?" for a honeymoon+pregnancy query. Checked the actual numbers rather
than assuming either "the engine is right" or "the user is right":

- **Koh Samui's raw (pre-cap) honeymoon+pregnancy score is 7.44** —
  genuinely strong — capped to 6.2 by the same Zika soft-gate recalibrated
  in Round 4. For a **non-pregnant** honeymoon query, Samui already wins
  outright (7.6 vs Chiang Mai's 7.2) — so "Chiang Mai beating the beach
  islands" is specific to the pregnancy-stacked case, not a flaw in
  `honeymoon`'s own weights. This is the persona doing exactly what it's
  supposed to: pregnancy risk doesn't get diluted just because a honeymoon
  is also stacked on top. Left it as-is, explained the reasoning rather than
  changing anything.
- **Declined a proposed `"honeymoon_affinity": {"Koh Samui": 0.95, ...}`
  hardcoded per-destination lookup table.** This would have been a magic
  number with no traceable signal behind it, undermining the one property
  that makes this whole engine worth having: every score explains back to a
  real attribute. If a destination scores lower than expected, the fix is
  finding the missing *signal*, not hand-typing an opinion that overrides
  the math.

**What was a genuine, buildable gap**: the engine only ever answered "best
single city," even for a 7-day trip — nobody stays in one city for a week.
Added `recommended_city_combinations` (`engine/cli.js`): scores pairs (or
triples for 8+ day trips) of the top eligible cities by average individual
score, minus a distance penalty computed via haversine distance from each
city's real coordinates (already in `cities.json`) — not a travel-time API,
an explicit editorial heuristic (documented as such: ~1 point cost per
300km of average inter-city distance, capped at -2). Verified the output is
geographically sane without any hardcoding: Pattaya+Bangkok (101km),
Phuket+Phi Phi (45km), Koh Phangan+Koh Tao (44km) all surfaced near the top
for a plain friends_trip query — all genuinely common real-world Thailand
combos, arrived at purely from coordinates + scores. Skipped entirely when
a city is pinned (`--city=`) or duration wasn't parseable — not enough
information to reason about combining anything.

### Round 9 (2026-07-15) — "5 my friends" fell to `default`, same brittle-regex pattern
`"college trip with 5 my friends for a week to thailand"` → `["default"]`
instead of `["friends_trip"]`. Root cause: `parseGroupComposition`'s
friend-counting regex, `/(\d+)\s*friends?\b/i`, required the number sitting
*immediately* next to "friends" — the possessive "my" between them broke it,
`adults` stayed `null`, and the `group_size >= 3` friends_trip fallback
never had a number to check. Same class of bug as the earlier "5, 9 and 10"
and "no extreme adventure sports" issues: a regex written for the tidy case
("5 friends") silently failing on an equally-natural real phrasing.

Fixed: `numFriendsMatch` now handles the possessive on either side of the
number or dropped entirely — "5 friends", "5 my friends", "5 of my
friends", "my 5 friends", "our 4 friends" all resolve correctly. Verified
against 8 cases including a guard against over-firing on a *singular*
"friend" mention with no count (`"trip to thailand with my friend"` stays
`default`, not `friends_trip`) — broadening a count regex is exactly the
kind of change that can introduce a new false positive if untested.

### Round 8 (2026-07-15) — the third file: recipe + ranked merged for LLM hand-off
Final ask in this series: a dedicated "LLM Planning JSON." Judgment call: this
is **not a new pipeline stage** — its proposed shape (`trip_summary` +
`traveler_profile` + `recommended_*` + `excluded_options` + counts) is
recipe.json's identifying fields (minus weights/gates — engine internals an
LLM can't act on) merged with ranked.json's recommendation fields, nothing
computed that wasn't already computed. So: kept `recipe.json`/`ranked.json`
as the source-of-truth pair (audit, debugging, full data), and added a third
file, `<n>.llm.json` (+ `query_result.llm.json` latest copy) — the actual
clean hand-off document, built by `buildLLMJSON()` in `cli.js`. Only
produced in single/blend mode; compare mode's side-by-side tables aren't
itinerary material.

Also added `weather_dependency` (high/low) per activity, same heuristic
spirit as `best_time` — derived from category/tags, no new data authored.

**Explicitly declined, with reasoning:**
- **Cross-persona `suitable_for`/`not_suitable_for` per activity** — this
  already exists, just not per-query. `engine/generate.js`'s bulk output
  (`output/thailand/activities.scored.json`) computes every activity against
  all 22 personas. Duplicating a 22-persona suitability matrix into every
  single-persona query response would be ~22x redundant data for a question
  nobody scoped to ask; the bulk file is the right place for that view.
- **`area`/neighborhood clustering** ("Wat Pho + Grand Palace + Wat Arun are
  all Old Bangkok, schedule same day") — genuinely valuable, but not
  derivable from anything currently on an activity (no per-activity
  coordinates or neighborhood tag exists, only city-level data). Real
  authoring work across 122 entities, not a code change. Flagged as a
  legitimate next investment, not done speculatively.
- **`recovery_needed`** — too vague to derive defensibly from existing
  signals; would have been a guess dressed as data.

### Round 7 (2026-07-15) — recommended/excluded shape, confidence, best_time
Follow-up review liked the grandmother/friends results but proposed a
"Recommendation JSON V2" shape. As with Round 5, much of it was **already
built** (the recipe/ranked split, the full activity list, city/duration/
cost metadata) — that review was still reading stale output. What was
genuinely new:

1. **`ranked.json`'s `runSingle` output restructured**: `top_cities/
   top_activities/top_hotels` (one mixed list per type, `eligible` flag
   buried in each item) → `recommended_cities/activities/hotels` (eligible
   only, sorted) + one combined `excluded_options` array with a clean
   `{type, name, city, reason}` per entry. Matches the requested shape
   directly — a caller no longer has to filter on `eligible` themselves.
   Also fixed a real gap this surfaced: excluded entries beyond the
   `explainTop` cutoff (i.e. most of a country-wide activity pool, since
   ineligible entries sort to the tail) previously had no `reason` at all —
   `gate_failures` is cheap (already computed by `rankEntities`) and is now
   always attached for ineligible entries regardless of position.
2. **`confidence`** — both trip-level (`recipe.json`: high/medium/low +
   why, based on persona_source and how many assumptions were needed) and
   per-entity (`ranked.json`: `data_confidence`, surfaced from
   `entity.meta.data_confidence`, which already existed but wasn't exposed
   in the ranked output).
3. **`best_time`** on activities (morning/evening/flexible) — derived from
   category + tags + `golden_hour_index_0_100` + heat, not hand-authored
   per entity (122 activities × a new field is real authoring work this
   didn't justify; a heuristic derivation is "good enough to sequence a
   day," which is the actual ask).

**Explicitly declined**: this review's persona list dropped
bachelor_trip/bachelorette_trip/content_creator/road_trip_friendly/
first_international_trip/female_solo — directly contradicting the "add the
full 8" decision from the previous round. Held the catalog at 22; flagged
the contradiction rather than silently reverting confirmed work. Also
declined adding redundant per-activity `senior_friendly`/
`wheelchair_accessible` boolean flags — that's what `eligible` (already
computed per-persona, per-entity) already represents; a hardcoded flag
would either duplicate it or drift out of sync with it.

### Round 6 (2026-07-15) — persona catalog grown 14 → 22, by explicit decision
Same review proposed reshaping the catalog around couple/honeymoon/luxury/
budget/adventure/wellness/foodie/digital_nomad. Rather than unilaterally
redesigning it, asked the user directly: add just `couple` (the one gap
already self-flagged), add the full 8, or hold at 14. **Chose: add the full
8, alongside the existing 14 (22 total) — none of bachelor_trip/
bachelorette_trip/content_creator/etc. were removed.**

Each new persona got the same rigor as the original 14 — real weight tables
built from the existing 70-signal dictionary (no new signals needed),
justified hard/soft gates, tag modifiers — not placeholder numbers. Notably:
`luxury` and `budget` deliberately give zero weight to each other's core
signal (luxury doesn't weight cost_efficiency at all; budget doesn't weight
wellness_spa_quality) rather than one being the photographic negative of the
other, since "doesn't care about X" and "actively wants the opposite of X"
are different things. `adventure` deliberately does NOT weight
`physical_exertion_low` — high exertion is the draw for this persona, not a
deterrent, unlike every other persona that weights it.

**`couple` also closes the previously-flagged gap**: an unadorned "trip with
my wife" now resolves to `couple` instead of silently falling to `default`.
`honeymoon` was *detected* before this round (via `parseFreeTextToBrief`'s
destinationType text) but had nowhere to go — now it's a real persona.

**Found and fixed a bug while wiring the new keyword lists in:**
`adventure`'s keyword pattern matched the literal substring "adventure"
with no regard for negation — generate.js's own demo brief contains `"no
extreme adventure sports"` and was incorrectly resolving to `[..., adventure,
...]` before this was caught. Fixed generally, not just for this one
persona: added `matchesPositively()` in `personaFromBrief.js`, which checks
a short window before every keyword match for negation words (no/not/avoid/
without/skip/never/hate/dislike) and applied it to *every* keyword-based
persona check in the file, not just adventure — the same failure mode was
latent in every other list (e.g. "no wheelchair needed" could have
incorrectly triggered `wheelchair_friendly`). Verified via a 21-case sweep
covering all 22 personas plus the negation case; `generate.js`'s demo brief
output confirmed clean afterward.

Also enriched the free-text→persona pipeline: travel-style keywords (luxury,
budget, adventure, wellness, foodie, digital_nomad) stack with any base
persona rather than requiring an exact match — "luxury trip with my wife"
correctly resolves to `["couple", "luxury"]`, not one or the other.

### Round 5 (2026-07-15) — output shape refined for LLM consumption, not re-architected
A second-opinion review proposed a bigger restructure (separate "internal" vs.
"decision" outputs, day-planning metadata, known/inferred/missing constraint
buckets). Most of the underlying proposal was **already built** in Round 2-4
(the recipe/ranked file split, the full un-truncated activity list) — that
review was looking at console output truncated for readability, not the
actual JSON files. What was a genuine, concrete gap:

1. **Grandparent detection was English-only.** This product's actual
   userbase is predominantly Indian outbound travellers — "nani"/"dadi"
   (maternal/paternal grandmother in Hindi) are at least as likely as
   "grandmother" to appear in a real query, and the old list silently missed
   all of them. Added nani/dadi/nana/dada, plus indirect phrasing ("elderly
   mother", "retired parents") that implies seniority without naming a
   grandparent relation at all.
2. **`recipe.json` now has an explicit `constraints: {known, inferred,
   missing}` block** instead of a flat notes/roster dump — built from data
   that already existed (roster, notes, unmatched_extras), just reorganized
   so a caller can see at a glance what's solid vs. assumed vs. absent
   (e.g. `"missing": ["travel dates not specified", "budget not specified"]`).
3. **`ranked.json` entities now carry day-planning metadata** (`city`,
   `category`, `duration_hours`, `cost_band`, `pace`) derived from data
   already on the entity — an itinerary agent no longer has to cross-reference
   IDs or re-derive "how strenuous is this" from a raw `exertion_level_1_5`.
   Also flattened `explanation.reasons/cautions` to top-level `why`/`caution`
   arrays — one less nesting level for a consumer to unwrap.

**Explicitly not done — persona catalog expansion.** The same review
proposed replacing/growing the 14-persona catalog toward ~15 built around
couple/honeymoon/luxury/budget/adventure/wellness/foodie/digital_nomad. This
is a real, substantial scope decision (each new persona needs the same
weight/gate/tag-modifier rigor as the existing 14 — not a data-entry task),
and it's not obvious the proposed list is strictly better (it drops
bachelor_trip/bachelorette_trip, which are clearly relevant and already
well-tested for this market). Flagged for the user to decide rather than
unilaterally redesigning the catalog off one external suggestion.

### Round 4 fixes (2026-07-15) — cross-checked against an independent LLM's critique
The user ran the same two test prompts through ChatGPT and asked me to reconcile
the two outputs. I verified each specific claim against actual data rather than
adopting them on authority — most held up, one I pushed back on with reasoning.

**Fixed — soft-gate cap destroyed differentiation (engine-level bug, not
persona-specific):** `Math.min(score, cap)` floors every entity that scores
ABOVE the cap to the *exact same number*. Verified this collapsed 8 genuinely
different-quality hotels (a Mandarin Oriental-class 5-star and a budget
business hotel included) to the identical 4.5 for `pregnancy_friendly` in a
Zika-flagged city — the underlying attributes were fine and differentiated,
the cap mechanism was erasing it. Fixed in `engine/score.js`: entities above
the cap now get `cap + (excess) * 0.35` instead of a flat floor — capped
entities stay clearly below anything that passed the gate outright, but
remain ordered relative to each other. This is a global engine change,
benefiting every persona's soft gates, not just pregnancy's.

**Recalibrated — Zika cap value, using real numbers.** Checked Bangkok's raw
(pre-cap) pregnancy_friendly score: 5.99/10, driven by genuinely elite
`obstetric_care_access` (0.93) and `hospital_proximity` (0.96). The old 0.45
cap punished it *below* smaller towns with objectively worse medical
infrastructure (Ayutthaya 5.4, Kanchanaburi 5.3) — backwards. Raised to 0.55:
Bangkok (5.7) now beats those towns, while staying below cities with *both*
lower Zika classification and better comfort profiles (Hua Hin 7.6, Chiang
Mai 7.5, Chiang Rai 6.5) — which I still consider correct, not a residual
bug. I explicitly declined the "let hospital access dominate Zika risk
entirely" framing floated during this review: a nearby hospital cannot
reverse Zika-related fetal harm the way it can treat a fall injury or manage
labor complications — the two aren't fungible, so pregnancy risk from Zika
should stay a real, meaningful cap even in a city with elite healthcare, not
be worn away by unrelated strengths.

**Fixed — two real data errors found via this review, not weight-tuning:**
1. "Championship golf round" had `typical_walking_km_per_day: 2` — unrealistic
   for a full 18-hole round (~6-8km on foot even with a cart) — which was
   silently inflating its low-exertion score for `senior_citizen`/
   `pregnancy_friendly`. Corrected to 7km, exertion bumped 2→3.
2. Cycling activities on uneven terrain ("Wiang Kum Kam ancient city bike
   tour", "Ayutthaya ruins bicycle circuit") were marked `pregnancy_safe:
   "caution"` — standard pregnancy guidance treats cycling as a real fall-risk
   activity independent of terrain or heat, so both are now `"unsafe"`
   (hard-excluded), consistent with how other fall-risk activities are
   already classified. This also fixes a symptom the review caught: Elephant
   Nature Park (a genuinely gentle, no-riding sanctuary) was ranking *below*
   these misclassified bike tours; with the bike tours correctly excluded,
   that's resolved without touching Elephant Nature Park at all.

**Investigated, found no bug, made no change — `friends_trip` nightlife
weighting.** The critique claimed "63%+ of the score favors nightlife," but
that miscounts `group_activity_density` (15) and `group_cost_efficiency`
(12) as nightlife-specific — they aren't; one is generic "things to do as a
group," the other is pure cost math. True nightlife-specific weight
(`nightlife_density` + `party_scene_quality` + `alcohol_affordability` +
`late_night_food` + `beach_club_quality`) is ~36/100, not 63. `friends_trip`'s
own persona description explicitly calls for "high appetite for shared
activities, nightlife and photo-worthy moments" — Pattaya scoring near the
top is the persona doing exactly what it was designed to do, not a
calibration defect. Separately checked the specific hotel claim ("Patong
Family Beach Resort scoring above social/hostel hotels") against real
numbers — it doesn't hold up; Haad Rin's backpacker/nightlife hotel already
edges it out (7.9 vs 7.8). Left `friends_trip` untouched. If nightlife
should be dialed back in favor of adventure/scenic signals, that's a real
product decision worth making deliberately — say so and I'll reweight it,
rather than me guessing at new taste from one critique.

### Round 3 fixes (2026-07-15) — structural bug in free-text persona detection
Found via a real query: **"trip with wife shes pregnant for a week in thailand"
resolved to `default`, not `pregnancy_friendly`.** Root cause was
architectural, not a one-off miss: `personaFromBrief.js` had two
independently-maintained keyword lists that had drifted out of sync —
`parseFreeTextToBrief`'s `TRIP_TYPE_LABELS` detected "pregnancy" correctly
and wrote it into `brief.destinationType`, but `derivePersonas` only ever
scanned `brief.extras[]`, which never received that signal. Same class of
bug silently affected `content_creator`, `road_trip_friendly`, and
`first_international_trip` too — none of them were reachable from free text
at all before this fix, only from explicit `--persona=` flags.

**Fix**: `derivePersonas` now scans one combined text blob
(`destinationType` + `groupComposition` + every extra's label/value)
instead of `extras[]` alone — a signal is visible regardless of which brief
field it landed in, and regardless of whether the brief came from
`parseFreeTextToBrief` or a real Maya conversation. Verified all 14 persona
detection paths pass a dedicated test sweep (see git history /
`personaFromBrief.js` for the cases) — this was a "systematically audit the
whole layer" fix, not a patch for the one case reported.

Two more real bugs surfaced by that same audit, both fixed:
- `FEMALE_SOLO_KEYWORDS` incorrectly included `"girls trip"` / `"women's
  trip"` — those describe a *group* of women, the opposite of solo
  (`female_solo`'s own eligibility rule is `group_size==1`). Removed; a
  group of women now correctly resolves to `friends_trip` only.
- `"family trip with 2 kids"` (no ages stated) resolved to `default` —
  `family_trip`/`child_friendly` only fired off parsed ages, and a bare kid
  count has none. Now assumes a representative mid-child-band age (6) when
  kids are mentioned with no age, flagged transparently via a note (`state
  exact ages for accurate gating` — an infant vs a 6-year-old hard-gates
  very differently).

Also broadened `isCouplePhrase` to not require the possessive "my" (`"trip
with wife"` now correctly implies 2 adults, not just `"my wife"`), and
bumped console display from 6 activities/5 hotels to 15/8 (labeled with
total count) — the underlying JSON always had the full list since Round 2,
this just makes it visible without opening the file.

### Round 2 fixes (2026-07-15) — accuracy pass driven by real testing
1. **`pregnancy_friendly`'s Zika gate was hard-excluding Bangkok and Phuket
   entirely** — every activity in both cities inherited the country/city
   `zika_risk_low` value and failed the gate, so a pregnant traveller got
   zero eligible activities in the two biggest cities regardless of their
   excellent obstetric care. Moved `zika_risk_low` from `hard_gates` to
   `soft_gates` (cap 0.45) in `personas/personas.json` — Bangkok/Phuket now
   appear, clearly flagged and capped (~4.5/10), instead of invisible.
   `obstetric_care_access`, `altitude_safety`, and the per-activity
   `pregnancy_safe` gate stayed hard — those are genuine non-negotiables,
   only the geographic Zika classification was the overcorrection.
2. **Grandparent detection bug**: `personaFromBrief.js` only recognized the
   literal word "grandparent" co-occurring with a 60-99 age digit —
   "grandmother going with me" matched neither, so `senior_citizen` never
   fired and the query silently fell back to `default`. Fixed: grandma/
   grandmother/grandpa/grandfather/granny now count as a direct senior
   signal on their own, no digit required.
3. **`engine/cli.js` was truncating the ranked output to 5-15 entities**
   before writing the JSON — a country-wide query only ever showed ~7
   activities spread across ~5 cities, even though 100+ existed. Rewrote
   `rankAll()` to always return the FULL scored list (every activity/city/
   hotel in scope, sorted), with rich template explanations attached only to
   a top slice (20 activities / all cities / all hotels) to keep payload
   size sane — the score and eligibility for everything else is still
   there, just without a full citation. This is the actual fix for "not
   enough info for the LLM to build a good itinerary."
4. **Activities: 80 → 122**, all 17 cities now at 5+ (was as low as 2), and
   the five cities most itineraries will actually center on — Bangkok,
   Phuket, Pattaya, Chiang Mai, Koh Samui — pushed to 10-15 each so there's
   real day-to-day variety to build from.
5. **Two output files per query, always** — `<n>.recipe.json` (persona,
   Maya-shaped brief, composed weights/gates — nothing ranked) and
   `<n>.ranked.json` (the full scored city/activity/hotel lists), both under
   `output/thailand/queries/`, plus `query_result.recipe.json` /
   `query_result.ranked.json` as always-latest copies. In compare mode
   (`--persona=a,b` with no `--stack`) the recipe now shows each persona's
   *own* weight vector separately — it used to show one blended vector even
   in compare mode, which was actively misleading (a senior_citizen +
   bachelor_trip blend represents neither, and didn't match what
   `ranked.json` actually scored).

### Known limitations / next steps
1. **Hotels/flights are intentionally light** (14 / 8) — enough to prove the
   entity type and exercise the engine, not a real inventory. Real hotel/
   flight data belongs in a booking-integration layer (rates, availability),
   with this engine only ever holding the ranking-relevant signals.
2. **`eligibility.trigger` strings in `personas.json` are documentation, not
   executable** — `personaFromBrief.js` reimplements the same intent by hand
   in code. Worth a generic safe expression evaluator once a second brief
   source (not just Maya) exists; not before.
3. **Dietary/flight-preference extras aren't folded into weight nudges yet**
   — e.g. `extras: [{label: "dietary", value: "vegetarian"}]` is captured in
   `unmatched_extras` but doesn't yet bump `vegetarian_food_access` weight.
   Documented as a deliberate scope cut in `docs/ARCHITECTURE.md`, not a gap
   discovered by accident.
4. **No CI schema validation wired up yet** — the schemas in `schemas/` are
   real and ready for `ajv`, just not yet run automatically on every data
   change. Add `ajv` + a `npm run validate` script when this repo gets a CI
   pipeline.
5. **Remaining persona catalog gap**: `couple`/`honeymoon` were added in
   Round 6, closing that gap. There is still no dedicated persona for a
   **solo male traveller** — falls back to `default` (with an explicit note
   explaining why), which is honest but doesn't weight solo-specific safety
   the way `female_solo` does for women. Worth a product decision: add a
   general `solo_traveller` persona, or confirm `default` is intentionally
   the right fallback here. A grandparent traveling with a younger companion
   (e.g. "grandmother + 20-year-old") correctly resolves to `senior_citizen`
   alone (not two personas) — the senior's constraints (hospital access, no
   altitude, low exertion) are the binding ones for the whole shared
   itinerary, the same way `family_trip` applies whenever a child is present
   regardless of the adults' ages.
6. **Only Thailand.** Next country should be picked specifically to stress a
   different part of the ontology — e.g. Ladakh/Spiti for `road_trip_friendly`
   and `altitude_safety` (barely exercised by Thailand's flat coastline/city
   data), or Maldives for a single-resort-island model very different from
   Thailand's city/activity spread.
7. **Not yet wired into the Node/Express backend** — see integration plan
   below.

### Data-quality flags carried over from the source files (not new)
- **Visa policy is unresolved in the source of truth itself**:
  `data/thailand/visa.json` documents a genuine conflict between the 19 May
  2026 Thai Cabinet decision (60-day exemption revoked) and the Royal Thai
  Embassy New Delhi's public guidance (exemption "effective until further
  announcement"). `requires_live_verification: true` is set precisely so no
  agent ever states a visa fact from this cache without a live re-check.
- **`pregnancy_friendly` hard-gates out nearly all of Thailand** on
  `zika_risk_low >= 0.5` (Thailand's country-level Zika risk is
  `"moderate"`). This is the engine working correctly, not a defect — see
  `docs/ARCHITECTURE.md` for why this is worth a product conversation rather
  than a quiet fix.

---

## How to test it — `npm run query`

`engine/cli.js` is the tool for actually trying the engine, in three ways:

```bash
# 1. Free text, like a real user typing into Maya — auto-detects city + persona(s),
#    then gives ONE blended recommendation (it's one trip):
node engine/cli.js "family trip to Phuket with 2 kids aged 5 and 9, need wheelchair access for grandma"

# 2. Explicit overrides — the fast way to A/B the SAME city/country against
#    DIFFERENT personas (defaults to a side-by-side compare, not a blend):
node engine/cli.js --city=HKT --persona=senior_citizen
node engine/cli.js --city=HKT --persona=bachelor_trip
node engine/cli.js --city=HKT --persona=senior_citizen,bachelor_trip      # both, side by side
node engine/cli.js --persona=senior_citizen,bachelor_trip                 # same compare, across all 17 cities

# 3. No arguments -> interactive prompt loop. Either free text or shorthand per line:
node engine/cli.js
> city:HKT persona:senior_citizen
> city:HKT persona:bachelorette_trip
> quit
```

In **interactive mode**, every query first prints an "Extraction" block — its
own labeled JSON showing the resolved city, derived persona(s), the parsed
traveller roster, and notes on anything ambiguous or not yet folded into
scoring — *before* anything is scored. You then get a chance to correct it
(type a shorthand override or extra free text) or just press Enter to accept
it as-is; this is the "ask if anything else to add" step. Only after that
does scoring run. One-shot mode (passing args directly) skips the confirm
step but still prints the same extraction block first, so you can always see
what the engine understood.

Every query — whether confirmed once or corrected several times — writes its
own timestamped file to `output/thailand/queries/` (nothing there is ever
overwritten) plus an always-latest convenience copy at
`output/thailand/query_result.json`. Console output is a compact summary
(top cities/activities/hotels, or a side-by-side score table when comparing
personas — sorted by *score spread*, so the most persona-differentiating
entities surface first); the JSON file has the full result with cited
explanations, ready to hand to an LLM.

Confirmed working examples (see `docs/ARCHITECTURE.md` for why these numbers
are correct, not just plausible-looking):
- `--city=HKT --persona=senior_citizen,bachelor_trip` — Phuket activities:
  Bangla Road scores 6.9 for `senior_citizen` vs 10.0 for `bachelor_trip`.
- `--persona=senior_citizen,bachelor_trip` (no city) — Koh Phangan is 9.3 for
  `bachelor_trip` but hard-gated to 0 (excluded) for `senior_citizen`
  (no reachable international-standard hospital); Hua Hin is the one city
  that scores respectably for both (8.8 / 4.7).
- Free text `"family trip to Phuket ... need wheelchair access for grandma"`
  correctly derives `[child_friendly, family_trip, wheelchair_friendly]`,
  blends them, and marks excluded activities with the exact gate reason
  (e.g. "Bangla Road, Patong — EXCLUDED — Activity has a minimum age above
  the child's age").

`--stack` forces explicit `--persona=a,b` into one blended persona instead of
comparing; `--compare` forces a free-text-derived persona set into the
side-by-side view instead of blending.

## How to bulk-generate it

```bash
npm run generate
```

No install step — the engine has zero npm dependencies. This:
1. Loads the signal dictionary, personas, and all Thailand data files.
2. Scores every entity (country, 17 cities, 80 activities, 14 hotels,
   8 flights, 1 visa record) against all 14 personas.
3. Writes `output/thailand/{country,cities,activities,hotels,flights,visa}.scored.json`
   and the consolidated `output/thailand/thailand.full.json`.
4. Prints a console sanity check (senior_citizen and bachelor_trip city
   rankings) so a regression is visible immediately, without opening JSON.
5. Runs one full demo query (a sample family+accessibility Thailand brief)
   through `personaFromBrief → composePersonas → rankEntities → explain` and
   writes `output/thailand/demo_query_result.json`.

**This is the file to hand to an LLM for itinerary generation:**
`output/thailand/thailand.full.json` — country, with nested cities, each
with nested activities and hotels, every entity carrying `persona_scores`
for all 14 personas plus a cited explanation. Everything the user asked for
("the raw form and proper file in which all the score and parameters are
written") lives here.

---

## Integration plan (Node/Express backend, React frontend)

Confirmed from the Developer Onboarding Guide: production stack is
Turborepo + npm workspaces, Node 20/Express backend, React/Vite MFEs, Maya
(OpenAI Responses API) already extracting a structured `chat_sessions.brief`
JSON per conversation.

**Recommendation: Node, not Python** — full rationale in
`docs/ARCHITECTURE.md#integration--deployment-recommendation`. Short version:
this engine is pure deterministic arithmetic with zero dependencies, the
target stack is already Node, and `backend/deploy.sh` already ships one
Docker image — a second Python service would add a deploy pipeline, a
Cloud Run service, and cross-language JSON marshalling for zero benefit.
Python only earns a place here if/when semantic embeddings or ML-based
demand forecasting get added — as an additional signal input, not a
replacement.

**Concrete next step:** move this repo's content into
`packages/core-engine` inside the main Travelomore monorepo (npm workspace),
depend on it from `backend`, and add `POST /api/core-engine/rank` accepting
`{ brief, entityType, cityId? }`, returning ranked + explained candidates —
reusing `derivePersonas` → `composePersonas` → `rankEntities` → `explain`
exactly as `engine/generate.js` demonstrates today.

---

## Folder map

See `docs/ARCHITECTURE.md#repo-layout` for the annotated version. Quick
reference:

```
ontology/    signal_dictionary.json + ontology.md
personas/    personas.json + personas.md
schemas/     JSON Schema (2020-12) per entity type + common.schema.json
data/thailand/   raw entity data (source of truth, hand-authored/editorial)
engine/      normalize.js, score.js, explain.js, personaFromBrief.js, loadData.js, generate.js, cli.js, index.js
output/thailand/  generated — never hand-edit, regenerate via npm run generate
docs/        ARCHITECTURE.md
```
