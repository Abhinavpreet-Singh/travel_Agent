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
];

const ACCESSIBILITY_KEYWORDS = [/wheelchair/i, /mobility\s*aid/i, /accessib(le|ility)/i];
const PREGNANCY_KEYWORDS = [/pregnan/i, /expecting/i];
const FEMALE_SOLO_KEYWORDS = [/solo\s*female/i, /girls?\s*trip/i, /women[’']?s\s*trip/i];
const FIRST_TIMER_KEYWORDS = [/first\s*international/i, /first\s*time\s*abroad/i, /never\s*(been|travell?ed)\s*(abroad|internationally)/i];
const FRIENDS_KEYWORDS = [/friends?\s*trip/i, /guys?\s*trip/i, /squad/i];

function scanExtras(extras, keywordGroups) {
  const hits = [];
  for (const extra of extras ?? []) {
    for (const group of keywordGroups) {
      for (const pattern of group.patterns) {
        if (pattern.test(extra.value ?? '') || pattern.test(extra.label ?? '')) {
          hits.push({ persona: group.persona, extra });
        }
      }
    }
  }
  return hits;
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
  const isCouplePhrase = /\b(couple|honeymoon|my (wife|husband|partner|spouse|girlfriend|boyfriend|fianc[ée]e?))\b/i.test(text);

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
  const children_ages = [
    ...childAgeMatches.map((m) => {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      return unit.startsWith('mo') ? n / 12 : n;
    }),
    ...agedAges,
  ];

  const explicitInfant = /infant|baby|newborn/i.test(text);
  const seniorAdult =
    (/\b(6[0-9]|[7-9][0-9])\b/.test(text) && /adult|senior|parent|grandparent/i.test(text)) ||
    /\belderly\b|\bsenior citizen(s)?\b/i.test(text);

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
    infant_count,
    child_count,
    teen_count,
    has_senior_adult: seniorAdult,
    group_size: adults === null ? null : adults + children_ages.length,
  };
}

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

  const tripTypes = TRIP_TYPE_LABELS.filter(([, re]) => re.test(text)).map(([label]) => label);
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
  const matched_extras = [];
  const notes = [];

  if (roster.infant_count > 0) personas.add('infant_friendly');
  if (roster.child_count > 0) personas.add('child_friendly');
  if (roster.infant_count > 0 || roster.child_count > 0 || roster.teen_count > 0) personas.add('family_trip');
  if (roster.has_senior_adult) personas.add('senior_citizen');

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

  const occasionHits = scanExtras(extras, OCCASION_KEYWORDS);
  for (const hit of occasionHits) {
    personas.add(hit.persona);
    matched_extras.push(hit.extra);
  }

  for (const extra of extras) {
    const value = `${extra.label ?? ''} ${extra.value ?? ''}`;
    if (ACCESSIBILITY_KEYWORDS.some((p) => p.test(value))) {
      personas.add('wheelchair_friendly');
      matched_extras.push(extra);
    }
    if (PREGNANCY_KEYWORDS.some((p) => p.test(value))) {
      personas.add('pregnancy_friendly');
      matched_extras.push(extra);
    }
    if (FEMALE_SOLO_KEYWORDS.some((p) => p.test(value))) {
      personas.add('female_solo');
      matched_extras.push(extra);
    }
    if (FIRST_TIMER_KEYWORDS.some((p) => p.test(value))) {
      personas.add('first_international_trip');
      matched_extras.push(extra);
    }
    if (FRIENDS_KEYWORDS.some((p) => p.test(value)) && roster.child_count === 0 && roster.infant_count === 0) {
      personas.add('friends_trip');
      matched_extras.push(extra);
    }
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

  if (personas.size === 0) {
    personas.add('default');
    if (roster.group_size === 2 && roster.child_count === 0 && roster.infant_count === 0) {
      notes.push('Couple/duo trip detected — there is no dedicated honeymoon/couple persona in the current catalog yet, so this scores against default.');
    } else {
      notes.push('No persona signal detected — scoring against the default (balanced) persona.');
    }
  }

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
