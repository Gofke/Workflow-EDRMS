/**
 * A plain-language question to a structured query.
 *
 *   "Hoeveel zaken zijn over termijn?"
 *   "Welke brieven van de Politie kwamen deze maand binnen?"
 *   "Mijn taken die deze week aflopen"
 *   "Show urgent tasks"   "Letters about overplaatsing since 1 September"
 *
 * The result says, in words, how the question was understood. The query is
 * then run by the service through the permission evaluator — the parser only
 * decides what to ask for, never what may be seen.
 */
import { findDates } from './dates';
import { normalise } from './text';

export type AskEntity = 'TASK' | 'ITEM' | 'DOSSIER';

export interface AskQuery {
  entity: AskEntity;
  count: boolean;
  mine: boolean;
  overdue: boolean;
  dueSoon: boolean;
  from: string | null;
  to: string | null;
  direction: 'INCOMING' | 'OUTGOING' | 'INTERNAL' | null;
  party: string | null;
  about: string | null;
  status: 'OPEN' | 'DONE' | 'REVIEW' | null;
  priority: 'HIGH' | 'URGENT' | null;
  classification: 'CONFIDENTIAL' | 'SECRET' | null;
  understood: string[];
  language: 'nl' | 'en';
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

const MONTHS_NL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function looksLikeDataQuestion(text: string): boolean {
  const t = normalise(text);
  const entity = /\b(taak|taken|task|tasks|brief|brieven|post|stuk|stukken|letter|letters|correspondentie|correspondence|zaak|zaken|dossier|dossiers|matter|matters|case|cases|mail)\b/.test(t);
  const asking = /\b(hoeveel|welke|wat zijn|toon|laat .* zien|lijst|overzicht van|zoek|vind|geef|how many|which|what are|show|list|find|give me|search)\b/.test(t);
  return entity && (asking || /\?$/.test(text.trim()) || /^(mijn|my)\b/.test(t));
}

export function parseQuestion(question: string, today: string, language: 'nl' | 'en'): AskQuery {
  const raw = question.trim();
  const t = normalise(raw);
  const understood: string[] = [];
  const en = language === 'en';
  let entity: AskEntity = 'ITEM';
  if (/\b(taak|taken|task|tasks|actie|acties|to ?do)\b/.test(t)) entity = 'TASK';
  else if (/\b(zaak|zaken|dossier|dossiers|matter|matters|case|cases)\b/.test(t)) entity = 'DOSSIER';
  understood.push(en ? { TASK: 'tasks', ITEM: 'letters', DOSSIER: 'matters' }[entity] : { TASK: 'taken', ITEM: 'brieven en stukken', DOSSIER: 'zaken' }[entity]);

  const count = /\b(hoeveel|aantal|how many|number of|count)\b/.test(t);
  const mine = /\b(mijn|my|mine|ik|me|i)\b/.test(t) && !/\b(i\.v\.m\.|ik wil weten)\b/.test(t);
  if (mine) understood.push(en ? 'yours' : 'van u');

  const overdue = /\b(over termijn|over de termijn|te laat|verlopen|achterstallig|overdue|late|past due|missed)\b/.test(t);
  if (overdue) understood.push(en ? 'past their deadline' : 'over termijn');
  const dueSoon = !overdue && /\b(aflopen|verloopt|vervalt|termijn deze week|due (this|next) week|due soon|binnenkort|deadline)\b/.test(t);

  let from: string | null = null;
  let to: string | null = null;
  const period = (f: string, tt: string, label: string) => {
    from = f;
    to = tt;
    understood.push(label);
  };
  if (/\b(vandaag|today)\b/.test(t)) period(today, today, en ? 'today' : 'vandaag');
  else if (/\b(gisteren|yesterday)\b/.test(t)) period(addDays(today, -1), addDays(today, -1), en ? 'yesterday' : 'gisteren');
  else if (/\b(deze week|this week)\b/.test(t)) period(monday(today), addDays(monday(today), 6), en ? 'this week' : 'deze week');
  else if (/\b(vorige week|last week)\b/.test(t)) period(addDays(monday(today), -7), addDays(monday(today), -1), en ? 'last week' : 'vorige week');
  else if (/\b(deze maand|this month)\b/.test(t)) period(`${today.slice(0, 7)}-01`, today, en ? 'this month' : 'deze maand');
  else if (/\b(vorige maand|last month)\b/.test(t)) {
    const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const start = d.toISOString().slice(0, 10);
    period(start, addDays(`${today.slice(0, 7)}-01`, -1), en ? 'last month' : 'vorige maand');
  } else if (/\b(dit jaar|this year)\b/.test(t)) period(`${today.slice(0, 4)}-01-01`, today, en ? 'this year' : 'dit jaar');
  else {
    const month = MONTHS_NL.findIndex((m) => new RegExp(`\\bin ${m}\\b`).test(t));
    const monthEn = MONTHS_EN.findIndex((m) => new RegExp(`\\bin ${m}\\b`).test(t));
    const m = month >= 0 ? month : monthEn;
    if (m >= 0) {
      let year = Number(today.slice(0, 4));
      if (m + 1 > Number(today.slice(5, 7))) year -= 1;
      const start = `${year}-${String(m + 1).padStart(2, '0')}-01`;
      const end = new Date(Date.UTC(year, m + 1, 0)).toISOString().slice(0, 10);
      period(start, end, en ? `in ${MONTHS_EN[m]} ${year}` : `in ${MONTHS_NL[m]} ${year}`);
    } else {
      const since = /\b(sinds|vanaf|na|since|after|from)\s+(.{4,24})/.exec(raw);
      const d = since ? findDates(since[2], today)[0] : null;
      if (d) {
        from = d.date;
        understood.push(en ? `since ${d.date}` : `sinds ${d.date}`);
      }
      const until = /\b(tot|voor|before|until)\s+(.{4,24})/.exec(raw);
      const u = until ? findDates(until[2], today)[0] : null;
      if (u) {
        to = u.date;
        understood.push(en ? `until ${u.date}` : `tot ${u.date}`);
      }
    }
  }

  let direction: AskQuery['direction'] = null;
  if (/\b(inkomend|inkomende|binnengekomen|ontvangen|kwamen .* binnen|incoming|received)\b/.test(t)) direction = 'INCOMING';
  else if (/\b(uitgaand|uitgaande|verzonden|verstuurd|outgoing|sent)\b/.test(t)) direction = 'OUTGOING';
  else if (/\b(intern|interne|internal)\b/.test(t)) direction = 'INTERNAL';
  if (direction && entity === 'ITEM') understood.push(en ? direction.toLowerCase() : { INCOMING: 'inkomend', OUTGOING: 'uitgaand', INTERNAL: 'intern' }[direction]);

  // "van de Politie", "from the Police" — a sender, not a person's own work.
  let party: string | null = null;
  const fromParty = /\b(?:van|afkomstig van|from|sent by)\s+(?:de\s+|het\s+|the\s+)?([A-Za-zÀ-ÿ][\wÀ-ÿ.\- ]{2,60}?)(?=\s+(?:die|dat|deze|die|over|in|sinds|vanaf|this|that|which|about|since|kwamen|zijn|is|are|were|binnen|received)\b|[?.!,]|$)/i.exec(raw);
  if (fromParty && entity !== 'TASK' && !/^(mij|me|deze|vorige|this|last|vandaag|today)\b/i.test(fromParty[1])) {
    party = fromParty[1].trim();
    understood.push(en ? `from "${party}"` : `van "${party}"`);
  }

  let about: string | null = null;
  const aboutMatch = /\b(?:over|betreffende|inzake|met onderwerp|about|regarding|concerning|on the subject of|zoek|search for|find)\s+(?:de\s+|het\s+|een\s+|the\s+|a\s+)?["“]?([^"”?]{3,80}?)["”]?(?=\s+(?:die|dat|van|from|sinds|since|in|deze|this|zijn|is|er|werden|waren|kwamen|verstuurd|ontvangen|binnengekomen|are|were|was|sent|received|that|which)\b|[?.!]|$)/i.exec(raw);
  if (aboutMatch && !/^(termijn|deadline)\b/i.test(aboutMatch[1])) {
    about = aboutMatch[1].trim();
    understood.push(en ? `about "${about}"` : `over "${about}"`);
  }

  let status: AskQuery['status'] = null;
  if (/\b(afgerond|afgehandeld|klaar|gereed|voltooid|completed|done|finished|closed)\b/.test(t)) status = 'DONE';
  else if (/\b(ter beoordeling|ter goedkeuring|wacht(en)? op (goedkeuring|besluit|beslissing)|under review|awaiting (approval|decision)|for approval)\b/.test(t)) status = 'REVIEW';
  else if (/\b(open|lopend|lopende|openstaand|openstaande|nog niet af|pending|outstanding)\b/.test(t) || overdue || dueSoon) status = 'OPEN';
  if (status) understood.push(en ? { OPEN: 'open', DONE: 'completed', REVIEW: 'under review' }[status] : { OPEN: 'open', DONE: 'afgerond', REVIEW: 'ter beoordeling' }[status]);

  let priority: AskQuery['priority'] = null;
  if (/\b(spoed|urgent|dringend)\b/.test(t)) priority = 'URGENT';
  else if (/\b(hoge prioriteit|belangrijk|high priority|important)\b/.test(t)) priority = 'HIGH';
  if (priority) understood.push(priority.toLowerCase());

  let classification: AskQuery['classification'] = null;
  if (/\b(geheim|secret)\b/.test(t)) classification = 'SECRET';
  else if (/\b(vertrouwelijk|vertrouwelijke|confidential)\b/.test(t)) classification = 'CONFIDENTIAL';

  if (dueSoon) understood.push(en ? 'due within 7 days' : 'termijn binnen 7 dagen');
  return { entity, count, mine, overdue, dueSoon, from, to, direction, party, about, status, priority, classification, understood, language };
}
