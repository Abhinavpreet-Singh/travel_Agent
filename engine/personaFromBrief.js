/**
 * Travelomore Core — Persona Extraction Layer
 *
 * Bridges Maya's chat_sessions.brief JSON (see Developer Onboarding Guide §9.1 —
 * destinationType, dates, duration, budget, groupComposition, extras[]) to the
 * persona ids this engine scores against.
 *
 * This is intentionally a thin, regex/keyword heuristic layer, NOT an LLM call —
 * the ranking engine downstream must stay deterministic. It is a first-pass
 * extractor: obvious signals (child ages, "bachelorette", "wheelchair") are
 * caught reliably; anything ambiguous is left for a human-reviewable
 * `unmatched_extras` list rather than guessed at. Replace/extend the keyword
 * lists here as real brief data comes in — do not push this logic into the
 * scoring engine itself.
 */

const OCCASION_KEYWORDS = [
  { persona: 'bachelorette_trip', patterns: [/bachelorette/i, /hen\s*do/i, /hen\s*party/i] },
  { persona: 'bachelor_trip', patterns: [/bachelor(?!ette)/i, /stag\s*do/i, /stag\s*party/i] },
  { persona: 'content_creator', patterns: [/content\s*creat/i, /influencer/i, /vlog/i, /reels?\s*shoot/i] },
  { persona: 'road_trip_friendly', patterns: [/road\s*trip/i, /self[\s-]?drive/i] },
  { persona: 'honeymoon', patterns: [/honeymoon/i] },
];

// Travel-style signals — not tied to occasion or group composition, can
// stack with anything (a honeymoon can also be luxury; a friends_trip can
// also be budget). Scanned the same way as OCCASION_KEYWORDS, against the
// same combined text blob.
const TRAVEL_STYLE_KEYWORDS = [
  { persona: 'luxury', patterns: [/luxury/i, /5[\s-]star/i, /five[\s-]star/i, /premium/i, /high[\s-]end/i, /lavish/i] },
  { persona: 'budget', patterns: [/\bbudget\b/i, /\bcheap\b/i, /affordable/i, /low[\s-]cost/i, /shoestring/i, /backpacking/i] },
  { persona: 'adventure', patterns: [/adventure/i, /trekking/i, /adrenaline/i, /extreme\s*sport/i, /hiking\s*trip/i] },
  { persona: 'wellness', patterns: [/wellness/i, /yoga\s*retreat/i, /spa\s*trip/i, /detox/i, /meditation\s*retreat/i, /relaxation\s*trip/i] },
  { persona: 'foodie', patterns: [/foodie/i, /food\s*trip/i, /culinary/i, /food\s*tour/i] },
  { persona: 'digital_nomad', patterns: [/digital\s*nomad/i, /remote\s*work/i, /workation/i, /work\s*from\s*thailand/i] },
];

const ACCESSIBILITY_KEYWORDS = [/wheelchair/i, /mobility\s*aid/i, /accessib(le|ility)/i];
const PREGNANCY_KEYWORDS = [/pregnan/i, /expecting/i];
// "girls trip"/"women's trip" describe a GROUP of women, the opposite of
// solo — female_solo's own eligibility rule is group_size==1. Only phrases
// that are actually solo-specific belong here; a group of women is a
// friends_trip signal (FRIENDS_KEYWORDS already matches "girls trip").
const FEMALE_SOLO_KEYWORDS = [/solo\s*female/i, /female\s*solo/i];
const FIRST_TIMER_KEYWORDS = [/first\s*international/i, /first\s*time\s*abroad/i, /never\s*(been|travell?ed)\s*(abroad|internationally)/i];
const FRIENDS_KEYWORDS = [/friends?\s*trip/i, /guys?\s*trip/i, /squad/i];

/**
 * True if `pattern` matches `text` at least once WITHOUT being immediately
 * preceded by a negation word ("no", "not", "avoid", "without", "skip",
 * "never", "hate", "dislike") within a short window. Without this, "no
 * extreme adventure sports" matches the literal substring "adventure" and
 * incorrectly fires the `adventure` persona — the opposite of what the
 * traveller asked for. Found via generate.js's demo brief, which contains
 * exactly this phrase.
 */
function isNegated(text, matchIndex) {
  const before = text.slice(Math.max(0, matchIndex - 20), matchIndex);
  return /\b(no|not|avoid|without|skip|never|hate|dislike)\b[\s\w]*$/i.test(before);
}

function matchesPositively(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
    if (!isNegated(text, m.index)) return true;
  }
  return false;
}

function anyMatchesPositively(text, patterns) {
  return patterns.some((p) => matchesPositively(text, p));
}

/** Every brief field that might carry free text, concatenated into one searchable blob. */
function briefTextBlob(brief) {
  const extras = brief?.extras ?? [];
  return [brief?.destinationType ?? '', brief?.groupComposition ?? '', ...extras.map((e) => `${e.label ?? ''} ${e.value ?? ''}`)].join(
    ' '
  );
}

