# Travelomore Core Engine — Architecture

## What this is, in one paragraph

A deterministic travel intelligence layer: raw destination/city/activity/
hotel/flight/visa data, a canonical signal dictionary that normalizes every
raw attribute to a directional `[0,1]` scale, 14 persona definitions with
weights and gates expressed purely over those signals, and a scoring +
explainability engine that turns `(entity, persona)` into a ranked, cited
score. No LLM sits anywhere in this path — an LLM is the *consumer* of this
engine's output (for itinerary prose, conversation, summarization), never the
thing computing "is Hua Hin good for a senior citizen."

## Repo layout

```
ontology/
  signal_dictionary.json   canonical signals: id, facet, scope, attribute, normalizer, templates
  ontology.md              narrative doc — entity types, facets, inheritance
personas/
  personas.json            14 personas: eligibility, gates, weights, tag modifiers
  personas.md              narrative doc — same content, human-readable
schemas/
  common.schema.json        shared $defs (meta, provenance, persona_score, ...)
  {country,city,activity,hotel,flight,visa}.schema.json
data/countries/<country>/
  catalog.json              the country's MANIFEST: which files to load (in order), plus
                            planning_profile (first_timer_essentials, style_variety_examples)
  country.json, cities.json, activities*.json, hotels.json, [flights.json], [visa.json]
  # thailand/ and uae/ today. A country EXISTS because this folder exists —
  # registration is data, not code. See "Multi-country" below.
engine/
  normalize.js             raw attribute -> [0,1] signal, with inheritance
  score.js                 gates, weighted scoring, tag modifiers, persona composition
  explain.js               template-rendered {persona, score, reasons, cautions}
  personaFromBrief.js       Maya brief JSON -> persona id[] (heuristic bridge)
  countries.js              country registry + resolution + loadCountryCatalog()
  loadData.js               JSON read/write + the country-INDEPENDENT inputs (dictionary, personas)
  generate.js               CLI: scores everything, writes output/<country>/, runs a demo query
  index.js                  public API surface (`import ... from '@travelomore/core-engine'`)
output/<country>/
  *.scored.json             each source file, enriched with entity.persona_scores
  <country>.full.json       the single consolidated file — country > cities > {activities, hotels} + flights + visa
  demo_query_result.json    one full brief -> personas -> ranked+explained result
  queries/                  one timestamped recipe/ranked/context/planner set per query
docs/
  ARCHITECTURE.md           this file
project.md                  status tracker
```

Run it: `npm run generate` (plain Node, no build step, no external dependencies).

## Multi-country: Planning Engine + Catalog

The engine is **country-agnostic**. It is not "the Thailand engine with a UAE
mode" — it is one planning engine that is handed one catalog:

```
query ──▶ resolveCountry(text) ──▶ loadCountryCatalog(country) ──▶ [ the pipeline ]
          the ONLY step that            the catalog                 knows nothing
          looks across countries                                    about countries
```

**Country resolution** (`engine/countries.js`) happens once, before any catalog
is loaded, and it is the only code allowed to see more than one country:

