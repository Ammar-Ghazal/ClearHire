// Splits scraped posting text into fixed display sections for the posting page. Display only: the
// stored text stays the analysis input, so nothing here changes an analysis or its hashes.
import { POSTING_SECTIONS as ORDER, type FormattedPosting } from '@clearhire/shared';

type Section = FormattedPosting['sections'][number];
type Key = Section['key'];
type Block = Section['blocks'][number];


// Non-heading lines in these sections are list items; elsewhere they are paragraphs.
const LIST_SECTIONS = new Set<Key>([
  'responsibilities',
  'requirements',
  'preferred',
  'compensation',
  'process',
]);

// Matched against a normalized heading in order, so "About our benefits" is compensation, not company.
const HEADINGS: [Key, RegExp][] = [
  ['preferred', /^(preferred|nice[- ]to[- ]haves?|bonus\b|desired|pluses)/],
  ['legal', /^(equal (employment )?opportunity|eeo\b|google's eeo|applicant and candidate privacy|know your rights)/],
  [
    'compensation',
    /^(salary|compensation|pay$|(available |our )?benefits|about our (benefits|perks)|perks|what you'll get|what's in it for you|why you'll love|what you will find|what we offer)/,
  ],
  ['process', /^((the )?next steps|how we hire|a note on our interview|(interview|hiring) process)/],
  [
    'responsibilities',
    /^((key )?responsibilities|(duties|key duties)\b|in this role|you will$|what you('ll| will) do|your daily routine|(as a .*)?your mission)/,
  ],
  [
    'requirements',
    /^((minimum |basic )?qualifications|(minimum )?requirements|what you('ll| will) need|what we('re| are) looking for|you (have|are)$|who you are|you might thrive|about you|(hard|soft) ?skills|it will be a perfect match|other prerequisites|work environment)/,
  ],
  ['additional', /^(more|additional|other) information$/],
  ['team', /^(about the team|(your future |the )?team)$/],
  [
    'role',
    /^(about the (role|job|position|opportunity)|the role|role overview|(job|position) summary|why we need you|the opportunity)/,
  ],
  ['company', /^(about (us|(?!the\b)\w)|our story|who we are|what we believe|why join|our (core )?values)/],
];

const LEGAL =
  /equal (employment )?opportunity|discriminat|reasonable accommodation|background check|fair chance|privacy (policy|notice)|personal information|e-verify|protected (veteran|characteristic)|\(AI\) tools/i;
// Pay details after the qualifications start the compensation section when it has no heading.
const PAY = /\b(base salary|annual salary|salary range|pay range|compensation (package|structure)|total compensation)\b/i;
const BULLET = /^(?:[-•*·▪●◦‣✔✓✅]|\d+[.)])\s*/u;
// A line ending in one of these words was cut mid-sentence where the source had inline markup.
const DANGLING =
  /\b(a|an|the|in|of|with|using|and|or|for|to|as|on|by|at|from|into|including|our|your|than|via|like)$/;
const CHROME =
  /^(apply( for this job| to join the team| now)?|share( .*)?|link|copy link|email( a friend)?|corporate_fare|place|bar_chart|info_outline|x)$/i;
const RESTATED = /^(role|location)\s*:/i;
const WORKPLACE = /\b(remote|hybrid|on-?site)\b/i;
const EMPLOYMENT = /time|permanent|contract|consultant|temporary|intern|freelance/i;

const AMOUNT = String.raw`[$£€]\s?\d[\d,]*(?:\.\d+)?\s?[kK]?`;
const PERIOD = String.raw`(?:\s*(?:\/\s?(?:yr|year|hr|hour)|(?:a|an|per)\s+(?:year|hour|month|annum)|annually|hourly))`;
const SALARY = new RegExp(`${AMOUNT}${PERIOD}?\\s*(?:-|–|—|to)\\s*${AMOUNT}${PERIOD}?|${AMOUNT}${PERIOD}`);
const SALARY_LINE = new RegExp(`^(?:${SALARY.source})$`);

const normalize = (line: string) =>
  line
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\d]+/u, '')
    .replace(/[^\p{L}\d)]+$/u, '')
    .toLowerCase();

const wordCount = (line: string) => line.split(/\s+/).length;

function headingKey(line: string, seen: Map<Key, Block[]>): Key | null {
  if (line.length > 80 || wordCount(line) > 10 || line.endsWith('.')) return null;
  const heading = normalize(line);
  const match = HEADINGS.find(([, pattern]) => pattern.test(heading))?.[0] ?? null;
  // A bare "Team" after the team section exists is a perk or value, not a second team section.
  return match === 'team' && heading === 'team' && seen.has('team') ? null : match;
}

function isSubheading(line: string, next: string | undefined): boolean {
  if (line.length > 70 || line.endsWith('.') || BULLET.test(line)) return false;
  const letters = line.replace(/[^\p{L}]/gu, '');
  if (line.endsWith(':') || (letters.length >= 4 && letters === letters.toUpperCase())) return true;
  // Title-case label introducing a longer line, as in "CI/CD Engineering" above its items.
  const titled = line.split(/\s+/).every((w) => w.length < 4 || !/^\p{Ll}/u.test(w));
  return titled && !/\d/.test(line) && wordCount(line) <= 6 && line.length <= 45 && (next?.length ?? 0) > 60;
}

/** Rejoins lines the scraper split at inline markup, and drops page chrome. */
function joinFragments(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const prev = out.at(-1);
    const continues =
      prev !== undefined &&
      !BULLET.test(line) &&
      (/^[\p{Ll},.;:)!?]/u.test(line) || (DANGLING.test(prev) && !/[.:!?]$/.test(prev)));
    if (continues) out[out.length - 1] = /^[,.;:)!?]/.test(line) ? prev + line : `${prev} ${line}`;
    else out.push(line);
  }
  return out;
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const workplaceLabel = (value: string) =>
  /remote/i.test(value) ? 'Remote' : /hybrid/i.test(value) ? 'Hybrid' : 'On-site';

