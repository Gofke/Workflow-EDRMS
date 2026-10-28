/**
 * Meeting notes to proposed tasks. Each line that reads like an action becomes
 * a proposal with a title, a person (matched against the people in the
 * system), a due date and a priority. Proposals are never created as tasks
 * until a person confirms them.
 */
import { looseDate } from './dates';
import { distance, normalise } from './text';

export interface Person {
  accountId: string;
  name: string;
}

export interface ActionProposal {
  line: number;
  original: string;
  title: string;
  assignee: Person | null;
  assigneeText: string | null;
  dueDate: string | null;
  priority: 'MEDIUM' | 'HIGH' | 'URGENT';
  confidence: number;
}

const ACTION_LINE =
  /^(\s*[-*•–]\s*|\s*\d+[.)]\s*|\s*(actie|actiepunt|ap|todo|to do|action|action item)\s*[:\-–]\s*)|\b(zal|zullen|moet|moeten|gaat|gaan|neemt contact op|stuurt|bereidt .* voor|wordt gevraagd|wordt verzocht|regelt|zorgt voor|will|is to|needs to|must|to send|to prepare|follow up|takes care of)\b/i;

const NOT_ACTION = /^(aanwezig|afwezig|notulen|agenda|present|absent|minutes|datum|date|locatie|location|voorzitter|chair)\b/i;

/** "Sardjoe", "M. Sardjoe", "mevr. Amatredjo", "@Pawironadi", "ik". */
function findPerson(line: string, people: Person[], me: Person): { person: Person | null; text: string | null } {
  if (/^(?:[-*•–]\s*|\d+[.)]\s*)?(?:actie\s*[:\-–]\s*)?(ik|i)\b|\b(ik zal|i will|ikzelf|myself)\b/i.test(line)) return { person: me, text: 'ik' };
  const words = line.replace(/[@():,;]/g, ' ').split(/\s+/).filter(Boolean);
  let best: { person: Person; d: number; text: string } | null = null;
  for (const person of people) {
    const parts = normalise(person.name).replace(/\./g, ' ').split(/\s+/).filter((p) => p.length > 2);
    const last = parts[parts.length - 1];
    if (!last) continue;
    for (const w of words) {
      if (w.length < 3 || !/^[A-Z@]/.test(w)) continue;
      const d = distance(w, last);
      if (d <= (last.length > 6 ? 1 : 0) && (!best || d < best.d)) best = { person, d, text: w };
    }
  }
  if (best) return { person: best.person, text: best.text };
  const named = /^(?:[-*•–]\s*)?(?:actie\s*[:\-–]?\s*)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*(?:[:\-–]|zal|will|moet)/.exec(line.trim());
  return { person: null, text: named ? named[1] : null };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleOf(line: string, assigneeText: string | null): string {
  let t = line
    .replace(/^\s*[-*•–]\s*|^\s*\d+[.)]\s*/, '')
    .replace(/^(actie|actiepunt|ap|todo|to do|action|action item)\s*[:\-–]\s*/i, '')
    .replace(/^(actie|actiepunt|action)\s+(?=[A-Z@])/i, '')
    .replace(/\b(uiterlijk|vóór|voor|before|by|no later than)\s+(\d{1,2}\s+\w+(\s+\d{4})?|\d{1,2}[-/.]\d{1,2}([-/.]\d{2,4})?|maandag|dinsdag|woensdag|donderdag|vrijdag|monday|tuesday|wednesday|thursday|friday|morgen|tomorrow)\b/gi, '')
    .replace(/\b(volgende week|next week|deze week|this week|morgen|overmorgen|tomorrow|vandaag|today|z\.s\.m\.|zsm|asap|spoed|urgent)\b/gi, '')
    .replace(/\(\s*\)/g, '');
  // "Sardjoe: …" and "@Sardjoe …" lose the name; "Sardjoe belt …" keeps it, it reads as a sentence.
  if (assigneeText) t = t.replace(new RegExp(`^\\s*(@${escape(assigneeText)}\\s*[:\-–]?|${escape(assigneeText)}\\s*[:\-–])\\s*`, 'i'), '');
  t = t
    .replace(/^(zal|will|moet|gaat|is to|needs to|must)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:.\-–]+$/, '')
    .trim();
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 200);
}

export function proposeActions(notes: string, people: Person[], me: Person, today: string): ActionProposal[] {
  const out: ActionProposal[] = [];
  notes.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line.length < 8 || NOT_ACTION.test(line) || !ACTION_LINE.test(raw)) return;
    const { person, text } = findPerson(line, people, me);
    const title = titleOf(line, text);
    if (title.length < 4) return;
    const urgent = /\b(spoed|urgent|z\.s\.m\.|zsm|asap|onmiddellijk|immediately)\b/i.test(line);
    const high = /\b(belangrijk|prioriteit|important|priority)\b/i.test(line);
    const dueDate = looseDate(line, today);
    let confidence = 0.5;
    if (person) confidence += 0.25;
    if (dueDate) confidence += 0.15;
    if (/^(\s*[-*•–]|\s*(actie|action|todo))/i.test(raw)) confidence += 0.1;
    out.push({
      line: index + 1,
      original: line.slice(0, 400),
      title,
      assignee: person,
      assigneeText: text,
      dueDate: dueDate && dueDate >= today ? dueDate : null,
      priority: urgent ? 'URGENT' : high ? 'HIGH' : 'MEDIUM',
      confidence: Math.min(0.95, Math.round(confidence * 100) / 100),
    });
  });
  return out.slice(0, 40);
}
