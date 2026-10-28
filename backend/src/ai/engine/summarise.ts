/**
 * Extractive summaries: the sentences that best represent a text, chosen by
 * how much they share with the rest of it, with a little weight for coming
 * early and for asking or deciding something. The summary therefore only ever
 * contains sentences that are really in the record — nothing is invented.
 */
import { REQUEST } from './extract';
import { cosine, idfOf, letterBody, sentences, vector } from './text';

export interface KeySentence {
  text: string;
  source: string;
  score: number;
}

const DECISION = /\b(besluit|besloten|beslissing|goedgekeurd|afgewezen|toegewezen|akkoord|decided|decision|approved|rejected|granted|refused)\b/i;
const BOILERPLATE = /^(geachte|dear|hoogachtend|met vriendelijke groet|yours sincerely|kind regards|bijlage|enclosure|pagina \d|page \d)/i;

export function keySentences(sources: { text: string; source: string }[], max = 5): KeySentence[] {
  const all: { text: string; source: string; position: number }[] = [];
  for (const s of sources) {
    sentences(letterBody(s.text)).forEach((text, position) => {
      if (!BOILERPLATE.test(text) && text.length <= 600) all.push({ text, source: s.source, position });
    });
  }
  if (!all.length) return [];
  const idf = idfOf(all.map((s) => s.text));
  const vectors = all.map((s) => vector(s.text, idf));
  const centroid = new Map<string, number>();
  for (const v of vectors) for (const [t, x] of v) centroid.set(t, (centroid.get(t) ?? 0) + x);
  const scored = all.map((s, i) => {
    let score = cosine(vectors[i], centroid);
    if (s.position === 0) score += 0.08;
    else if (s.position < 3) score += 0.04;
    if (REQUEST.test(s.text)) score += 0.12;
    if (DECISION.test(s.text)) score += 0.12;
    if (s.text.length < 40) score -= 0.08;
    return { text: s.text, source: s.source, score: Math.round(score * 1000) / 1000 };
  });
  // Pick the best, skipping sentences that say nearly the same as one already picked.
  const picked: KeySentence[] = [];
  const pickedVectors: Map<string, number>[] = [];
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    const v = vector(s.text, idf);
    if (pickedVectors.some((p) => cosine(p, v) > 0.6)) continue;
    picked.push(s);
    pickedVectors.push(v);
    if (picked.length >= max) break;
  }
  // Keep the order in which they appear in the record.
  const order = new Map(all.map((s, i) => [s.text, i]));
  return picked.sort((a, b) => (order.get(a.text) ?? 0) - (order.get(b.text) ?? 0));
}
