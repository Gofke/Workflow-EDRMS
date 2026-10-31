/**
 * Takes personal details out of what a person types before it reaches an
 * external model: e-mail addresses, phone numbers, ID and account numbers.
 * Registration numbers (IN-2026-00012, DOS-2026-0003) and dates are kept — the assistant needs
 * them to look things up — and are protected while the rest is scrubbed.
 */

// Only the system's own numbers: IN-2026-00012 (letters in), UIT- (out), INT- (internal), DOS- (matters), TAAK- (tasks).
const IDENTITY = /\b(?:IN|UIT|INT|DOS|TAAK)-\d{4}-\d{2,8}\b/gi;
const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
const PHONE = /(?:\+|00)?\d[\d\s().-]{5,}\d/g;
// Any run of six or more digits, also glued to letters (FB123456).
const LONG_NUMBER = /\d{6,}/g;

export interface Redaction {
  text: string;
  removed: number;
}

export function redact(input: string, language: 'nl' | 'en' = 'nl'): Redaction {
  const kept: string[] = [];
  const keep = (m: string) => {
    kept.push(m);
    return `\u0000${kept.length - 1}\u0000`;
  };
  let removed = 0;
  const swap = (label: string) => () => {
    removed += 1;
    return label;
  };
  const en = language === 'en';
  let t = input.replace(IDENTITY, keep).replace(DATE, keep);
  t = t
    .replace(EMAIL, swap(en ? '[e-mail address]' : '[e-mailadres]'))
    .replace(IBAN, swap(en ? '[account number]' : '[rekeningnummer]'))
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 6 ? swap(en ? '[number]' : '[nummer]')() : m))
    .replace(LONG_NUMBER, swap(en ? '[number]' : '[nummer]'));
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
  return { text: t, removed };
}