/**
 * Parse a group-composition description into a traveller roster.
 *
 * Handles both Maya's canonical stored format ("2 adults, 1 child (8 yrs)")
 * and free text a human might type ("married couple", "solo trip", "me and
 * 3 friends"). `adults`/`group_size` are `null` (not 0, not 1) when there is
 * no actual evidence of headcount — a bare, size-agnostic sentence like
 * "family trip to Phuket" must NOT be silently treated as a solo trip. Only
 * real evidence (an explicit number, "solo"/"alone", or "couple"/"honeymoon")
 * sets a headcount.
 */
export function parseGroupComposition(groupComposition = '') {
  const text = groupComposition;

  const numAdultsMatch = text.match(/(\d+)\s*(?:adults?|people|pax|of us|travell?ers?)\b/i);
  // "5 friends", "5 my friends", "5 of my friends", "my 5 friends" — the
  // possessive can sit on either side of the number or be dropped entirely;
  // a rigid "digit immediately before friends" pattern missed "5 my
  // friends" (found via a real query), which is at least as natural a
  // phrasing as "5 friends".
  const numFriendsMatch =
    text.match(/(\d+)\s*(?:of\s*)?(?:my|our)?\s*friends?\b/i) || text.match(/\b(?:my|our)\s*(\d+)\s*friends?\b/i);
  const isSoloPhrase = /\b(solo|alone|by myself|just me)\b/i.test(text);
  // "my" is optional — casual phrasing ("trip with wife", "traveling with husband")
  // drops the possessive at least as often as it keeps it.
  const isCouplePhrase = /\b(couple|honeymoon|(my\s+)?(wife|husband|partner|spouse|girlfriend|boyfriend|fianc[ée]e?))\b/i.test(text);
  // A romantic-partner mention carries intent beyond a bare headcount of two.
  // "with my girlfriend/boyfriend/wife/husband/partner" (or honeymoon) frames
  // the trip as romantic — a signal the couple/young_couple/honeymoon personas
  // lean into (they boost the `romantic` tag). The bare word "couple" with no
  // partner noun does NOT set this (it can be a friends "couple of us").
  const isRomanticPhrase =
    /\b(?:my\s+)?(wife|husband|partner|spouse|girlfriend|boyfriend|fianc[ée]e?|hubby)\b/i.test(text) || /\bhoneymoon\b/i.test(text);
  // Explicit traveller ages that are NOT child ages — "we both are 20", "we're
  // both 25", "we are 24", "I'm 26 and she's 24". A 20-year-old couple and a
  // 70-year-old couple want materially different trips (islands/nightlife vs
  // calm/wellness); capturing age lets the persona layer tell them apart
  // instead of collapsing every duo into one generic 'couple'. Restricted to
  // 2-digit ages and guarded against unit words ("we are 20 days", "20 k")
  // so a duration or budget can't masquerade as an age.
  const AGE_UNIT_GUARD = '(?!\\s*(?:days?|nights?|weeks?|months?|km|kms?|k\\b|baht|usd|dollars?|people|pax|hours?|hrs?|mins?|minutes?|%))';
  const adultAges = [];
  const bothAgeMatch = text.match(new RegExp(`\\bboth\\s+(?:are\\s+|of\\s+us\\s+are\\s+)?(\\d{2})\\b${AGE_UNIT_GUARD}`, 'i'));
  if (bothAgeMatch) adultAges.push(Number(bothAgeMatch[1]), Number(bothAgeMatch[1]));
  if (!bothAgeMatch) {
    for (const m of text.matchAll(
      new RegExp(
        `\\b(?:i(?:'m| am)|we(?:'re| are)|(?:my\\s+)?(?:wife|husband|partner|girlfriend|boyfriend|fianc[ée]e?|she|he)\\s+is)\\s+(\\d{2})\\b${AGE_UNIT_GUARD}`,
        'gi'
      )
    )) {
      adultAges.push(Number(m[1]));
    }
  }
  // Traveller self-ages. Seeded from the "we/both/I am N" phrasings here and
  // topped up further below with "N year old <adult-noun>" ages that the age
  // classifier resolves to the travellers themselves (see selfStatedAdultAges).
  let ages = adultAges.filter((a) => a >= 15 && a <= 99);
  // "young adult" band for destination archetype purposes (~18-30). Requires at
  // least one stated age and EVERY stated adult age to fall in-band, so a mixed
  // "I'm 34 and she's 28" pair stays a neutral couple rather than being nudged
  // toward the young-couple beach/nightlife archetype on a partial match.
  // Finalised after the age classifier below (which may add self-ages).
  let young_adults = false;
  // "trip with my mom and dad" mentions two family members and (per the
  // "trip WITH X" framing, same convention as isCouplePhrase) implies the
  // narrator travels too — 3 total. Found via a real query that had NO
  // numeric signal at all ("mom and dad" isn't a count), so it silently
  // fell through to `default` with zero roster information.
  const isParentsPhrase = /\b(mom and dad|dad and mom|mother and father|father and mother|my parents|both parents)\b/i.test(
    text
  );
  // The word "family" is itself a direct persona signal — "family trip",
  // "family of four", "travelling with my family", "family vacation" all
  // mean a household group (overwhelmingly with children) and should
  // activate family_trip. Previously "family" only reached destinationType
  // (the label) and never the persona; "family of four" with no explicit
  // ages fell all the way to `default`, then surfaced bar-crawls and
  // adults-only hotels — a real mischaracterization, found via that query.
  const isFamilyPhrase = /\bfamil(y|ies)\b/i.test(text);
  // "family of four" / "family of 4" -> a known TOTAL headcount (the split
  // between adults and children is genuinely unknown from this phrasing, so
  // we record the total without fabricating specific child ages — inventing
  // ages would let age-specific hard gates fire on made-up data).
  const FAMILY_WORD_NUM = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  // Accept "family of 5" and also "family trip/vacation/holiday/getaway of 5"
  // — a connective word between "family" and "of N" is common in real prompts
  // ("family trip of 5 with …") and previously blocked the total from ever
  // being captured, so the group size silently fell back to the pieces we
  // could individually count.
  const familyOfMatch = text.match(
    /famil(?:y|ies)\s+(?:trip\s+|vacation\s+|holiday\s+|getaway\s+)?of\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\b/i
  );
  const family_total = familyOfMatch
    ? /\d/.test(familyOfMatch[1])
      ? Number(familyOfMatch[1])
      : FAMILY_WORD_NUM[familyOfMatch[1].toLowerCase()]
    : null;

  let adults = null;
  if (numAdultsMatch) adults = Number(numAdultsMatch[1]);
  else if (numFriendsMatch) adults = Number(numFriendsMatch[1]);
  else if (isParentsPhrase) adults = 3;
  else if (isCouplePhrase) adults = 2;
  else if (isSoloPhrase) adults = 1;

  // Overloaded-word guard: "child"/"kids"/"son"/"daughter" can mean a minor OR
  // a grown-up offspring, and a stated age can belong to an offspring OR to a
  // traveller describing themselves ("55 year old couple" is the couple, not a
  // third person). A KID_WORD *near the age* is what tells these apart.
  // KID_WORD_SRC is the source string (reused in the unit-less patterns);
  // nearKid() tests a small window around a match position.
  const KID_WORD_SRC = '(?:kids?|child(?:ren)?|kiddos?|sons?|daughters?|offspring)';
  const KID_WORD_RE = new RegExp(`\\b${KID_WORD_SRC}\\b`, 'i');
  const nearKid = (idx) => KID_WORD_RE.test(text.slice(Math.max(0, idx - 24), idx + 24));

  // Every explicitly captured age, tagged with whether it sits next to a
  // kid/offspring word. Matches Maya's canonical "(8 yrs)" plus free text
  // ("8-year-old", "8 years old"); "aged 5 and 9" lists; and unit-less
  // offspring forms ("children of age 20+", "kids over 18") which are
  // kid-anchored by construction. The "aged"/unit-less patterns are kept
  // disjoint so no age is captured twice and the count can't inflate.
  const taggedAges = [];
  for (const m of text.matchAll(/\(?(\d+)[\s-]*(yrs?|years?|y\.?o\.?|months?|mo)\)?/gi)) {
    const unit = m[2].toLowerCase();
    const age = unit.startsWith('mo') ? Number(m[1]) / 12 : Number(m[1]);
    taggedAges.push({ age, kid: nearKid(m.index) });
  }
  for (const m of text.matchAll(/\baged\s+(\d+(?:\s*,\s*\d+)*\s*and\s+\d+|\d+)/gi)) {
    for (const n of m[1].matchAll(/\d+/g)) taggedAges.push({ age: Number(n[0]), kid: nearKid(m.index) });
  }
  for (const re of [
    new RegExp(`${KID_WORD_SRC}[^.,;]{0,25}?\\b(?:of\\s+)?ages?\\s+(\\d+)`, 'gi'),
    new RegExp(`${KID_WORD_SRC}[^.,;]{0,25}?\\b(?:are|is)\\s+(\\d+)`, 'gi'),
    new RegExp(`${KID_WORD_SRC}[^.,;]{0,25}?\\b(?:above|over)\\s+(\\d+)`, 'gi'),
  ]) {
    for (const m of text.matchAll(re)) taggedAges.push({ age: Number(m[1]), kid: true });
  }

  // Route each captured age:
  //  - under 18            -> a minor child.
  //  - 18+ next to a kid   -> a grown-up offspring: an extra adult in the party
  //                           (so "children of age 20+" adds an adult, never a
  //                           child_friendly persona or age-6 gate).
  //  - 18+ NOT near a kid  -> a traveller stating their OWN age ("55 year old
  //                           couple"): recorded for persona nuance but NOT
  //                           added to the headcount — they are already counted.
  const ADULT_AGE = 18;
  let children_ages = taggedAges.filter((t) => t.age < ADULT_AGE).map((t) => t.age);
  const adult_offspring = taggedAges.filter((t) => t.age >= ADULT_AGE && t.kid).length;
  const selfStatedAdultAges = taggedAges.filter((t) => t.age >= ADULT_AGE && !t.kid).map((t) => t.age);
  // Gates the assume-6 fallback below: true when an age was stated FOR the kids
  // (a minor, or a kid-adjacent adult). A traveller's own age must NOT count
  // here, or "55 year old couple" would suppress an unrelated kids fallback.
  const statedKidAges = taggedAges.filter((t) => t.kid || t.age < ADULT_AGE);

  // Fold traveller self-ages into `ages`, then finalise the young-adult band.
  for (const a of selfStatedAdultAges) if (a >= 15 && a <= 99) ages.push(a);
  young_adults = ages.length > 0 && ages.every((a) => a >= 18 && a <= 30);

  const explicitInfant = /infant|baby|newborn/i.test(text);

  // "family trip with 2 kids" / "travelling with my kids" — no age given at
  // all. Rather than silently triggering nothing (the previous behavior —
  // this fell all the way through to `default`, missing family_trip
  // entirely), assume a representative mid-child-band age (6) so
  // family_trip/child_friendly still fire, and flag the assumption via
  // `age_assumed` so a caller can ask for real ages instead of trusting the
  // guess for anything precise (e.g. an infant-specific gate).
  // Only assume a representative age when NOTHING numeric was stated for the
  // kids. If any explicit age was given (even one that resolved to an adult
  // offspring above), the ages are known — never fabricate a 6-year-old on top
  // of "children of age 20+".
  let age_assumed = false;
  if (children_ages.length === 0 && !explicitInfant && statedKidAges.length === 0) {
    const numKidsMatch = text.match(/\b(\d+)\s*(?:kids?|children|kiddos?)\b/i);
    const bareKidsWord = /\b(kids?|children|kiddos?)\b/i.test(text);
    if (numKidsMatch || bareKidsWord) {
      const count = numKidsMatch ? Number(numKidsMatch[1]) : 1;
      children_ages = Array(count).fill(6);
      age_assumed = true;
    }
  }
  // A named grandparent relation is treated as a direct senior signal on its
  // own — "grandmother going with me" carries no age digit, but "grandmother"
  // is about as strong a real-world signal for senior_citizen as an explicit
  // age. Includes the Hindi/Indian family terms (nani/dadi/nana/dada, +
  // regional buaji/taiji for an elder aunt) since this product's actual
  // users are predominantly Indian outbound travellers who are at least as
  // likely to write "nani" as "grandmother" — an English-only list silently
  // fails half the real userbase. Also covers indirect phrasing ("elderly
  // mother", "retired parents") that implies seniority without naming a
  // grandparent relation at all.
  // P0 SAFETY FIX: any explicitly stated traveller age >= 65 makes this a senior
  // trip, FULL STOP — regardless of the relation word. Previously the age clause
  // required an accompanying "adult/senior/parent/grandparent", so "retired 70
  // year old husband" (and "we are 66 and 70") parsed as a normal couple and the
  // senior_citizen hospital hard-gate never activated — a 70-year-old could be
  // sent to a hospital-less island. `ages` here is the traveller self-age list
  // (children's ages are tracked separately), so this can't misfire on a kid.
  const SENIOR_AGE = 65;
  const seniorAdult =
    ages.some((a) => a >= SENIOR_AGE) ||
    (/\b(6[0-9]|[7-9][0-9])\b/.test(text) && /adult|senior|parent|grandparent|husband|wife|spouse|partner|mother|father|mom|dad/i.test(text)) ||
    /\belderly\b|\bsenior citizen(s)?\b/i.test(text) ||
    /\b(grandma|grandmother|grandpa|grandfather|granny|grandparents?|nani|dadi|nana|dada)\b/i.test(text) ||
    /\belderly\s+(mother|father|mom|dad|parents?)\b/i.test(text) ||
    /\bretired\s+(mother|father|mom|dad|parents?|husband|wife|spouse|couple)\b/i.test(text);

  // "family of four, kids are 5 and 8" — we know the total (4) and the kids
  // (2), so the remainder are adults (2). Only infer when it's consistent
  // (kids don't exceed the stated total).
  if (adults === null && family_total !== null && children_ages.length > 0 && children_ages.length <= family_total) {
    adults = family_total - children_ages.length;
  }

  // Grown-up offspring (see adult_offspring above) count as adults. Added after
  // the base adult signals so "…dad and mom…children of age 20+" resolves to
  // 3 (mom+dad+narrator, from isParentsPhrase) + 1 (the adult child) = 4
  // adults, 0 children.
  if (adult_offspring > 0) adults = (adults ?? 0) + adult_offspring;

  const infant_count = children_ages.filter((a) => a < 3).length + (explicitInfant ? 1 : 0);
  const child_count = children_ages.filter((a) => a >= 3 && a <= 12).length;
  const teen_count = children_ages.filter((a) => a > 12 && a < 18).length;

  // Deliberately narrow — "female"/"woman"/"girl" vs "male"/"man"/"guy"/"boy"
  // only. Pronouns (he/she/him/her) are excluded: too likely to describe
  // someone other than the traveller ("my friend, she recommended Phuket").
  const genderIsFemale = /\b(female|woman|women|girl|girls)\b/i.test(text);
  const genderIsMale = /\b(male|man|men|guy|guys|boy|boys)\b/i.test(text);
  const gender = genderIsFemale && !genderIsMale ? 'female' : genderIsMale && !genderIsFemale ? 'male' : 'unspecified';

  // group_size: an explicitly stated total ("family trip of 5") is
  // authoritative. A named-but-uncounted member — e.g. the grandmother, who
  // registers as has_senior_adult but is never added to `adults` — can push
  // the real total above the pieces we could individually count, so take the
  // larger of the stated total and the computed sum rather than silently
  // undercounting. With neither, fall back to whichever single source exists.
  const computedSum = adults !== null ? adults + children_ages.length : null;
  let group_size = null;
  if (family_total !== null && computedSum !== null) group_size = Math.max(family_total, computedSum);
  else if (family_total !== null) group_size = family_total;
  else if (computedSum !== null) group_size = computedSum;

  return {
    adults,
    gender,
    ages,
    young_adults,
    romantic: isRomanticPhrase,
    children_ages,
    age_assumed,
    adult_offspring,
    infant_count,
    child_count,
    teen_count,
    has_senior_adult: seniorAdult,
    traveling_with_parents: isParentsPhrase,
    is_family: isFamilyPhrase,
    family_total,
    group_size,
  };
}

