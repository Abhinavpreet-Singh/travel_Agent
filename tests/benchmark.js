/**
 * Travelomore Core — benchmark runner.
 *
 *   npm run benchmark            run every case in cases.js
 *   npm run benchmark senior     run only cases whose name matches "senior"
 *
 * Drives the REAL engine pipeline via evaluateQuery() (no files written, no
 * console noise from the engine), then checks each case's declared expectations
 * plus one universal invariant: activity coherence. Exits non-zero if anything
 * fails, so it drops straight into a pre-commit hook or CI.
 */

import { evaluateQuery } from '../engine/cli.js';
import { cases } from './cases.js';

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
/** City-name match is substring, case-insensitive: "Krabi" matches "Krabi (Ao Nang / Railay)". */
const has = (names, wanted) => names.some((n) => n.toLowerCase().includes(wanted.toLowerCase()));

/** Run one case; return { name, checks: [{ ok, label, detail }] }. */
function runCase(tc) {
  const { ranked, planner } = evaluateQuery(tc.query);
  const personas = ranked.query.personas ?? [];
  const cityNames = (ranked.recommended_cities ?? []).map((c) => c.name);
  const activityCityNames = (ranked.recommended_activities ?? []).map((a) => a.city).filter(Boolean);
  const excludedCityNames = (ranked.excluded_options ?? []).filter((e) => e.type === 'city').map((e) => e.name);
  const e = tc.expect ?? {};
  const checks = [];
  const check = (cond, label, detail = '') => checks.push({ ok: !!cond, label, detail });

  if (e.personas) check(sameSet(personas, e.personas), `personas == [${e.personas.join(', ')}]`, `got [${personas.join(', ')}]`);
  if (e.personasInclude)
    for (const p of e.personasInclude) check(personas.includes(p), `persona includes "${p}"`, `got [${personas.join(', ')}]`);

  if (e.topCityOneOf) {
    const top = cityNames[0] ?? '';
    const ok = top !== '' && e.topCityOneOf.some((c) => top.toLowerCase().includes(c.toLowerCase()));
    check(ok, `top city ∈ {${e.topCityOneOf.join(', ')}}`, `top is "${top || '(none)'}"`);
  }
  if (e.citiesInShortlist) for (const c of e.citiesInShortlist) check(has(cityNames, c), `shortlist includes "${c}"`, `cities: ${cityNames.join(', ') || '(none)'}`);
  if (e.citiesNotInShortlist) for (const c of e.citiesNotInShortlist) check(!has(cityNames, c), `shortlist excludes "${c}"`, `cities: ${cityNames.join(', ')}`);
  if (e.citiesExcluded) for (const c of e.citiesExcluded) check(has(excludedCityNames, c), `hard-excluded "${c}"`, `excluded: ${excludedCityNames.join(', ') || '(none)'}`);
  if (e.minActivities != null) check((ranked.recommended_activities ?? []).length >= e.minActivities, `>= ${e.minActivities} activities`, `got ${(ranked.recommended_activities ?? []).length}`);
  if (e.maxActivities != null) check((ranked.recommended_activities ?? []).length <= e.maxActivities, `<= ${e.maxActivities} activities`, `got ${(ranked.recommended_activities ?? []).length}`);

  // Experience-fit guard: no recommended activity may fall below this appropriateness
  // floor for the traveller (a senior never gets a bar crawl, a family no adult venue).
  if (e.minExperienceFit != null) {
    const offenders = (ranked.recommended_activities ?? []).filter((a) => a.experience_fit != null && a.experience_fit < e.minExperienceFit);
    check(offenders.length === 0, `every recommended activity has experience_fit >= ${e.minExperienceFit}`, offenders.length ? offenders.map((a) => `${a.name} (${a.experience_fit})`).join('; ') : '');
  }

  // Universal invariant: every recommended activity lives in a recommended city.
  const citySet = new Set(cityNames);
  const orphans = [...new Set(activityCityNames.filter((c) => !citySet.has(c)))];
  check(orphans.length === 0, 'activities coherent with recommended cities', orphans.length ? `orphan activity cities: ${orphans.join(', ')}` : '');

  // Universal invariant (Round 18/19): the COMPRESSED planner route must equal
  // the engine's itinerary_route, in order — compression must never change it.
  if (planner) {
    const route = planner.selected_route ?? [];
    const engineRoute = ranked.itinerary_route ?? [];
    const same = route.length === engineRoute.length && route.every((c, i) => c === engineRoute[i]);
    check(same, 'compressed_context_produces_same_route', same ? '' : `planner ${JSON.stringify(route)} vs engine route ${JSON.stringify(engineRoute)}`);
  }

  // Round 21: day allocation must sum to the trip duration and cover exactly the route.
  if (planner?.day_allocation) {
    const alloc = planner.day_allocation;
    const sum = alloc.reduce((s, a) => s + a.days, 0);
    const dur = planner.brief?.duration_days;
    if (dur != null) check(sum === dur, 'allocation_sums_to_duration', sum === dur ? '' : `sum ${sum} vs duration ${dur}`);
    const allocCities = alloc.map((a) => a.city);
    const route = planner.selected_route ?? [];
    const same = allocCities.length === route.length && allocCities.every((c, i) => c === route[i]);
    check(same, 'allocation_matches_route', same ? '' : `${JSON.stringify(allocCities)} vs route ${JSON.stringify(route)}`);
    check(alloc.every((a) => a.days >= 1), 'every allocated city has >= 1 day', '');
  }

  // Round 19: a beach-oriented persona whose route includes a beach city must get
  // a beach activity in the pool (the activity-strategy fix — no more beach:false).
  if (e.beachEssential) {
    check(planner?.first_timer_essentials?.beach === true, 'beach city in route implies a beach activity', planner?.first_timer_essentials?.beach ? '' : `beach=false; route=${JSON.stringify(ranked.itinerary_route)}`);
  }

  return { name: tc.name, note: tc.note, checks };
}

function main() {
  const filter = process.argv[2]?.toLowerCase();
  const selected = filter ? cases.filter((c) => c.name.toLowerCase().includes(filter)) : cases;

  if (!selected.length) {
    console.log(RED(`No benchmark cases match "${filter}". Available: ${cases.map((c) => c.name).join(', ')}`));
    process.exit(1);
  }

  console.log(BOLD(`\nTravelomore benchmark — ${selected.length} case(s)\n`));
  let passedCases = 0;
  let failedChecks = 0;

  for (const tc of selected) {
    const { name, note, checks } = runCase(tc);
    const failed = checks.filter((c) => !c.ok);
    const ok = failed.length === 0;
    if (ok) passedCases += 1;
    failedChecks += failed.length;

    console.log(`${ok ? GREEN('PASS') : RED('FAIL')}  ${BOLD(name)}  ${DIM(`(${checks.length} checks)`)}`);
    if (note) console.log(`      ${DIM(note)}`);
    for (const c of checks) {
      if (c.ok) console.log(`        ${GREEN('✓')} ${DIM(c.label)}`);
      else console.log(`        ${RED('✗')} ${c.label}${c.detail ? RED(`  — ${c.detail}`) : ''}`);
    }
    console.log();
  }

  const allOk = failedChecks === 0;
  console.log(BOLD('─'.repeat(56)));
  console.log(
    `${allOk ? GREEN('ALL PASS') : RED('FAILURES')}  ${passedCases}/${selected.length} cases green` +
      (failedChecks ? RED(`, ${failedChecks} failed check(s)`) : '')
  );
  console.log();
  process.exit(allOk ? 0 : 1);
}

main();
