import { Language } from './prefs';

const MONTHS_NL = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTHS_LONG_NL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Today in Suriname (UTC−3), as YYYY-MM-DD. */
export function today(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parts(value: string): { y: number; m: number; d: number } {
  const iso = value.length > 10 ? new Date(new Date(value).getTime() - 3 * 3600_000).toISOString().slice(0, 10) : value;
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** 28 okt 2026 */
export function date(value: string | null | undefined, lang: Language = 'nl'): string {
  if (!value) return '—';
  const { y, m, d } = parts(value);
  return lang === 'en' ? `${d} ${MONTHS_EN[m - 1]} ${y}` : `${d} ${MONTHS_NL[m - 1]} ${y}`;
}

export function longDate(value: string | null | undefined, lang: Language = 'nl'): string {
  if (!value) return '—';
  const { y, m, d } = parts(value);
  return lang === 'en' ? `${d} ${MONTHS_LONG_EN[m - 1]} ${y}` : `${d} ${MONTHS_LONG_NL[m - 1]} ${y}`;
}

/** 28 okt 2026, 14:05 (Suriname time) */
export function dateTime(value: string | null | undefined, lang: Language = 'nl'): string {
  if (!value) return '—';
  const local = new Date(new Date(value).getTime() - 3 * 3600_000);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${date(value, lang)}, ${hh}:${mm}`;
}

/** "vandaag", "gisteren", "3 dagen geleden", or a date. */
export function ago(value: string | null | undefined, lang: Language = 'nl'): string {
  if (!value) return '—';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  const en = lang === 'en';
  if (minutes < 1) return en ? 'just now' : 'zojuist';
  if (minutes < 60) return en ? `${minutes} min ago` : `${minutes} min geleden`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return en ? `${hours} h ago` : `${hours} uur geleden`;
  const days = Math.round(hours / 24);
  if (days === 1) return en ? 'yesterday' : 'gisteren';
  if (days < 7) return en ? `${days} days ago` : `${days} dagen geleden`;
  return date(value, lang);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

export function dueLabel(due: string | null | undefined, lang: Language = 'nl'): { text: string; tone: '' | 'soon' | 'late' } {
  if (!due) return { text: lang === 'en' ? 'no deadline' : 'geen termijn', tone: '' };
  const n = daysBetween(today(), due.slice(0, 10));
  const en = lang === 'en';
  // Past the deadline: say since when, not a count of days (the server counts working days; this screen should not contradict it).
  if (n < 0) return { text: en ? `overdue since ${shortDate(due, lang)}` : `te laat sinds ${shortDate(due, lang)}`, tone: 'late' };
  if (n === 0) return { text: en ? 'due today' : 'vandaag', tone: 'soon' };
  if (n === 1) return { text: en ? 'tomorrow' : 'morgen', tone: 'soon' };
  if (n <= 5) return { text: en ? `in ${n} days` : `over ${n} dagen`, tone: 'soon' };
  return { text: date(due, lang), tone: '' };
}

export function initials(name: string): string {
  const words = name.replace(/[^A-Za-zÀ-ÿ\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  if (!words.length) return '?';
  const last = words[words.length - 1];
  const first = words.length > 1 ? words[0] : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function bytes(n: number | string): string {
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} kB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A day and month only: "5 okt". */
export function shortDate(value: string, lang: Language = 'nl'): string {
  return date(value, lang).replace(/ \d{4}$/, '');
}

/** A number the way the reader writes it: 7,5 in Dutch, 7.5 in English. */
export function num(n: number | null | undefined, lang: Language = 'nl', digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(lang === 'en' ? 'en-GB' : 'nl-NL', { maximumFractionDigits: digits });
}