// Every one of these MUST also appear as a keyword group above
// (OCCASION_KEYWORDS / TRAVEL_STYLE_KEYWORDS / the dedicated *_KEYWORDS
// lists) — this is what guarantees the signal survives into destinationType
// even when groupComposition ends up structured ("2 adults") instead of
// falling back to the raw input text, which would otherwise silently drop
// a style word like "luxury" that never landed anywhere else in the blob.
const TRIP_TYPE_LABELS = [
  ['bachelorette', /bachelorette|hen\s*do|hen\s*party/i],
  ['bachelor', /bachelor(?!ette)|stag\s*do|stag\s*party/i],
  ['honeymoon', /honeymoon/i],
  ['family', /family/i],
  ['friends', /friends?\s*trip|squad|guys?\s*trip|girls?\s*trip/i],
  ['solo', /\b(solo|alone|by myself|just me)\b/i],
  ['senior', /senior|elderly/i],
  ['content creator', /content\s*creat|influencer|vlog/i],
  ['road trip', /road\s*trip|self[\s-]?drive/i],
  ['pregnancy', /pregnan|expecting/i],
  ['wheelchair-accessible', /wheelchair|mobility\s*aid|accessib(le|ility)/i],
  ['luxury', /luxury|5[\s-]star|five[\s-]star|premium|high[\s-]end|lavish/i],
  ['budget', /\bbudget\b|\bcheap\b|affordable|low[\s-]cost|shoestring|backpacking/i],
  ['adventure', /adventure|trekking|adrenaline|extreme\s*sport|hiking\s*trip/i],
  ['wellness', /wellness|yoga\s*retreat|spa\s*trip|detox|meditation\s*retreat|relaxation\s*trip/i],
  ['foodie', /foodie|food\s*trip|culinary|food\s*tour/i],
  ['digital nomad', /digital\s*nomad|remote\s*work|workation|work\s*from\s*thailand/i],
];

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RANGE_RE = new RegExp(`\\d{1,2}(?:st|nd|rd|th)?\\s*${MONTH}[a-z]*\\s*(?:[-–—]|to)\\s*\\d{1,2}(?:st|nd|rd|th)?\\s*${MONTH}[a-z]*\\s*,?\\s*\\d{4}`, 'i');
const DATE_SINGLE_RE = new RegExp(`\\d{1,2}(?:st|nd|rd|th)?\\s*${MONTH}[a-z]*\\s*,?\\s*\\d{4}?`, 'i');
const BUDGET_RE = /(₹\s?[\d,]+(?:\.\d+)?\s?(?:l|lakh|lakhs|k)?|(?:rs\.?|inr)\s?[\d,]+|(?:\$|usd)\s?[\d,]+)\s*(?:per\s*(?:person|head|pax))?/i;

