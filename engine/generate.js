/**
 * Travelomore Core — Generator CLI
 *
 * Loads a COUNTRY catalog, scores every entity against every persona, and
 * writes the enriched "raw data + computed scores + explanations" output that
 * downstream agents (Itinerary, Summary, Conflict Resolution, ...) read. Also
 * runs one end-to-end demo query through the full pipeline:
 *   Maya brief -> derivePersonas -> composePersonas -> rank -> explain
 *
 * The generator is country-agnostic: it runs the identical pass over whatever
 * catalog it is handed, and writes to output/<country>/.
 *
 * Usage:
 *   node engine/generate.js          every registered country  (or: npm run generate)
 *   node engine/generate.js uae      just one
 */

import { writeJSON as writeJSONRaw } from './loadData.js';
import { listCountries, loadCountryCatalog } from './countries.js';
import { scoreEntity, rankEntities, composePersonas } from './score.js';
import { buildExplanation } from './explain.js';
import { derivePersonas } from './personaFromBrief.js';

const writeJSON = (relPath, data) => {
  writeJSONRaw(relPath, data);
  console.log(`  wrote ${relPath}`);
};

function generateCountry(slug) {
  const {
    dictionary,
    personaFile,
    personasById,
    ALL_PERSONA_IDS,
    countryFile,
    cityFile,
    hotelFile,
    flightFile,
    visaFile,
    country,
    activities,
    hotels,
    flights,
    visas,
    ancestorsOf,
  } = loadCountryCatalog(slug);

  const out = `output/${slug}`;
  console.log(`\n${'='.repeat(64)}\nTravelomore Core Engine — generating scored output for ${country.name} (${slug})\n${'='.repeat(64)}\n`);

  console.log(
    `Loaded: 1 country, ${cityFile.entities.length} cities, ${activities.length} activities, ` +
      `${hotels.length} hotels, ${flights.length} flights, ${visas.length} visa record(s), ` +
      `${ALL_PERSONA_IDS.length} personas.\n`
  );

  function attachPersonaScores(entity, ancestors) {
    entity.persona_scores = {};
    for (const pid of ALL_PERSONA_IDS) {
      const persona = personasById[pid];
      const result = scoreEntity(entity, ancestors, persona, dictionary);
      const explanation = buildExplanation({ entity, persona, result, dictionary });
      entity.persona_scores[pid] = {
        persona_id: pid,
        eligible: result.eligible,
        gate_failures: result.gate_failures.map(
          ({ kind, reason, signal, attribute, op, required_value, actual_value }) => ({
            kind,
            reason,
            signal,
            attribute,
            op,
            required_value,
            actual_value,
          })
        ),
        score_0_1: result.score_0_1,
        score_0_10: result.score_0_10,
        signal_coverage: result.signal_coverage,
        explanation,
      };
    }
  }

  console.log('Scoring entities against all personas...');
  attachPersonaScores(country, []);
  for (const city of cityFile.entities) attachPersonaScores(city, ancestorsOf.destination_city(city));
  for (const activity of activities) attachPersonaScores(activity, ancestorsOf.activity(activity));
  for (const hotel of hotels) attachPersonaScores(hotel, ancestorsOf.hotel(hotel));
  for (const flight of flights) attachPersonaScores(flight, ancestorsOf.flight(flight));
  for (const visa of visas) attachPersonaScores(visa, ancestorsOf.visa(visa));
  console.log('  done.\n');

  // ---- Write per-type scored files -------------------------------------------
  console.log('Writing scored output files...');
  writeJSON(`${out}/country.scored.json`, countryFile);
  writeJSON(`${out}/cities.scored.json`, cityFile);
  writeJSON(`${out}/activities.scored.json`, {
    schema: 'travelomore/activity/1.0.0',
    notes: `Merged from this country's activity files (see data/countries/${slug}/catalog.json), then scored.`,
    entities: activities,
  });
  writeJSON(`${out}/hotels.scored.json`, hotelFile);
  writeJSON(`${out}/flights.scored.json`, flightFile);
  writeJSON(`${out}/visa.scored.json`, visaFile);

  // ---- Master consolidated file (the single file an LLM/itinerary agent loads) --
  const citiesWithChildren = cityFile.entities.map((city) => ({
    ...city,
    activities: activities.filter((a) => a.parent_id === city.id),
    hotels: hotels.filter((h) => h.parent_id === city.id),
  }));

  const masterFile = {
    schema: 'travelomore/core_engine_output/1.0.0',
    generated_at: new Date().toISOString(),
    engine_version: '0.1.0',
    persona_catalog: personaFile.personas.map(({ id, label, description }) => ({ id, label, description })),
    country: { ...country, cities: citiesWithChildren },
    flights,
    visas,
  };
  writeJSON(`${out}/${slug}.full.json`, masterFile);
  console.log('');

  // ---- Console sanity check: do the rankings make intuitive sense? -----------
  function printTop(label, persona, items, ancestorsFn, n = 5) {
    const ranked = rankEntities(
      items.map((entity) => ({ entity, ancestors: ancestorsFn(entity) })),
      persona,
      dictionary
    );
    console.log(`  ${label}`);
    for (const r of ranked.slice(0, n)) {
      console.log(`    ${r.score_0_10.toFixed(1).padStart(4)}  ${r.eligible ? ' ' : '[X]'} ${r.name}`);
    }
  }

  console.log('Sanity check — senior_citizen persona, cities ranked (top 5 / bottom 5):');
  printTop('Top 5:', personasById.senior_citizen, cityFile.entities, ancestorsOf.destination_city, 5);
  {
    const ranked = rankEntities(
      cityFile.entities.map((entity) => ({ entity, ancestors: ancestorsOf.destination_city(entity) })),
      personasById.senior_citizen,
      dictionary
    );
    console.log('  Bottom 5:');
    for (const r of ranked.slice(-5)) {
      console.log(`    ${r.score_0_10.toFixed(1).padStart(4)}  ${r.eligible ? ' ' : '[X]'} ${r.name}`);
    }
  }
  console.log('');

  console.log('Sanity check — bachelor_trip persona, cities ranked (top 5):');
  printTop('Top 5:', personasById.bachelor_trip, cityFile.entities, ancestorsOf.destination_city, 5);
  console.log('');

  // ---- End-to-end demo: Maya brief -> personas -> composed score -> explain --
  console.log(`Running end-to-end demo query (sample Maya brief for ${country.name})...`);
  const demoBrief = {
    destinationType: `${country.name} family beach trip`,
    dates: '10 Dec - 18 Dec 2026',
    duration: '8 nights',
    budget: '₹1.2L per person',
    groupComposition: '2 adults, 1 child (8 yrs)',
    extras: [
      { label: 'dietary', value: 'vegetarian' },
      { label: 'accessibility', value: 'wheelchair-friendly transfers needed for a grandparent joining' },
      { label: 'activity', value: 'no extreme adventure sports' },
    ],
    awaitingField: null,
    conversationComplete: true,
  };

  const derived = derivePersonas(demoBrief);
  const composed = composePersonas(derived.personas, personasById);

  const topCities = rankEntities(
    cityFile.entities.map((entity) => ({ entity, ancestors: ancestorsOf.destination_city(entity) })),
    composed,
    dictionary
  ).slice(0, 5);
  const topActivities = rankEntities(
    activities.map((entity) => ({ entity, ancestors: ancestorsOf.activity(entity) })),
    composed,
    dictionary
  ).slice(0, 8);
  const topHotels = rankEntities(
    hotels.map((entity) => ({ entity, ancestors: ancestorsOf.hotel(entity) })),
    composed,
    dictionary
  ).slice(0, 5);

  const withExplanations = (ranked, ancestorsFn, entities) =>
    ranked.map((r) => {
      const entity = entities.find((e) => e.id === r.entity_id);
      const result = scoreEntity(entity, ancestorsFn(entity), composed, dictionary);
      return {
        entity_id: r.entity_id,
        name: r.name,
        score_0_10: r.score_0_10,
        eligible: r.eligible,
        explanation: buildExplanation({ entity, persona: composed, result, dictionary }),
      };
    });

  const demoResult = {
    brief: demoBrief,
    derived_personas: derived.personas,
    persona_extraction_notes: derived.notes,
    matched_extras: derived.matched_extras,
    unmatched_extras: derived.unmatched_extras,
    composed_persona: {
      id: composed.id,
      label: composed.label,
      composed_from: composed.composed_from,
      top_weights: Object.entries(composed.weights)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([signal, weight]) => ({ signal, weight: Number(weight.toFixed(3)) })),
    },
    top_cities: withExplanations(topCities, ancestorsOf.destination_city, cityFile.entities),
    top_activities: withExplanations(topActivities, ancestorsOf.activity, activities),
    top_hotels: withExplanations(topHotels, ancestorsOf.hotel, hotels),
  };
  writeJSON(`${out}/demo_query_result.json`, demoResult);

  console.log(`\nDerived personas for demo brief: [${derived.personas.join(', ')}]`);
  console.log('Top 3 cities for this composed persona:');
  for (const c of demoResult.top_cities.slice(0, 3)) {
    console.log(`  ${c.score_0_10.toFixed(1)}  ${c.name} — ${c.explanation.reasons[0] ?? ''}`);
  }

  console.log(`\nDone. See ${out}/ for all generated files.`);
}

const only = process.argv[2];
const targets = only ? [only] : listCountries();
for (const slug of targets) generateCountry(slug);