1. The country is **named** — "trip to thailand", "a week in the UAE" (matched
   against `country.json`'s `name` + `aliases`).
2. A city **uniquely identifies** it — "friends trip to dubai" → `uae`. Only
   when unambiguous: a city name shared by two registered countries resolves to
   neither and falls through.
3. Otherwise the `DEFAULT_COUNTRY` fallback (an under-specified query like
   "family trip with 2 kids"). This is a fallback, not a privileged country —
   it takes the identical path as any other.

A named country beats a city mention, so "Dubai stopover on the way to Thailand"
is a Thailand trip. `recipe.json` records how it resolved via
`country_resolution: { via, matched }`.

The resolved country decides exactly **two** things: which catalog is loaded, and
which `output/<country>/` folder is written. Nothing else. Every downstream
document (`recipe/ranked/context/planner.json`) has an identical shape in every
country.

### The rule

> **Country-specific behaviour belongs ONLY in catalog data.**
> There is no `if (country === 'uae')` anywhere in the engine — not in
> destination strategy, activity strategy, day allocation, or planner
> generation. If you are reaching for one, the fact you are encoding belongs in
> that country's catalog instead.

This is enforced by the `country_catalog_isolation` benchmark cases, which scan
every output document for entities from another country's catalog.

Two things that *look* like engine knowledge but are catalog data:

| Fact | Wrong home | Right home |
|---|---|---|
| A first-timer in Thailand should eat Thai food; in the UAE, see the desert | `firstTimer.thai_food = true` in the planner | `catalog.json` → `planning_profile.first_timer_essentials` |
| "Vary temple / market / beach" vs "vary mosque / souk / desert" | a hardcoded planner rule | `planning_profile.style_variety_examples` |

The evaluator for both is generic; only the vocabulary is per-country.

### Adding a country

Add `data/countries/<slug>/` with a `catalog.json` manifest and the entity
files. That is the whole procedure — no engine change, no registry edit. The
manifest lists activity files **explicitly and in order**, because
concatenation order feeds score tie-breaking and must be pinned by the catalog
author rather than by filesystem sort order.

What makes cross-country comparison meaningful is that every catalog is authored
against the **same** `signal_dictionary.json` and the **same** editorial rubric —
a persona means the same thing in Bangkok and in Dubai. The personas and the
dictionary are loaded once (`loadShared()`) and shared by every catalog; only the
entity data differs.

Real country differences must therefore be expressed as *data*, and then they
work for free: Sharjah is legally dry, so its `alcohol_access_index_0_100` is `0`
and its `beer_500ml_price_inr` is **absent** (no legal price exists to score) —
which is why a bachelor trip never anchors there, with no rule anywhere saying so.

## Ranking engine design

### The signal vector

Every entity is turned into a **signal vector** before it is ever scored:
`{ signal_id: { value, raw, missing, inherited, source_entity_id } }`, built by
`buildSignalVector()` in `engine/normalize.js`. This is where inheritance
(entity → city → country), normalization (raw unit → `[0,1]`, always
"1 = better for the traveller"), and missing-data handling (neutral prior of
`0.5`, never a silent `0`) all happen. Nothing past this point ever touches a
raw attribute again — persona weights and gates are defined purely in terms
of signal ids.

### score(entity, persona)

```
1. signalVector = buildSignalVector(entity, ancestors, dictionary)

2. hard_gates:  for each gate, resolve actual value (a signal, or a raw
                entity.constraints/attributes value for attribute-scoped
                gates) and compare via its op (>=, <=, ==, in).
                ANY hard-gate failure => eligible=false, score=0.
                A gate whose `scope` doesn't include this entity's type is
                skipped entirely (not a failure — not applicable).

3. soft_gates:  same resolution, but a failure lowers `cap` (score ceiling)
                instead of excluding the entity. cap = min(cap, gate.cap)
                across all failed soft gates; default cap = 1.

4. weights:     filter persona.weights to signal ids present in the vector
                (i.e. actually in scope for this entity type), renormalize
                to sum to 1, then:
                  raw_score = Σ (normalized_weight_i × signal_value_i)

5. tag_modifiers: Σ boosts for entity.tags present in tag_modifiers.boost
                  − Σ penalties for entity.tags present in tag_modifiers.penalty
                  clamped to [-0.12, +0.12]

6. score_0_1 = clamp01(raw_score + tag_modifier)
   score_0_1 = min(score_0_1, cap)          // soft-gate ceiling
   score_0_1 = eligible ? score_0_1 : 0

7. score_0_10 = round(score_0_1 × 10, 1 decimal)
```

`signal_coverage` — the weight-weighted fraction of signals that resolved to
*real* data rather than the neutral 0.5 prior — travels alongside every score
so a downstream agent can distinguish "scored 8.5 on solid data" from "scored
8.5 mostly on priors, verify before committing to this in an itinerary."

### Worked example — Bangkok, `senior_citizen`

Bangkok's `senior_citizen` weights sum to 118 (raw units). A handful of the
18 weighted signals, using Bangkok's real attributes:

| Signal | Raw attribute | Raw value | Normalized | Weight |
|---|---|---|---|---|
| hospital_proximity | nearest_intl_hospital_km | 2 | 0.958 | 13 |
| healthcare_quality | intl_hospital_quality_index_0_100 | 95 | 0.950 | 12 |
| crowd_pressure_low | crowd_index_0_100 | 82 | 0.180 | 4 |
| heat_stress_low | peak_heat_index_c | 40°C | 0.278 | 6 |
| terrain_ease | terrain_type | flat | 1.000 | 5 |
| *(+ 13 more signals)* | | | | |

Σ(weight × value) across all 18 signals = **82.97**; ÷ 118 → raw score
**0.7032**. Bangkok's tags include `nightlife`, which matches
`senior_citizen.tag_modifiers.penalty.nightlife = 0.03` (no boost tags match)
→ modifier **−0.03**. No hard gate fails, no soft gate caps.

`score_0_1 = clamp01(0.7032 − 0.03) = 0.6732` → **score_0_10 = 6.7** — exactly
what `output/<country>/cities.scored.json` (e.g. output/thailand/) contains. This is fully
reproducible by hand from the source JSON; that reproducibility is the point.

### Persona stacking — composePersonas()

Real trips activate more than one persona (family + infant, bachelorette +
wheelchair, ...). `composePersonas(ids, personasById)`:

1. Normalizes each persona's own weights to sum to 1 (so personas with very
   different raw weight totals blend fairly).
