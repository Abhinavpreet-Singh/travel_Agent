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