export function formatPosting(job: { text: string; location: string | null }): FormattedPosting {
  let lines = job.text
    .replace(/&nbsp;/g, '\n')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\*+/g, '').trim().replace(/^\|\s*/, ''))
    .filter((l) => /[\p{L}\d]/u.test(l));

  // Job boards (Lever, Google) open with a header ending at an apply link: title, location, team,
  // commitment and workplace, or share buttons.
  let employmentType: string | null = null;
  let workplace: string | null = null;
  const headerEnd = lines
    .slice(0, 40)
    .findIndex((l) => /^(apply for this job|apply to join the team|x)$/i.test(l));
  if (headerEnd >= 0) {
    const header = lines.slice(0, headerEnd);
    const commitment = header.find((l) => l.endsWith(' /') && EMPLOYMENT.test(l));
    if (commitment) employmentType = commitment.slice(0, -2);
    const place = header.findLast((l) => /^(remote|hybrid|on-?site)$/i.test(l));
    if (place) workplace = workplaceLabel(place);
    lines = lines.slice(headerEnd + 1);
  }
  lines = joinFragments(lines.filter((l) => !CHROME.test(l)));

  const salaryLine = lines.find((l) => SALARY_LINE.test(l));
  // Without a salary line, only a range or a pay period counts, so "raised $19m" is not a salary.
  const salary = salaryLine ?? job.text.match(SALARY)?.[0] ?? null;
  employmentType ??= job.text.match(/\b(full[- ]time|part[- ]time|internship|temporary|permanent)\b/i)?.[0] ?? null;
  const placeMatch = job.location?.match(WORKPLACE) ?? job.text.match(/\b(hybrid|remote-first|fully remote)\b/i);
  workplace ??= placeMatch ? workplaceLabel(placeMatch[0]) : null;
  const location = job.location?.replace(/,?\s*\b(remote|hybrid|on-?site)\b/gi, '').trim() || null;

  const sections = new Map<Key, Block[]>();
  const push = (key: Key, block: Block) => {
    const blocks = sections.get(key) ?? [];
    sections.set(key, [...blocks, block]);
  };
  let key: Key = 'overview';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const next = lines[i + 1];
    if (line === salaryLine) continue;
    const heading = headingKey(line, sections);
    if (heading) {
      if (sections.has(heading)) push(heading, { kind: 'subheading', text: line.replace(/:$/, '') });
      key = heading;
      continue;
    }
    // "Paid Onboarding:" then its text was one line in the source.
    if (PAY.test(line) && ORDER.indexOf(key) >= ORDER.indexOf('responsibilities')) {
      key = 'compensation';
    }
    const label = line.endsWith(':') && wordCount(line) <= 3;
    if (label && next && /^[\p{L}\d$£€]/u.test(next) && !headingKey(next, sections)) {
      line = `${line} ${next}`;
      i++;
    } else if (isSubheading(line, next)) {
      push(key, { kind: 'subheading', text: titleCase(line.replace(/:$/, '')) });
      continue;
    }
    if (RESTATED.test(line)) continue;
    const text = line.replace(BULLET, '');
    // Long notices only: a short "Pass a background check" stays a requirement.
    if (LEGAL.test(text) && text.length > 80) push('legal', { kind: 'paragraph', text });
    else if (BULLET.test(line) || (LIST_SECTIONS.has(key) && text.length <= 400)) {
      push(key, { kind: 'item', text });
    } else push(key, { kind: 'paragraph', text });
  }

  return {
    location,
    employmentType: employmentType && titleCase(employmentType),
    workplace,
    salary,
    sections: ORDER.flatMap((k) => {
      // Drop subheadings with nothing under them, then sections left empty.
      const blocks = (sections.get(k) ?? []).filter(
        (b, i, all) => b.kind !== 'subheading' || (all[i + 1] && all[i + 1]!.kind !== 'subheading'),
      );
      return blocks.length ? [{ key: k, blocks }] : [];
    }),
  };
}
