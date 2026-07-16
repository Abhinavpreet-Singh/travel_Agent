/**
 * Travelomore Core — Catalog Coverage Analysis
 *
 * Surfaces DATA gaps, not scoring gaps: for each city, does the activity catalog
 * actually cover what the city is KNOWN for? A beach city with no beach activity,
 * a food city with no food experience — those are authoring holes that no amount
 * of ranking can fix (Round 19 hit exactly this: Phuket routed but no calm beach
 * activity existed). This tells the data team where to add entries, and lets the
 * planner know when a route city can't fully deliver its own vibe.
 *
 * Deterministic and pure.
 */

import { pathToFileURL } from 'node:url';

// City tags that imply an EXPECTED activity style, mapped to the activity
// categories that would satisfy them. A city tagged `beach` should have at least
// one activity in a beach-ish category, etc. Only style-bearing tags are listed
// (walkable / photogenic / package_ready / … don't imply an activity kind).
export const EXPECTED_STYLE_TAGS = {
  beach: ['beach', 'beach_club', 'island_hopping', 'water_sports', 'diving'],
  island: ['island_hopping', 'beach', 'diving', 'water_sports'],
  nightlife: ['nightlife', 'beach_club', 'show'],
  heritage: ['heritage', 'culture'],
  cultural: ['culture', 'heritage'],
  wellness: ['wellness', 'heritage_wellness'],
  food: ['food', 'dining'],
  nature: ['nature', 'scenic', 'adventure', 'wildlife', 'waterfall'],
};

/**
 * Coverage for one city.
 * @returns {{ city, city_tags: string[], available_styles: string[], missing_styles: string[] }}
 */
export function cityCoverage(city, activities) {
  const cityActs = activities.filter((a) => a.parent_id === city.id);
  const availableStyles = [...new Set(cityActs.map((a) => a.category).filter(Boolean))].sort();
  const availableSet = new Set(availableStyles);
  const dominantTags = (city.tags ?? []).filter((t) => EXPECTED_STYLE_TAGS[t]);
  const missing = dominantTags.filter((tag) => !EXPECTED_STYLE_TAGS[tag].some((cat) => availableSet.has(cat)));
  return {
    city: city.name,
    city_tags: dominantTags,
    available_styles: availableStyles,
    missing_styles: [...new Set(missing)],
  };
}

/** Coverage for every city; sorted so cities WITH gaps read first. */
export function analyzeCatalogCoverage(data) {
  return data.cityFile.entities
    .map((c) => cityCoverage(c, data.activities))
    .sort((a, b) => b.missing_styles.length - a.missing_styles.length || a.city.localeCompare(b.city));
}

// Runnable directly: `node engine/coverage.js` prints the coverage report.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadThailand } = await import('./loadData.js');
  const report = analyzeCatalogCoverage(loadThailand());
  const gaps = report.filter((c) => c.missing_styles.length);
  console.log('\nCatalog coverage — cities with gaps first\n');
  for (const c of report) {
    console.log(`${c.missing_styles.length ? 'GAP ' : 'ok  '} ${c.city.padEnd(26)}${c.missing_styles.length ? `missing: ${c.missing_styles.join(', ')}` : ''}`);
    if (c.missing_styles.length) console.log(`      tags [${c.city_tags.join(', ')}]  has [${c.available_styles.join(', ')}]`);
  }
  console.log(`\n${gaps.length}/${report.length} cities have catalog gaps: ${JSON.stringify(gaps.map((c) => ({ city: c.city, missing_styles: c.missing_styles })))}\n`);
}
