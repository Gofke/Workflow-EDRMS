/**
 * Reads an incoming letter and proposes what a registration clerk would fill
 * in: subject, sender, the letter's date, the sender's reference, the deadline
 * asked for, a hint about sensitivity, and the requests made in it.
 *
 * Every proposal carries the words it was based on, so the clerk can see why
 * it was suggested and correct it. Nothing is filled in without them.
 */
import { documentDate, findDeadlines, Deadline } from './dates';
import { detectLanguage, excerpt, sentences } from './text';

export interface Proposal<T> {
  value: T;
  confidence: number;
  basis: string;
}

export interface IntakeProposals {
  language: 'nl' | 'en';
  subject: Proposal<string> | null;
  party: Proposal<string> | null;
  documentDate: Proposal<string> | null;
  senderReference: Proposal<string> | null;
  deadlines: (Deadline & { confidence: number })[];
  classification: Proposal<'INTERNAL' | 'CONFIDENTIAL' | 'SECRET'> | null;
  requests: string[];
  wordCount: number;
}

const ORG_WORDS =
  /(ministerie|ministry|korps|politie|police|openbaar ministerie|rechtbank|hof van justitie|court|bureau|stichting|foundation|vereniging|association|inspectie|directoraat|directorate|ambassade|embassy|kabinet|cabinet|gemeente|district|commissariaat|n\.v\.|b\.v\.|bank|universiteit|university|advocatenkantoor|law firm|kantoor|office|raad|council|dienst|service|instituut|institute|penitentiaire|inrichting|centrum|centre|center)/i;

const SUBJECT_LABEL = /^\s*(onderwerp|betreft|betreffende|inzake|subject|re|regarding|ref\.?\s*:?\s*onderwerp)\s*[:.]\s*(.{4,200})$/im;
const REFERENCE_LABEL = /(uw kenmerk|uw ref(?:erentie)?|kenmerk|ons kenmerk|your ref(?:erence)?|our ref(?:erence)?|reference|ref\.|no\.|nr\.|dossiernummer)\s*[:.]?\s*([A-Z0-9][A-Za-z0-9./\-_ ]{2,40})/i;

