/**
 * Dates and deadlines in Dutch and English letters.
 *
 *   absolute   12 oktober 2026 · 12-10-2026 · 12/10/2026 · 2026-10-12 · October 12, 2026
 *   relative   binnen 14 dagen · binnen twee weken · binnen 10 werkdagen · within 30 days
 *   bounded    uiterlijk 15 november · vóór 1 december 2026 · no later than 15 November
 *   weekdays   vóór vrijdag · volgende week · morgen · next Monday
 */

const MONTHS: Record<string, number> = {
  januari: 1, jan: 1, january: 1,
  februari: 2, feb: 2, february: 2,
  maart: 3, mrt: 3, march: 3, mar: 3,
  april: 4, apr: 4,
  mei: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  augustus: 8, aug: 8, august: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const NUMBERS: Record<string, number> = {
  een: 1, één: 1, one: 1, twee: 2, two: 2, drie: 3, three: 3, vier: 4, four: 4, vijf: 5, five: 5,
  zes: 6, six: 6, zeven: 7, seven: 7, acht: 8, eight: 8, negen: 9, nine: 9, tien: 10, ten: 10,
  elf: 11, eleven: 11, twaalf: 12, twelve: 12, veertien: 14, fourteen: 14, vijftien: 15, fifteen: 15,
  twintig: 20, twenty: 20, dertig: 30, thirty: 30, zestig: 60, sixty: 60,
};

const WEEKDAYS: Record<string, number> = {
  zondag: 0, sunday: 0, maandag: 1, monday: 1, dinsdag: 2, tuesday: 2, woensdag: 3, wednesday: 3,
  donderdag: 4, thursday: 4, vrijdag: 5, friday: 5, zaterdag: 6, saturday: 6,
};

export interface FoundDate {
  date: string;
  phrase: string;
  index: number;
}

export interface Deadline {
  phrase: string;
  dueDate: string;
  kind: 'ABSOLUTE' | 'RELATIVE_DAYS' | 'RELATIVE_WORKING_DAYS' | 'WEEKDAY';
  workingDays?: number;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function num(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBERS[word.toLowerCase()] ?? null;
}

/** Every absolute date in a text, in order. `reference` fills in a missing year. */
export function findDates(text: string, reference: string): FoundDate[] {
  const found: FoundDate[] = [];
  const refYear = Number(reference.slice(0, 4));
  const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const patterns: [RegExp, (m: RegExpExecArray) => string | null][] = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => iso(+m[1], +m[2], +m[3])],
    [/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g, (m) => iso(+m[3], +m[2], +m[1])],
    [new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\.?(?:\\s+(\\d{4}))?\\b`, 'gi'), (m) => iso(m[3] ? +m[3] : refYear, MONTHS[m[2].toLowerCase()], +m[1])],
    [new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), (m) => iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2])],
  ];
  for (const [re, make] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const d = make(m);
      if (d && !found.some((f) => Math.abs(f.index - m!.index) < 3)) found.push({ date: d, phrase: m[0], index: m.index });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * The date a letter is dated: a "Paramaribo, 12 oktober 2026"-style line, or
 * the first date near the top.
 */
export function documentDate(text: string, reference: string): string | null {
  const head = text.slice(0, 1500);
  const placed = /(paramaribo|nickerie|albina|lelydorp|moengo|georgetown|den haag|the hague)\s*,?\s*(?:de\s+)?([^\n]{6,30})/i.exec(head);
  if (placed) {
    const d = findDates(placed[2], reference)[0];
    if (d) return d.date;
  }
  const dated = /(datum|date)\s*:?\s*([^\n]{6,30})/i.exec(head);
  if (dated) {
    const d = findDates(dated[2], reference)[0];
    if (d) return d.date;
  }
  return findDates(head, reference)[0]?.date ?? null;
}

/**
 * Deadlines asked for in a letter. Relative periods count from the letter's
 * own date when known, otherwise from `reference`. Working-day periods are
 * returned with their count so the caller can apply the holiday calendar.
 */
export function findDeadlines(text: string, from: string): Deadline[] {
  const out: Deadline[] = [];
  const lower = text.toLowerCase();
  const rel = /\b(?:binnen|within|in de komende|in the next)\s+(\d+|[a-zé]+)\s+(werkdagen|werkdag|working days|business days|dagen|dag|days|day|weken|week|weeks|maanden|maand|months|month)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rel.exec(lower)) !== null) {
    const n = num(m[1]);
    if (!n || n > 365) continue;
    const unit = m[2];
    if (/werkdag|working|business/.test(unit)) {
      out.push({ phrase: text.slice(m.index, m.index + m[0].length), dueDate: addDays(from, Math.ceil(n * 1.4)), kind: 'RELATIVE_WORKING_DAYS', workingDays: n });
    } else {
      const days = /wee?k/.test(unit) ? n * 7 : /maand|month/.test(unit) ? n * 30 : n;
      out.push({ phrase: text.slice(m.index, m.index + m[0].length), dueDate: addDays(from, days), kind: 'RELATIVE_DAYS' });
    }
  }
  const bounded = /\b(uiterlijk|voor|vóór|no later than|before|by|not later than|tot en met|t\/m)\s+(?:op\s+|de\s+|the\s+)?/gi;
  while ((m = bounded.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    const d = findDates(rest, from)[0];
    if (d && d.index < 3) {
      out.push({ phrase: `${m[1]} ${d.phrase}`, dueDate: d.date, kind: 'ABSOLUTE' });
      continue;
    }
    const wd = /^(?:a\.s\.\s+|aanstaande\s+|komende\s+|next\s+)?(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|monday|tuesday|wednesday|thursday|friday)\b/i.exec(rest);
    if (wd) out.push({ phrase: `${m[1]} ${wd[0]}`, dueDate: nextWeekday(from, WEEKDAYS[wd[1].toLowerCase()]), kind: 'WEEKDAY' });
  }
  const seen = new Set<string>();
  return out.filter((d) => {
    const key = `${d.dueDate}|${d.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function nextWeekday(from: string, weekday: number): string {
  const d = new Date(`${from}T12:00:00Z`);
  const delta = ((weekday - d.getUTCDay() + 7) % 7) || 7;
  return addDays(from, delta);
}

/** "morgen", "overmorgen", "volgende week", "vrijdag", a date — for meeting notes and chat. */
export function looseDate(text: string, today: string): string | null {
  const t = text.toLowerCase();
  if (/\bovermorgen\b|day after tomorrow/.test(t)) return addDays(today, 2);
  if (/\bmorgen\b|\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\bvandaag\b|\btoday\b/.test(t)) return today;
  // "Next week" means by the Friday of next week.
  if (/volgende week|next week/.test(t)) {
    const day = new Date(`${today}T12:00:00Z`).getUTCDay();
    return addDays(today, 7 - ((day + 6) % 7) + 4);
  }
  if (/eind(e)? (van )?de week|end of (the )?week/.test(t)) return nextWeekday(today, 5);
  if (/eind(e)? (van )?de maand|end of (the )?month/.test(t)) {
    const d = new Date(`${today}T12:00:00Z`);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  }
  const deadline = findDeadlines(text, today)[0];
  if (deadline) return deadline.dueDate;
  const date = findDates(text, today)[0];
  if (date) return date.date;
  const wd = /\b(maandag|dinsdag|woensdag|donderdag|vrijdag|monday|tuesday|wednesday|thursday|friday)\b/.exec(t);
  if (wd) return nextWeekday(today, WEEKDAYS[wd[1]]);
  return null;
}

export function longDutchDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const names = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  return `${d} ${names[m - 1]} ${y}`;
}
