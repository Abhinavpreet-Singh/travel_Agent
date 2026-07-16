/**
 * Travelomore Core — Filesystem + Shared Data
 *
 * JSON read/write rooted at the repo, plus the COUNTRY-INDEPENDENT inputs
 * (signal dictionary, personas) that every catalog is scored with.
 *
 * Country catalogs are NOT loaded here — see engine/countries.js
 * (loadCountryCatalog), which composes these shared inputs with one country's
 * entity files.
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

let sharedCache = null;

/**
 * The inputs that do NOT vary by country: the signal dictionary every entity is
 * normalized against, and the persona library every catalog is scored with.
 * A persona means the same thing in Bangkok and in Dubai — that universality is
 * the whole premise of the engine, so these load once and are shared by every
 * country catalog.
 */
export function loadShared() {
  if (sharedCache) return sharedCache;
  const dictionary = readJSON('ontology/signal_dictionary.json');
  const personaFile = readJSON('personas/personas.json');
  sharedCache = {
    dictionary,
    personaFile,
    personasById: Object.fromEntries(personaFile.personas.map((p) => [p.id, p])),
    ALL_PERSONA_IDS: personaFile.personas.map((p) => p.id),
  };
  return sharedCache;
}
