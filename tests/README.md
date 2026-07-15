# Benchmark suite

A repeatable regression net for the ranking engine. Instead of eyeballing
outputs after every change, run:

```bash
npm run benchmark            # all cases
npm run benchmark senior     # only cases whose name matches "senior"
```

Exit code is `0` if everything passes, `1` if any check fails — so it drops
straight into a pre-commit hook or CI.

## How it works

- `cases.js` — the dataset: each case is a real free-text query plus the
  properties its output must hold.
- `benchmark.js` — the runner. It drives the **real** engine via
  `evaluateQuery()` (exported from `engine/cli.js` — same pipeline the CLI runs,
  minus files/console), so the suite can never drift from actual behavior.

## Adding a case

Append to the `cases` array in [`cases.js`](./cases.js). Assert only what the
case is really about — a case that over-specifies breaks on unrelated tuning.

```js
{
  name: 'solo_female_bangkok',
  query: 'solo female trip to bangkok for 4 days',
  note: 'Why this case exists / any accepted divergence from the naive guess.',
  expect: {
    personas: ['female_solo'],             // exact set (order-independent)
    // personasInclude: ['luxury'],        // subset, for stacked personas
    topCityOneOf: ['Bangkok'],             // the #1 city must be one of these
    citiesInShortlist: ['Bangkok'],        // each must appear
    // citiesNotInShortlist: ['Pai'],
    // citiesExcluded: ['Koh Tao'],        // must be hard-gated out (type city)
    // minActivities: 5, maxActivities: 40,
  },
}
```

City names match by **case-insensitive substring**, so `"Krabi"` matches
`"Krabi (Ao Nang / Railay)"`.

Every case is also checked for one **universal invariant** automatically:
*activity coherence* — every recommended activity must belong to a recommended
city (no orphan activity in a city we're not sending you to).

## When a case fails

Two possibilities, and it's worth being honest about which:

1. **A regression** — a change unintentionally moved a ranking. Fix the code.
2. **An intended change** — the new behavior is actually better. Update the
   expectation in `cases.js` *and* its `note` so the next person knows the move
   was deliberate, not an accident that got rubber-stamped.

The point of the suite is to force that decision every time, instead of letting
rankings drift silently.

## A note on "expected top city"

Some cases use `topCityOneOf: ['Chiang Mai', 'Koh Samui']` rather than a single
city. That's deliberate: for a few archetypes the engine's #1 defensibly differs
from the naive human guess (e.g. pregnant-honeymoon ranks Chiang Mai over Hua Hin
because the Zika soft-gate caps the islands). Those divergences are documented in
each case's `note` and in `project.md`'s decision log, not silently forced to
match a gut feeling.