/**
 * Best-effort parse of a raw free-text prompt into Maya's exact stored
 * `chat_sessions.brief` shape (destinationType, dates, duration, budget,
 * groupComposition, extras[]) — see Developer Onboarding Guide §9.1. This is
 * what makes a typed prompt and a real Maya conversation land in the same
 * shape before `derivePersonas()` ever runs. `dates`/`duration`/`budget` are
 * genuinely best-effort (free text is unbounded); anything not found is
 * `null` rather than guessed at.
 *
 * `countryName` only LABELS the brief ("UAE friends trip" vs "Thailand friends
 * trip"); it is never itself a persona signal — no persona pattern matches a
 * country name, so the same text derives the same personas in any country. It
 * defaults to NULL, not to a country: an unresolved query produces a "friends
 * trip" brief, never a "Thailand friends trip" brief for a traveller who never
 * said Thailand (see cli.js::resolveCountryForQuery).
 */
export function parseFreeTextToBrief(text = '', countryName = null) {
  const roster = parseGroupComposition(text);

  const tripTypes = TRIP_TYPE_LABELS.filter(([, re]) => matchesPositively(text, re)).map(([label]) => label);
  const destinationType = `${[countryName, tripTypes.join(' + ')].filter(Boolean).join(' ')} trip`.trim();

  const dateMatch = text.match(DATE_RANGE_RE) ?? text.match(DATE_SINGLE_RE);

  const WORD_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const nightsMatch = text.match(/(\d+)\s*nights?/i);
  const daysMatch = text.match(/(\d+)[\s-]*days?/i);
  const weeksNumMatch = text.match(/(\d+)\s*weeks?\b/i);
  const weeksWordMatch = text.match(/\b(a|an|one|two|three|four|five|six)\s*weeks?\b/i);
  let duration = null;
  if (nightsMatch) duration = `${nightsMatch[1]} nights`;
  else if (daysMatch) duration = `${daysMatch[1]} days`;
  else if (weeksNumMatch) duration = `${Number(weeksNumMatch[1]) * 7} days`;
  else if (weeksWordMatch) duration = `${WORD_NUMBERS[weeksWordMatch[1].toLowerCase()] * 7} days`;

  const budgetMatch = text.match(BUDGET_RE);

  const groupPieces = [];
  if (roster.adults !== null) {
    const genderSuffix = roster.adults === 1 && roster.gender !== 'unspecified' ? ` (${roster.gender})` : '';
    groupPieces.push(`${roster.adults} adult${roster.adults === 1 ? '' : 's'}${genderSuffix}`);
  }
  for (const age of roster.children_ages) {
    groupPieces.push(`1 child (${Number.isInteger(age) ? age : age.toFixed(1)} yrs)`);
  }
  const groupComposition = groupPieces.length ? groupPieces.join(', ') : text || null;

  const extras = [];
  const dietMatch = text.match(/\b(vegetarian|vegan|jain|halal|gluten[- ]free|no beef|no pork)\b/i);
  if (dietMatch) extras.push({ label: 'dietary', value: dietMatch[0].toLowerCase() });
  if (/wheelchair|mobility\s*aid|accessib(le|ility)/i.test(text)) {
    extras.push({ label: 'accessibility', value: 'wheelchair-friendly transfers/access needed' });
  }
  if (/no\s*(extreme|adventure)|avoid\s*(extreme|adventure)/i.test(text)) {
    extras.push({ label: 'activity', value: 'no extreme adventure sports' });
  }
  if (/direct\s*flights?\s*only/i.test(text)) extras.push({ label: 'flight', value: 'direct flights only' });
  for (const [label, re] of [
    ['occasion', /bachelorette|bachelor(?!ette)|honeymoon|anniversary/i],
  ]) {
    const m = text.match(re);
    if (m) extras.push({ label, value: m[0].toLowerCase() });
  }

  const brief = {
    destinationType,
    dates: dateMatch ? dateMatch[0] : null,
    duration,
    budget: budgetMatch ? budgetMatch[0].trim() : null,
    groupComposition,
    extras,
    awaitingField: null,
    conversationComplete: true,
  };
  // derivePersonas() re-parses `groupComposition` from scratch by default —
  // correct for a real Maya brief (groupComposition IS the authoritative
  // source there), but WRONG here whenever this function's own
  // reconstruction has already discarded information the raw text had.
  // E.g. "mom and dad" -> roster.adults=3 -> groupComposition rebuilt as the
  // string "3 adults", which no longer contains "mom and dad" for a second
  // parse to find — the relationship gets silently lost by its own
  // resolution. Attaching the already-computed roster lets derivePersonas
  // skip the lossy re-parse. Non-enumerable so it's invisible to
  // JSON.stringify (never pollutes recipe.json/ranked.json output) while still
  // a normal property for derivePersonas to read directly.
  Object.defineProperty(brief, '_roster', { value: roster, enumerable: false });
  return brief;
}

