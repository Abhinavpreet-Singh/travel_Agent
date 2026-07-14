/**
 * Travelomore Core — Data Loader
 *
 * Single place that reads the Thailand JSON files and resolves ancestor
 * chains. Shared by engine/generate.js (bulk scoring) and engine/cli.js
 * (single-query testing) so both always see the same data-loading behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const readJSON = (relPath) => JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));

export function writeJSON(relPath, data) {
  const full = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return full;
}

export function loadThailand() {
  const dictionary = readJSON('ontology/signal_dictionary.json');
  const personaFile = readJSON('personas/personas.json');
  const personasById = Object.fromEntries(personaFile.personas.map((p) => [p.id, p]));
  const ALL_PERSONA_IDS = personaFile.personas.map((p) => p.id);

  const countryFile = readJSON('data/thailand/country.json');
  const cityFile = readJSON('data/thailand/cities.json');
  const activitiesSouth = readJSON('data/thailand/activities_south.json');
  const activitiesNorthGulf = readJSON('data/thailand/activities_north_gulf.json');
  const activitiesSupplemental = readJSON('data/thailand/activities_supplemental.json');
  const hotelFile = readJSON('data/thailand/hotels.json');
  const flightFile = readJSON('data/thailand/flights.json');
  const visaFile = readJSON('data/thailand/visa.json');

  const country = countryFile.entities[0];
  const citiesById = Object.fromEntries(cityFile.entities.map((c) => [c.id, c]));
  const activities = [...activitiesSouth.entities, ...activitiesNorthGulf.entities, ...activitiesSupplemental.entities];
  const hotels = hotelFile.entities;
  const flights = flightFile.entities;
  const visas = visaFile.entities;

  const ancestorsOf = {
    country: () => [],
    destination_city: () => [country],
    activity: (e) => [citiesById[e.parent_id], country],
    hotel: (e) => [citiesById[e.parent_id], country],
    flight: () => [country],
    visa: () => [country],
  };

  return {
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
    citiesById,
    activities,
    hotels,
    flights,
    visas,
    ancestorsOf,
  };
}
