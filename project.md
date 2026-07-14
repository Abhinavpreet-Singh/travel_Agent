# Travelomore Core Engine — Project Status

**What this is:** the deterministic travel intelligence layer behind
Travelomore's future AI agents (destination, hotel, flight, visa, budget,
itinerary, conflict-resolution, and 13 persona-specific agents). It is *not*
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

### Known limitations / next steps
1. **Activity count**: 80 of a ~100 target. Good coverage of every major
   city; adding ~20 more (especially Ayutthaya/Kanchanaburi/Koh Chang, which
   are thinner than Bangkok/Phuket) would round this out. Not blocking —
   the engine and data model are already proven at this volume.
2. **Hotels/flights are intentionally light** (14 / 8) — enough to prove the
   entity type and exercise the engine, not a real inventory. Real hotel/
   flight data belongs in a booking-integration layer (rates, availability),
   with this engine only ever holding the ranking-relevant signals.
3. **`eligibility.trigger` strings in `personas.json` are documentation, not
   executable** — `personaFromBrief.js` reimplements the same intent by hand
   in code. Worth a generic safe expression evaluator once a second brief
   source (not just Maya) exists; not before.
4. **Dietary/flight-preference extras aren't folded into weight nudges yet**
   — e.g. `extras: [{label: "dietary", value: "vegetarian"}]` is captured in
   `unmatched_extras` but doesn't yet bump `vegetarian_food_access` weight.
   Documented as a deliberate scope cut in `docs/ARCHITECTURE.md`, not a gap
   discovered by accident.
5. **No CI schema validation wired up yet** — the schemas in `schemas/` are
   real and ready for `ajv`, just not yet run automatically on every data
   change. Add `ajv` + a `npm run validate` script when this repo gets a CI
   pipeline.
6. **Persona catalog gaps surfaced by testing**: there is no dedicated
   persona for a solo male traveller, or for a couple/honeymoon trip with no
   other signals. Both currently fall back to `default` (with an explicit
   note explaining why), which is honest but not tailored — `default`
   doesn't weight romance/privacy for a honeymoon or solo-specific safety
   for a male traveller the way `female_solo` does for women. Worth a
   product decision: add `honeymoon` and/or a general `solo_traveller`
   persona, or confirm `default` is intentionally the right fallback for
   both.
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