2. Averages those distributions across the stack — a persona in a 3-way
   stack keeps a genuine 1/3 share of influence, not a share proportional to
   how many weight keys it happens to declare.
3. Takes the **union** of hard gates (an entity must clear every gate from
   every active persona) and soft gates (most restrictive cap wins on
   overlap, via a dedupe keyed on `[signal|attribute, op, value, scope]`).
4. Sums tag-modifier boosts/penalties across the stack (still bounded to
   ±0.12 at final application).

## Explainability layer

`engine/explain.js::buildExplanation()` turns a score result into:

```json
{
  "persona": "senior_citizen",
  "score": 8.8,
  "reasons": [
    "International-standard hospital within 3 km",
    "Excellent wheelchair access (78/100)",
    "Low walking requirement (~2 km/day)"
  ],
  "cautions": [
    "Caution: night-time safety is marginal"
  ]
}
```

- **Reasons** = the top-N (default 4) signals by weighted positive impact
  with `value >= 0.6` and real (non-missing) data, each rendered through that
  signal's own `positive_template` from `signal_dictionary.json`, filled with
  the entity's actual raw value. If nothing clears 0.6, it falls back to the
  best two available signals rather than returning an empty array.
- **Cautions** = soft-gate failure reasons, plus the worst signals
  (`value <= 0.35`) rendered through `negative_template`.
