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
  const numFriendsMatch = text.match(/(\d+)\s*friends?\b/i);
  const isSoloPhrase = /\b(solo|alone|by myself|just me)\b/i.test(text);
  // "my" is optional — casual phrasing ("trip with wife", "traveling with husband")
  // drops the possessive at least as often as it keeps it.
  const isCouplePhrase = /\b(couple|honeymoon|(my\s+)?(wife|husband|partner|spouse|girlfriend|boyfriend|fianc[ée]e?))\b/i.test(text);

  let adults = null;
  if (numAdultsMatch) adults = Number(numAdultsMatch[1]);
  else if (numFriendsMatch) adults = Number(numFriendsMatch[1]);
  else if (isCouplePhrase) adults = 2;
  else if (isSoloPhrase) adults = 1;

  // Matches Maya's canonical "(8 yrs)" as well as free-text phrasings like
  // "8-year-old" or "8 years old" (the hyphen/space gap before the unit word
  // is deliberately loose since a human typing a prompt won't match Maya's
  // stored-brief formatting exactly).
  const childAgeMatches = [...text.matchAll(/\(?(\d+)[\s-]*(yrs?|years?|y\.?o\.?|months?|mo)\)?/gi)];
  // "aged 5 and 9" / "aged 5, 9 and 12" — capture the whole number list after
  // "aged", not just the first digit run. Requires "and" before the final
  // number in a multi-age list (rather than a bare comma with no anchor), so
  // an unrelated later clause like "aged 5 and 9, 10 nights" doesn't get its
  // "10" swallowed into the age list.
  const agedMatches = [...text.matchAll(/\baged\s+(\d+(?:\s*,\s*\d+)*\s*and\s+\d+|\d+)/gi)];
  const agedAges = agedMatches.flatMap((m) => [...m[1].matchAll(/\d+/g)].map((n) => Number(n[0])));
  let children_ages = [
    ...childAgeMatches.map((m) => {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      return unit.startsWith('mo') ? n / 12 : n;
    }),
    ...agedAges,
  ];

  const explicitInfant = /infant|baby|newborn/i.test(text);

  // "family trip with 2 kids" / "travelling with my kids" — no age given at
  // all. Rather than silently triggering nothing (the previous behavior —
  // this fell all the way through to `default`, missing family_trip
  // entirely), assume a representative mid-child-band age (6) so
  // family_trip/child_friendly still fire, and flag the assumption via
  // `age_assumed` so a caller can ask for real ages instead of trusting the
  // guess for anything precise (e.g. an infant-specific gate).
  let age_assumed = false;
  if (children_ages.length === 0 && !explicitInfant) {
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
  const seniorAdult =
    (/\b(6[0-9]|[7-9][0-9])\b/.test(text) && /adult|senior|parent|grandparent/i.test(text)) ||
    /\belderly\b|\bsenior citizen(s)?\b/i.test(text) ||
    /\b(grandma|grandmother|grandpa|grandfather|granny|grandparents?|nani|dadi|nana|dada)\b/i.test(text) ||
    /\belderly\s+(mother|father|mom|dad|parents?)\b/i.test(text) ||
    /\bretired\s+(mother|father|mom|dad|parents?)\b/i.test(text);

  const infant_count = children_ages.filter((a) => a < 3).length + (explicitInfant ? 1 : 0);
  const child_count = children_ages.filter((a) => a >= 3 && a <= 12).length;
  const teen_count = children_ages.filter((a) => a > 12 && a < 18).length;

  // Deliberately narrow — "female"/"woman"/"girl" vs "male"/"man"/"guy"/"boy"
  // only. Pronouns (he/she/him/her) are excluded: too likely to describe
  // someone other than the traveller ("my friend, she recommended Phuket").
  const genderIsFemale = /\b(female|woman|women|girl|girls)\b/i.test(text);
  const genderIsMale = /\b(male|man|men|guy|guys|boy|boys)\b/i.test(text);
  const gender = genderIsFemale && !genderIsMale ? 'female' : genderIsMale && !genderIsFemale ? 'male' : 'unspecified';

  return {
    adults,
    gender,
    children_ages,
    age_assumed,
    infant_count,
    child_count,
    teen_count,
    has_senior_adult: seniorAdult,
    group_size: adults === null ? null : adults + children_ages.length,
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
 */
export function parseFreeTextToBrief(text = '') {
  const roster = parseGroupComposition(text);

  const tripTypes = TRIP_TYPE_LABELS.filter(([, re]) => matchesPositively(text, re)).map(([label]) => label);
  const destinationType = tripTypes.length ? `Thailand ${tripTypes.join(' + ')} trip` : 'Thailand trip';

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

  return {
    destinationType,
    dates: dateMatch ? dateMatch[0] : null,
    duration,
    budget: budgetMatch ? budgetMatch[0].trim() : null,
    groupComposition,
    extras,
    awaitingField: null,
    conversationComplete: true,
  };
}

/**
 * @param {object} brief - Maya's stored chat_sessions.brief JSON (or the output of parseFreeTextToBrief)
 * @returns {{ personas: string[], roster: object, matched_extras: object[], unmatched_extras: object[], notes: string[] }}
 */
export function derivePersonas(brief) {
  const extras = brief?.extras ?? [];
  const roster = parseGroupComposition(brief?.groupComposition ?? '');
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
  if (roster.infant_count > 0 || roster.child_count > 0 || roster.teen_count > 0) personas.add('family_trip');
  if (roster.has_senior_adult) personas.add('senior_citizen');
  if (roster.age_assumed) {
    notes.push(
      `Child(ren) mentioned with no age given — assumed age ~6 (mid child-band) so family_trip/child_friendly still apply. State exact ages for accurate gating (e.g. an infant under 3 would hard-gate out very different activities than a 6-year-old).`
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

  if (
    roster.group_size !== null &&
    roster.group_size >= 3 &&
    roster.child_count === 0 &&
    roster.infant_count === 0 &&
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
    personas.add('couple');
    notes.push('Couple/duo trip detected with no other persona signal — scoring against the couple persona.');
  }

  if (personas.size === 0) {
    personas.add('default');
    notes.push('No persona signal detected — scoring against the default (balanced) persona.');
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
