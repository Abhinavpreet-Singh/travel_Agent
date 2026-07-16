/**
 * Travelomore Core — Country Registry, Resolution & Catalog Loading
 *
 * The seam that makes the engine "Planning Engine + Catalog" rather than
 * "Thailand Engine + a patch per country". Everything country-specific lives in
 * data/countries/<slug>/ behind three functions:
 *
 *   listCountries()            -> registered country slugs
 *   resolveCountry(text)       -> which country a free-text query is about
 *   loadCountryCatalog(slug)   -> the catalog the planning engine ranks over
 *
 * Registration is DATA, not code: a country exists because
 * data/countries/<slug>/catalog.json exists. Adding a country means adding a
 * folder — no engine change, no registry edit, no `if (country === ...)`.
 * Nothing downstream of loadCountryCatalog() may know which country it holds.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ROOT, readJSON, loadShared } from './loadData.js';

const COUNTRIES_DIR = 'data/countries';

/** Registered country slugs (folders under data/countries/ with a catalog.json), sorted for determinism. */
export function listCountries() {
  const dir = path.join(ROOT, COUNTRIES_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'catalog.json')))
    .map((d) => d.name)
    .sort();
}

const catalogCache = new Map();

/**
 * Load one country's catalog. Same shape for every country — the planning
 * engine reads `catalog.country` / `catalog.activities` and cannot tell
 * Thailand from the UAE. Cached: a catalog is immutable input, and the CLI,
 * the benchmark runner and country resolution all ask for the same ones.
 *
 * Activity files are listed EXPLICITLY in catalog.json rather than globbed —
 * concatenation order feeds score tie-breaking, so it must be pinned by the
 * catalog author, not by whatever order the filesystem happens to return.
 */
export function loadCountryCatalog(country) {
  if (!country) throw new Error(`loadCountryCatalog requires a country slug. Registered: ${listCountries().join(', ')}`);
  if (catalogCache.has(country)) return catalogCache.get(country);

  const dir = path.join(COUNTRIES_DIR, country);
  const manifestPath = path.join(ROOT, dir, 'catalog.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Unknown country "${country}". Registered countries: ${listCountries().join(', ') || '(none)'}`);
  }

  const manifest = readJSON(path.join(dir, 'catalog.json'));
  const rel = (f) => path.join(dir, f);
  const optional = (f) => (f && fs.existsSync(path.join(ROOT, rel(f))) ? readJSON(rel(f)) : { entities: [] });

  const { dictionary, personaFile, personasById, ALL_PERSONA_IDS } = loadShared();

  const countryFile = readJSON(rel(manifest.files.country));
  const cityFile = readJSON(rel(manifest.files.cities));
  const activityFiles = (manifest.files.activities ?? []).map((f) => readJSON(rel(f)));
  const hotelFile = optional(manifest.files.hotels);
  const flightFile = optional(manifest.files.flights);
  const visaFile = optional(manifest.files.visa);

  const countryEntity = countryFile.entities[0];
  const citiesById = Object.fromEntries(cityFile.entities.map((c) => [c.id, c]));
  const activities = activityFiles.flatMap((f) => f.entities);

  const ancestorsOf = {
    country: () => [],
    destination_city: () => [countryEntity],
    activity: (e) => [citiesById[e.parent_id], countryEntity],
    hotel: (e) => [citiesById[e.parent_id], countryEntity],
    flight: () => [countryEntity],
    visa: () => [countryEntity],
  };

  const catalog = {
    slug: country,
    // Country-specific PLANNING VOCABULARY (e.g. which essentials a first-timer
    // should cover) — data, so the planner logic stays universal. See
    // firstTimerEssentials() in cli.js.
    planningProfile: manifest.planning_profile ?? {},
    dictionary,
    personaFile,
    personasById,
    ALL_PERSONA_IDS,
    countryFile,
    cityFile,
    hotelFile,
    flightFile,
    visaFile,
    country: countryEntity,
    citiesById,
    activities,
    hotels: hotelFile.entities,
    flights: flightFile.entities,
    visas: visaFile.entities,
    ancestorsOf,
  };
  catalogCache.set(country, catalog);
  return catalog;
}

/** Whole-word, case-insensitive, regex-safe containment test ("uae" must not fire inside "Guam"). */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'iu').test(text);

/** Every name a city answers to: "Krabi (Ao Nang / Railay)" -> Krabi, Ao Nang, Railay. */
function cityAliases(city) {
  const names = [];
  const simple = city.name.split('(')[0].trim();
  if (simple) names.push(simple);
  const paren = city.name.match(/\(([^)]+)\)/);
  if (paren) for (const alt of paren[1].split('/').map((s) => s.trim())) if (alt) names.push(alt);
  return names;
}

/**
 * Which country is this query about?
 *
 * Two ways in, in priority order:
 *   1. The country is NAMED — "trip to thailand", "a week in the UAE" (name or
 *      alias from that country's own country.json).
 *   2. A city UNIQUELY identifies it — "friends trip to dubai" -> uae. Only
 *      when the match is unambiguous: a city name shared by two registered
 *      countries resolves to neither, and the caller falls back.
 *
 * Longest match wins, so a city whose name contains another's ("Abu Dhabi" vs a
 * hypothetical "Dhabi") can't be shadowed by the shorter one.
 *
 * @returns {{ country: string, matched: string, via: 'country_name'|'city' } | null}
 */
export function resolveCountry(text) {
  if (!text || !String(text).trim()) return null;
  const q = String(text);

  const byName = [];
  const byCity = [];
  for (const slug of listCountries()) {
    const catalog = loadCountryCatalog(slug);
    for (const term of [catalog.country.name, ...(catalog.country.aliases ?? [])]) {
      if (term && mentions(q, term)) byName.push({ country: slug, matched: term, via: 'country_name' });
    }
    for (const city of catalog.cityFile.entities) {
      for (const term of cityAliases(city)) {
        if (mentions(q, term)) byCity.push({ country: slug, matched: term, via: 'city' });
      }
    }
  }

  // A named country beats a city mention: "Dubai stopover on the way to Thailand"
  // is a Thailand trip. Within each tier, the longest match wins.
  for (const tier of [byName, byCity]) {
    if (!tier.length) continue;
    const countries = new Set(tier.map((m) => m.country));
    if (countries.size > 1) continue; // ambiguous at this tier — fall through / give up
    return tier.sort((a, b) => b.matched.length - a.matched.length)[0];
  }
  return null;
}