- If the entity is *ineligible* (a hard gate failed), `reasons` is empty and
  `cautions` explains exactly which gate excluded it and why — this is what
  a Conflict Resolution Agent or Summary Agent surfaces to the user instead
  of silently omitting an entity ("Koh Phi Phi was excluded for
  `senior_citizen`: nearest international-standard hospital is 45 km away").

No template is freehand-written per entity — every reason/caution traces back
to one line in `signal_dictionary.json`, so explanations never drift out of
sync with the score that produced them.

### A known, non-bug finding worth flagging to product

`pregnancy_friendly` hard-gates on `zika_risk_low >= 0.5`. Thailand's
country-level `zika_risk_level` is `"moderate"` (normalizes to ≈0.35),
which fails that gate almost everywhere in the country — Thailand is close to
uniformly excluded for the `pregnancy_friendly` persona. That is the engine
correctly encoding real medical guidance (CDC/WHO Zika advisories for
pregnant travellers), not a data or logic bug. It is exactly the kind of
non-obvious, high-stakes output the explainability layer exists to surface
rather than hide.

## Future agent usage flow

```
User message
    ↓
Maya (OpenAI Responses API) — existing production system
    ↓  extracts & stores chat_sessions.brief (destinationType, groupComposition, extras[], ...)
engine/personaFromBrief.js :: derivePersonas(brief)
    ↓  { personas: [...], roster, matched_extras, unmatched_extras }
engine/score.js :: composePersonas(personas, personasById)
    ↓  one blended persona (weights, gates, tag_modifiers)
engine/score.js :: rankEntities(candidateEntities, composedPersona, dictionary)
    ↓  sorted, eligible-first, per-entity score_0_1 / score_0_10
engine/explain.js :: buildExplanation(...)  — attached per candidate
    ↓
Top candidates (country → city → activity/hotel, flights, visa) as structured JSON
    ↓
LLM Explanation / Itinerary Layer — turns ranked+cited JSON into prose,
day-by-day plans, and conversational responses. The LLM never invents a
score or a reason; it narrates ones the engine already computed.
```

`output/<country>/demo_query_result.json` is a real, generated run of this
entire pipeline against a sample Thailand family/wheelchair brief — inspect
it as a concrete example of the contract every future agent below reads.

### Maya brief → persona mapping (what `personaFromBrief.js` actually does today)

| Brief signal | Detection | Effect |
|---|---|---|
| `groupComposition` child age 3-12 | regex over age/unit tokens | `child_friendly` + `family_trip` |
| `groupComposition` age < 3 or "infant"/"baby" | same | `infant_friendly` + `family_trip` |
| `groupComposition` senior-age adult | age 60-99 + "adult/senior/parent" keyword | `senior_citizen` |
| `groupComposition` size 1 | count | `female_solo` (provisional — refined by gender signal if present) |
| `extras[]` label/value contains "bachelorette"/"hen do" | keyword match | `bachelorette_trip` |
| `extras[]` contains "bachelor"/"stag" | keyword match | `bachelor_trip` |
| `extras[]` contains "wheelchair"/"accessib*" | keyword match | `wheelchair_friendly` |
| `extras[]` contains "pregnan*"/"expecting" | keyword match | `pregnancy_friendly` |
| `extras[]` contains "content creat*"/"influencer"/"vlog" | keyword match | `content_creator` |
| `extras[]` contains "road trip"/"self-drive" | keyword match | `road_trip_friendly` |
| `extras[]` contains "first international"/"never travelled abroad" | keyword match | `first_international_trip` |
| group size ≥ 3, no children, no bachelor(ette) match | fallback rule | `friends_trip` |
| nothing matched | — | `default` |

This is intentionally a **thin heuristic layer, not an LLM call** — the
ranking engine downstream must stay deterministic and auditable. It is a
first pass: anything ambiguous is returned in `unmatched_extras` for human
review rather than guessed at. Two things it does **not** yet do (documented
as next steps in `project.md`, not silently dropped):

- Fold `extras` like `dietary: vegetarian` or `flight: direct flights only`
  into weight *nudges* (rather than persona activation) — e.g. boost
  `vegetarian_food_access` weight when a dietary restriction is present.
- Evaluate the free-form `eligibility.trigger` expression strings in
  `personas.json` generically (e.g. `"group_size>=3 AND children==0 AND
  relationship=='friends'"`). Today those strings are documentation of
  intent; `personaFromBrief.js` reimplements the same intent in code by hand
  per persona. A generic safe expression evaluator over a fixed variable set
  would let `personas.json` alone drive activation — worth building once a
  second and third persona-trigger consumer exists (e.g. a non-Maya intake
  form), not before.

### How each future agent plugs in

| Agent | Reads | Calls |
|---|---|---|
| Destination Recommendation | `country.json` candidates for a region | `rankEntities` on countries |
| Hotel Recommendation | `hotels.json` scoped to a chosen city | `rankEntities` on that city's hotels |
| Flight Recommendation | `flights.json` scoped to the chosen country | `rankEntities` on flight routes (persona weights that include `direct_flight_access`/`flight_time_ease` dominate) |
| Visa Agent | `visa.json` | Reads `attributes.visa_ease_index_0_100` + `provenance[].requires_live_verification` directly — **must** re-verify live before stating a visa fact to a user, never answer from this cache alone |
| Budget Agent | `cost_efficiency` / `value_for_money` signals across all entity types | Sums `price_inr` / `price_inr_per_night` / `avg_price_inr_return_economy` for a candidate itinerary |
| Itinerary Agent | `<country>.full.json` (country → cities → activities/hotels, pre-scored) | Picks top-N per day from `rankEntities` output, sequences by `duration_hours` + `category` diversity |
| Conflict Resolution Agent | `gate_failures[]` across stacked personas | When personas disagree (e.g. `bachelor_trip` wants Pattaya nightlife, a stacked `senior_citizen` grandparent hard-gates it out), surfaces the exact gate reason rather than silently picking a winner |
| Summary Agent | `explanation.reasons` / `.cautions` | Narrates, never invents, scores already computed upstream |
| Family / Friends / Bachelor(ette) / Senior / Infant / Child / Female Solo / Pregnancy / Wheelchair / Road Trip / First-Timer / Content Creator Agents | Their persona's slice of `personas.json` | Each is really "call `rankEntities` with this persona id (or a stack including it)" — there is deliberately no separate code path per agent; the persona *is* the agent-specific behavior |

## Integration & deployment recommendation

**Keep this in Node, as a Turborepo workspace package — do not introduce
Python for this layer.**

Why:
- The onboarding doc confirms the production stack is Node 20 / Express /
  Turborepo npm workspaces already (`apps/*`, `backend`, `packages/*`). This
  engine is pure deterministic arithmetic (normalize → weight → gate) with
  zero ML/statistics dependencies — there is nothing here Python would do
  better, and introducing it would mean a second runtime, a second
  deploy/build pipeline, and cross-language JSON marshalling for no gain.
- `engine/normalize.js` and friends are already plain ESM with no
  dependencies — they can be published as `packages/core-engine` in the
  existing monorepo (`package.json` here is already shaped for that: private,
  ESM, zero deps) and imported directly by `backend` (`import { rankEntities }
  from '@travelomore/core-engine'`), in-process, no network hop, no new
  service to deploy or monitor.
- `backend/deploy.sh` already builds/deploys the whole Node backend as one
  Docker image to Cloud Run — a workspace package adds zero new deployment
  surface. A separate Python service would need its own Dockerfile, its own
  Cloud Run service, its own inter-service auth, and would still need to
  marshal every request/response through JSON anyway.
- Maya already calls OpenAI directly from `backend/src/routes/ai.ts`. The
  natural integration point for `derivePersonas()` is right next to that,
  reading `chat_sessions.brief` after Maya finishes a conversation, and
  handing the derived persona(s) + a candidate entity set to this engine.

**When Python would earn its place** (not needed today, flag if it comes up):
semantic/vector search over free-text reviews, embeddings-based "similar
destination" retrieval, or ML demand/pricing forecasting. None of that is
part of the deterministic ranking contract this engine promises — if it's
ever needed, it should sit *beside* this engine as a separate scoring input
(e.g. a `semantic_similarity` signal fed into the same signal vector), not
replace it.

**Concrete next integration step:** publish this directory as
`packages/core-engine` inside the main Travelomore monorepo (or add it as a
git submodule / private npm package if kept in a separate repo, as it is
today), add it to `backend`'s dependencies, and add one route,
`POST /api/core-engine/rank`, that accepts `{ brief, entityType, cityId? }`
and returns ranked + explained candidates — callable by the frontend Maya
widget or any other agent without duplicating scoring logic client-side.