/** The sender: a signature block, a letterhead line, or a "Van:" line. */
function senderOf(text: string): Proposal<string> | null {
  const from = /^\s*(van|from|afzender|sender)\s*:\s*(.{3,160})$/im.exec(text);
  if (from) {
    const value = from[2].replace(/<[^>]+>/g, '').replace(/["']/g, '').trim();
    if (value) return { value: value.slice(0, 200), confidence: 0.9, basis: from[0].trim() };
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // A letterhead: an organisation name in the first lines.
  for (const line of lines.slice(0, 6)) {
    if (ORG_WORDS.test(line) && line.length <= 90 && !/^(aan|to|t\.a\.v\.|attn)/i.test(line) && !/justitie en politie/i.test(line)) {
      return { value: line.replace(/[,.;]$/, ''), confidence: 0.75, basis: line };
    }
  }
  // A signature: the lines after the closing formula.
  const closing = lines.findIndex((l) => /^(hoogachtend|met vriendelijke groet|met de meeste hoogachting|yours (sincerely|faithfully)|kind regards|sincerely|respectfully)/i.test(l));
  if (closing >= 0) {
    const after = lines.slice(closing + 1, closing + 5).filter((l) => !/^(\[|handtekening|signature|w\.g\.|get\.)/i.test(l));
    const org = after.find((l) => ORG_WORDS.test(l));
    if (org) return { value: org.replace(/[,.;]$/, ''), confidence: 0.8, basis: `${lines[closing]} … ${org}` };
    const name = after.find((l) => /^[A-Z][A-Za-z.\-' ]{2,60}$/.test(l));
    if (name) return { value: name, confidence: 0.6, basis: `${lines[closing]} … ${name}` };
  }
  return null;
}

/** A subject line, or failing that the opening request sentence, shortened. */
function subjectOf(text: string, language: 'nl' | 'en'): Proposal<string> | null {
  const labelled = SUBJECT_LABEL.exec(text);
  if (labelled) return { value: tidySubject(labelled[2]), confidence: 0.95, basis: labelled[0].trim() };
  const mailSubject = /^\s*(subject|onderwerp)\s*:\s*(.+)$/im.exec(text);
  if (mailSubject) return { value: tidySubject(mailSubject[2]), confidence: 0.9, basis: mailSubject[0].trim() };
  const request = sentences(text).find((s) => REQUEST.test(s));
  if (request) {
    const about = /(?:om|voor|over|betreffende|inzake|regarding|for|about|concerning)\s+(.{6,90}?)(?:[.,;]|$)/i.exec(request);
    const value = about ? about[1] : request;
    return { value: tidySubject(capitalise(value)), confidence: 0.55, basis: excerpt(request, 160) };
  }
  const first = sentences(text).find((s) => s.length > 20 && !/^(geachte|dear|beste|aan|to)\b/i.test(s));
  if (first) return { value: tidySubject(first), confidence: 0.35, basis: excerpt(first, 160) };
  return language ? null : null;
}

function tidySubject(s: string): string {
  return s
    .replace(/^(re|fw|fwd|antw|doorst)\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;:,\s]+$/, '')
    .trim()
    .slice(0, 160);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const REQUEST =
  /\b(verzoek(en)?|verzoekt|vraag|vragen|vraagt|wil(len)? graag|zou(den)? (het )?(op prijs stellen|graag)|gelieve|ik verzoek|wij verzoeken|request(s|ing)?|kindly|would like|ask(ing)? (you|for)|please|we would appreciate)\b/i;

function referenceOf(text: string): Proposal<string> | null {
  const m = REFERENCE_LABEL.exec(text);
  if (!m) return null;
  const value = m[2].trim().split(/\s{2,}|\s(?=datum|date|onderwerp|subject)/i)[0].replace(/[.,;]$/, '');
  if (!/\d/.test(value)) return null;
  return { value: value.slice(0, 60), confidence: /kenmerk|ref/i.test(m[1]) ? 0.85 : 0.6, basis: m[0].trim() };
}

function classificationOf(text: string): Proposal<'INTERNAL' | 'CONFIDENTIAL' | 'SECRET'> | null {
  const secret = /\b(staatsgeheim|zeer geheim|geheim|top secret|secret)\b/i.exec(text);
  if (secret && !/geheimhouding(splicht)?/i.test(secret[0])) {
    return { value: 'SECRET', confidence: 0.7, basis: `"${secret[0]}" staat in de tekst` };
  }
  const confidential = /\b(vertrouwelijk|confidential|persoonlijk en vertrouwelijk|privacygevoelig|medisch|medical|strafdossier|personal data|persoonsgegevens)\b/i.exec(text);
  if (confidential) return { value: 'CONFIDENTIAL', confidence: 0.65, basis: `"${confidential[0]}" staat in de tekst` };
  return null;
}

export function extractIntake(text: string, reference: string): IntakeProposals {
  const language = detectLanguage(text);
  const dated = documentDate(text, reference);
  const from = dated ?? reference;
  const deadlines = findDeadlines(text, from).map((d) => ({
    ...d,
    confidence: d.kind === 'ABSOLUTE' ? 0.9 : d.kind === 'WEEKDAY' ? 0.6 : 0.8,
  }));
  return {
    language,
    subject: subjectOf(text, language),
    party: senderOf(text),
    documentDate: dated ? { value: dated, confidence: 0.85, basis: 'datum bovenaan de brief' } : null,
    senderReference: referenceOf(text),
    deadlines,
    classification: classificationOf(text),
    requests: sentences(text)
      .filter((s) => REQUEST.test(s))
      .slice(0, 5)
      .map((s) => excerpt(s, 300)),
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

export { REQUEST };
