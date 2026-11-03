/**
 * Text handling for the built-in assistant: tokens, a light Dutch and English
 * stemmer, stop words, sentences and TF-IDF vectors. Deliberately small and
 * deterministic — the same input always gives the same suggestion, which is
 * what a reviewer of an AI suggestion needs.
 */

const STOP_NL = new Set(
  'de het een en van in op te dat die voor met is zijn er aan als bij om ook door naar uit tot over dan maar of wordt worden werd nog wel niet geen deze dit wat wie waar hoe al hun haar hij zij wij u uw ons onze mijn ik je jij men meer zo zou kan kunnen moet moeten heeft hebben had was waren wordt reeds daarom hierbij hiermee waarin waarbij bij betreffende inzake tevens graag wel zeer'.split(' '),
);
const STOP_EN = new Set(
  'the a an and of in on to that this for with is are was were be been by from at as it its or but not no we you your our my i he she they them his her their which who what where how will would can could should may might about into over under than then there here have has had do does did so such also'.split(' '),
);

export function normalise(text: string): string {
  return (text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** A light stemmer: enough to let "verzoeken", "verzoek" and "verzoekt" meet. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 4) return w;
  for (const suffix of ['heden', 'ingen', 'ering', 'ingen', 'ments', 'ment', 'ness', 'ions', 'ion', 'ing', 'ies', 'en', 'es', 'ed', 'er', 'ly', 'st', 'te', 'de', 't', 's', 'e']) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  // Dutch doubled consonant after stripping: "verzoekk" never happens, but "zakk" → "zak".
  if (/([bcdfgklmnprstz])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

export function tokens(text: string, keepStop = false): string[] {
  return normalise(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && (keepStop || (!STOP_NL.has(t) && !STOP_EN.has(t))))
    .filter((t) => !/^\d+$/.test(t) || t.length >= 4);
}

export function stems(text: string): string[] {
  return tokens(text).map(stem);
}

/**
 * Initials ("R."), "N.V." and common Dutch and English abbreviations end in a
 * full stop that does not end the sentence. They are protected while splitting.
 */
const ABBREVIATION =
  /(^|[\s(])((?:i\.v\.m|m\.b\.t|t\.a\.v|z\.s\.m|n\.a\.v|i\.o\.m|e\.g|i\.e|o\.a|d\.d|c\.q|e\.d|e\.a|dhr|mevr|mw|mrs|mr|ms|nr|no|bijv|bv|art|ca|jl|resp|drs|ir|ing|dr|prof|blz|st|vs|zgn|[A-ZÀ-Ý]))\./gi;
const KEEP = '\uE000';

export function sentences(text: string): string[] {
  return (text ?? '')
    .replace(/\r/g, '')
    .replace(ABBREVIATION, (_m, lead: string, word: string) => `${lead}${word.replace(/\./g, KEEP)}${KEEP}`)
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9"“(])|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').replace(/\uE000/g, '.').trim())
    .filter((s) => s.length > 12);
}

const SALUTATION = /^(zeer\s+)?(hoog)?geachte\b|^excellentie\b|^beste\b|^dear\b|^your excellency\b|^mijnheer\b|^mevrouw\b/i;
const CLOSING =
  /^(hoogachtend|met (de meeste )?hoogachting|met (vriendelijke|hartelijke|collegiale) groet(en)?|vriendelijke groet(en)?|yours (sincerely|faithfully|truly)|kind regards|best regards|sincerely)\b/i;
const HEADER_LINE =
  /^(aan|to|ons kenmerk|uw kenmerk|kenmerk|our ref(erence)?|your ref(erence)?|ref\.?|onderwerp|betreft|subject|re|datum|date|bijlage[n]?|enclosures?|cc|kopie|tel(efoon)?|fax|e-?mail|website)\b\s*[:.]?/i;
const PLACE_DATE = /^[A-Z][a-zA-Z-]+,\s+\d{1,2}\s+[a-z]+\s+\d{4}$/;

/**
 * The body of a letter: what stands between the salutation and the closing,
 * without the letterhead, address block, reference lines and signature. Line
 * breaks inside a paragraph become spaces. Text that is not laid out as a
 * letter comes back unchanged apart from dropping obvious header lines.
 */
export function letterBody(text: string): string {
  const lines = (text ?? '').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => SALUTATION.test(l.trim()) && l.trim().length <= 70);
  let body = lines;
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => CLOSING.test(l.trim()));
    body = end >= 0 ? rest.slice(0, end) : rest;
  } else {
    const end = lines.findIndex((l) => CLOSING.test(l.trim()));
    if (end >= 0) body = lines.slice(0, end);
    body = body.filter((l) => !HEADER_LINE.test(l.trim()) && !PLACE_DATE.test(l.trim()));
  }
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (!line) {
      if (current.length) paragraphs.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(' '));
  const joined = paragraphs.join('\n\n').trim();
  return joined || (text ?? '');
}

/** Stems cut to six letters: lets "registreer", "registreren" and "geregistreerd" meet. */
export function roots(text: string): string[] {
  return tokens(text).map((t) => stem(t.replace(/^ge(?=[a-z]{6})/, '')).slice(0, 6));
}

export type Vector = Map<string, number>;

/** Term frequencies, weighted by inverse document frequency when given. */
export function vector(text: string, idf?: Map<string, number>, useRoots = false): Vector {
  const v: Vector = new Map();
  for (const t of useRoots ? roots(text) : stems(text)) v.set(t, (v.get(t) ?? 0) + 1);
  if (idf) for (const [t, n] of v) v.set(t, n * (idf.get(t) ?? Math.log(1 + (idf.size || 1))));
  return v;
}

export function idfOf(documents: string[], useRoots = false): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of documents) for (const t of new Set(useRoots ? roots(d) : stems(d))) df.set(t, (df.get(t) ?? 0) + 1);
  const n = documents.length || 1;
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, Math.log(1 + n / f));
  return idf;
}

export function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, x] of small) {
    const y = large.get(t);
    if (y) dot += x * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Character trigram overlap, for short texts like subjects with typing differences. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = ` ${normalise(s).replace(/[^a-z0-9]+/g, ' ').trim()} `;
    const set = new Set<string>();
    for (let i = 0; i < t.length - 2; i += 1) set.add(t.slice(i, i + 3));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let common = 0;
  for (const g of ga) if (gb.has(g)) common += 1;
  return common / (ga.size + gb.size - common);
}

/** Dutch or English, by which language's common words appear more often. */
export function detectLanguage(text: string): 'nl' | 'en' {
  let nl = 0;
  let en = 0;
  for (const t of tokens(text, true).slice(0, 600)) {
    if (STOP_NL.has(t)) nl += 1;
    if (STOP_EN.has(t)) en += 1;
  }
  return en > nl * 1.2 ? 'en' : 'nl';
}

/** The language of a question, or the fallback when the words do not tell. */
export function detectLanguageOr(text: string, fallback: 'nl' | 'en'): 'nl' | 'en' {
  let nl = 0;
  let en = 0;
  for (const t of tokens(text, true).slice(0, 600)) {
    if (STOP_NL.has(t)) nl += 1;
    if (STOP_EN.has(t)) en += 1;
  }
  if (en === nl) return fallback;
  return en > nl ? 'en' : 'nl';
}

export function excerpt(text: string, max = 240): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Levenshtein distance, bounded, for matching names typed slightly differently. */
export function distance(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  if (Math.abs(x.length - y.length) > 3) return 99;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
  }
  return dp[x.length][y.length];
}