/**
 * @param {object} brief - Maya's stored chat_sessions.brief JSON (or the output of parseFreeTextToBrief)
 * @returns {{ personas: string[], roster: object, matched_extras: object[], unmatched_extras: object[], notes: string[] }}
 */
export function derivePersonas(brief) {
  const extras = brief?.extras ?? [];
  // Prefer a pre-computed roster (set by parseFreeTextToBrief on the
  // original raw text) over re-parsing groupComposition — the reconstructed
  // string can be lossy (see parseFreeTextToBrief's comment on `_roster`).
  // Absent for a real Maya brief, which re-parses groupComposition as before.
  const roster = brief?._roster ?? parseGroupComposition(brief?.groupComposition ?? '');
  const personas = new Set();
  const notes = [];

  // Every keyword scan below runs against ONE combined blob (destinationType
  // + groupComposition + every extra's label/value), not against extras[]
  // alone. This used to be two independently-maintained lists — this
  // function scanned only extras[], while parseFreeTextToBrief's own
  // TRIP_TYPE_LABELS wrote its matches (including "pregnancy") into
  // destinationType only, never into extras[]. They drifted out of sync:
  // "trip with wife shes pregnant" produced destinationType "Thailand
  // pregnancy trip" but derivePersonas never looked there, so it silently
  // fell back to `default`. One blob, scanned once, removes that entire
  // class of bug — a signal is visible here regardless of which brief field
  // it happened to land in, and regardless of whether the brief came from
  // parseFreeTextToBrief or a real Maya conversation.
  const textBlob = briefTextBlob(brief);

  if (roster.infant_count > 0) personas.add('infant_friendly');
  if (roster.child_count > 0) personas.add('child_friendly');
  // family_trip fires from an explicit child/teen count OR from the bare
  // word "family" — "family of four" is a family even before any age is
  // stated. Its weighting (safety, kid activities, dining ease) and gate
  // (safety_general >= 0.4) are the right default for any family group;
  // infant/child_friendly (with their stricter age gates) layer on only
  // once real ages are given.
  if (roster.infant_count > 0 || roster.child_count > 0 || roster.teen_count > 0 || roster.is_family) {
    personas.add('family_trip');
  }
  if (roster.has_senior_adult) personas.add('senior_citizen');
  if (roster.age_assumed) {
    notes.push(
      `Child(ren) mentioned with no age given — assumed age ~6 (mid child-band) so family_trip/child_friendly still apply. State exact ages for accurate gating (e.g. an infant under 3 would hard-gate out very different activities than a 6-year-old).`
    );
  } else if (
    roster.is_family &&
    roster.child_count === 0 &&
    roster.infant_count === 0 &&
    roster.teen_count === 0 &&
    !roster.adult_offspring
  ) {
    notes.push(
      `Family trip detected but no traveller ages given — scoring with family_trip weighting (safety, kid activities, dining ease, medical fallback). State each person's age to sharpen it: a child under 3 adds infant_friendly, a 3-12 year-old adds child_friendly, a 60+ adult adds senior_citizen — each applies stricter, more tailored gates than family_trip alone.`
    );
  }
  // "children"/"kids" that an explicit age revealed to be grown-ups (18+). Say
  // so loudly: this is exactly the overloaded-word case that used to invent a
  // minor and mis-fire child_friendly.
  if (roster.adult_offspring > 0) {
    notes.push(
      `"child(ren)"/"kids" in the request refers to grown-up offspring (18+) — counted as ${roster.adult_offspring} adult(s), so no child_friendly persona or child age-gate is applied. State exact ages if any traveller is in fact under 18.`
    );
  }

  // female_solo requires BOTH solo AND an explicit female signal — its own
  // eligibility rule is `group_size==1 AND gender=='female'`. There is no
  // dedicated persona in the current 14-persona catalog for a solo male or
  // gender-unspecified solo traveller; say so explicitly rather than
  // defaulting them into female_solo (a real bug this used to have) or
  // silently dropping the "solo" signal on the floor.
  if (roster.group_size === 1) {
    if (roster.gender === 'female') {
      personas.add('female_solo');
    } else if (roster.gender === 'male') {
      notes.push(
        'Solo male traveller detected — there is no dedicated male-solo persona yet, so this scores against default. Safety/night-life weighting will NOT reflect solo-specific risk. Worth adding a persona if this is a real segment.'
      );
    } else {
      notes.push(
        'Solo trip detected but gender was not stated — female_solo requires an explicit female signal, so this scores against default. State gender for a tailored persona.'
      );
    }
  }

  for (const group of OCCASION_KEYWORDS) {
    if (anyMatchesPositively(textBlob, group.patterns)) personas.add(group.persona);
  }
  // Travel-style signals stack with anything above — a honeymoon can also
  // be luxury, a friends_trip can also be budget — so these are never
  // gated behind roster checks the way friends_trip/family_trip are.
  for (const group of TRAVEL_STYLE_KEYWORDS) {
    if (anyMatchesPositively(textBlob, group.patterns)) personas.add(group.persona);
  }
  if (anyMatchesPositively(textBlob, ACCESSIBILITY_KEYWORDS)) personas.add('wheelchair_friendly');
  if (anyMatchesPositively(textBlob, PREGNANCY_KEYWORDS)) personas.add('pregnancy_friendly');
  if (anyMatchesPositively(textBlob, FEMALE_SOLO_KEYWORDS)) personas.add('female_solo');
  if (anyMatchesPositively(textBlob, FIRST_TIMER_KEYWORDS)) personas.add('first_international_trip');
  if (anyMatchesPositively(textBlob, FRIENDS_KEYWORDS) && roster.child_count === 0 && roster.infant_count === 0) {
    personas.add('friends_trip');
  }

  // group_size >= 3 alone is a weak signal for friends_trip — it's equally
  // consistent with "trip with my parents" or "family of four," which are
  // family, not friends. Only fire this fallback when there's no more
  // specific relationship already identified (parents, family, or an
  // already-detected base persona).
  if (
    roster.group_size !== null &&
    roster.group_size >= 3 &&
    roster.child_count === 0 &&
    roster.infant_count === 0 &&
    !roster.traveling_with_parents &&
    !roster.is_family &&
    !personas.has('bachelor_trip') &&
    !personas.has('bachelorette_trip')
  ) {
    personas.add('friends_trip');
    notes.push('friends_trip inferred from group_size >= 3 with no children — refine if this is a family or corporate group.');
  }

  // An unadorned 2-adult trip with no other signal (no honeymoon, no
  // occasion) gets its own persona now instead of silently falling to
  // `default` — `couple` exists specifically for this. A travel-style
  // keyword found above (luxury, wellness, etc.) doesn't block it — those
  // stack with `couple` the same way they'd stack with any other base
  // persona; only a genuine base persona (senior_citizen, bachelor_trip,
  // honeymoon, ...) should take precedence and skip this.
  const styleOnlyPersonas = new Set(TRAVEL_STYLE_KEYWORDS.map((g) => g.persona));
  const hasBasePersona = [...personas].some((p) => !styleOnlyPersonas.has(p));
  if (!hasBasePersona && roster.group_size === 2 && roster.child_count === 0 && roster.infant_count === 0) {
    // A young-adult duo gets the young_couple specialisation instead of the
    // neutral couple persona — same privacy priorities, but weighted toward the
    // beaches/islands/nightlife archetype most users actually picture for a
    // young Thailand couples' trip (see the young_couple persona description).
    // This is a deliberate PRODUCT prior, not a math/safety judgement, so it is
    // stated as such and is one keyword away from being overridden.
    if (roster.young_adults) {
      personas.add('young_couple');
      notes.push(
        `Young-adult couple detected (age${roster.ages.length > 1 ? 's' : ''} ${roster.ages.join(' & ')}) — scoring against young_couple: beaches, islands and value weigh more, and the strong "must be uncrowded" pull that favours the calm northern hill towns (Chiang Mai/Rai) for older couples is relaxed. This is a product prior about what a young couple usually wants, not a safety or quality judgement — say "persona:couple" to force the neutral couple ranking instead.`
      );
    } else {
      personas.add('couple');
      notes.push('Couple/duo trip detected with no other persona signal — scoring against the couple persona.');
    }
  }

  if (personas.size === 0) {
    personas.add('default');
    if (roster.traveling_with_parents) {
      notes.push(
        'Traveling with parents detected — there is no dedicated multi-generational/parents persona in the current catalog yet, so this scores against default. If either parent is 60+, mention their age (or "elderly"/"senior") to get senior_citizen instead — that persona is far more tailored (hospital access, low exertion, comfortable transport) than default is.'
      );
    } else {
      notes.push('No persona signal detected — scoring against the default (balanced) persona.');
    }
  }

  // Transparency reporting: which of the brief's own extras[] independently
  // matched a keyword group (for citation) vs carried a signal (dietary,
  // flight preference) this layer doesn't yet act on.
  const allPatterns = [
    ...OCCASION_KEYWORDS.flatMap((g) => g.patterns),
    ...ACCESSIBILITY_KEYWORDS,
    ...PREGNANCY_KEYWORDS,
    ...FEMALE_SOLO_KEYWORDS,
    ...FIRST_TIMER_KEYWORDS,
    ...FRIENDS_KEYWORDS,
  ];
  const matched_extras = extras.filter((e) => allPatterns.some((p) => p.test(`${e.label ?? ''} ${e.value ?? ''}`)));
  const matchedSet = new Set(matched_extras);
  const unmatched_extras = extras.filter((e) => !matchedSet.has(e));

  return {
    personas: [...personas],
    roster,
    matched_extras,
    unmatched_extras,
    notes,
  };
}
