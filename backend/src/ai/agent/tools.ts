/**
 * The assistant's tools. All read-only.
 *
 * Security in three of the four layers lives here (the fourth, sign-in and
 * role, is the controller's guard):
 *   - the tool list is filtered by role before the model sees it (toolsFor);
 *   - every call is checked again against the role before it runs (runTool),
 *     and every query applies the record permissions (AccessService, the one
 *     source of truth) AND the person's line of command;
 *   - results are minimal: what goes back to the model is metadata only —
 *     references, statuses, dates, units, handler names, counts. Subjects,
 *     senders, document text and summaries go to the person as cards, by the
 *     server, never through the model. Confidential and secret records are left
 *     out of every count, group and list the model receives; looked up by
 *     number, one appears only as "restricted".
 *
 * Lists are capped; the true total is always given. No match is {found:false};
 * not allowed is {error}.
 */
import { DataSource } from 'typeorm';
import { AccessProfile, AccessService, LineScope } from '../../access/access.service';
import { BUSINESS_ROLES } from '../../common/actor';
import { Actor } from '../../records/registration.service';
import { WorkingDaysService, addDays } from '../../core/working-days.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { TasksService } from '../../tasks/tasks.service';
import type { ProjectsService } from '../../projects/projects.service';
import { PROJECT_TOOLS } from './project-tools';
import { BUILD_VERSION } from '../../version';
import { AiService } from '../ai.service';
import { Card } from '../chat.service';
import { HELP, searchHelp } from '../engine/help';
import { Schema, ToolDeclaration } from './types';

export interface ToolContext {
  db: DataSource;
  access: AccessService;
  tasks: TasksService;
  projects: ProjectsService;
  dashboard: DashboardService;
  ai: AiService;
  workingDays: WorkingDaysService;
  actor: Actor;
  profile: AccessProfile;
  line: LineScope;
  language: 'nl' | 'en';
  today: string;
  dataPolicy: 'metadata' | 'records';
  /** Cards for the panel, added by tools; never sent to the model. */
  cards: Card[];
  /** For the status tool: the model in use (no key). */
  engine: { provider: string; model: string };
}

export type ToolOutput = Record<string, unknown>;

export interface ToolSpec extends ToolDeclaration {
  roles: string[];
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutput>;
}

const BUSINESS = [...BUSINESS_ROLES];
const RESTRICTED = ['CONFIDENTIAL', 'SECRET'];
const CAP = 10;

// ------------------------------------------------------------------ helpers

class Sql {
  readonly params: unknown[] = [];
  readonly where: string[] = [];
  add(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  pred(p: { sql: string; params: unknown[] }, build: (next: number) => { sql: string; params: unknown[] }): void {
    void p;
    const r = build(this.params.length + 1);
    this.params.push(...r.params);
    this.where.push(r.sql);
  }
  get clause(): string {
    return this.where.length ? this.where.join(' AND ') : 'true';
  }
}

function str(v: unknown, max = 120): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function isoDate(v: unknown): string | null {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function dmy(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

const LABELS: Record<string, { nl: string; en: string }> = {
  OPEN: { nl: 'open', en: 'open' },
  CLOSED: { nl: 'gesloten', en: 'closed' },
  ACTIVE: { nl: 'in behandeling', en: 'in progress' },
  UNDER_REVIEW: { nl: 'ter beoordeling', en: 'under review' },
  RETURNED: { nl: 'teruggestuurd', en: 'returned' },
  FINALISED: { nl: 'afgerond', en: 'finalised' },
  DRAFT: { nl: 'concept', en: 'draft' },
  REGISTERED: { nl: 'geregistreerd', en: 'registered' },
  ACCEPTED: { nl: 'geaccepteerd', en: 'accepted' },
  IN_PROGRESS: { nl: 'in uitvoering', en: 'in progress' },
  WAITING: { nl: 'wachtend', en: 'waiting' },
  IN_REVIEW: { nl: 'ter controle', en: 'in review' },
  COMPLETED: { nl: 'voltooid', en: 'completed' },
  CANCELLED: { nl: 'geannuleerd', en: 'cancelled' },
  REJECTED: { nl: 'afgewezen', en: 'rejected' },
  INCOMING: { nl: 'inkomend', en: 'incoming' },
  OUTGOING: { nl: 'uitgaand', en: 'outgoing' },
  INTERNAL: { nl: 'intern', en: 'internal' },
  URGENT: { nl: 'spoed', en: 'urgent' },
  HIGH: { nl: 'hoog', en: 'high' },
  MEDIUM: { nl: 'normaal', en: 'normal' },
  LOW: { nl: 'laag', en: 'low' },
};

function label(ctx: ToolContext, code: string | null): string | null {
  if (!code) return null;
  return LABELS[code]?.[ctx.language] ?? code.toLowerCase().replace(/_/g, ' ');
}

async function daysLeft(ctx: ToolContext, due: string | null): Promise<number | null> {
  if (!due) return null;
  return ctx.workingDays.workingDaysBetween(ctx.today, due.slice(0, 10));
}

/** Monday-based periods in Suriname time. */
export function periodRange(period: string, today: string): { from: string; to: string } | null {
  const d = new Date(`${today}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  const [y, m] = today.split('-').map(Number);
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const lastOf = (yy: number, mm: number) => addDays(mm === 12 ? first(yy + 1, 1) : first(yy, mm + 1), -1);
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'this_week':
      return { from: monday, to: addDays(monday, 6) };
    case 'last_week':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'this_month':
      return { from: first(y, m), to: lastOf(y, m) };
    case 'last_month':
      return m === 1 ? { from: first(y - 1, 12), to: lastOf(y - 1, 12) } : { from: first(y, m - 1), to: lastOf(y, m - 1) };
    case 'this_year':
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    default:
      return null;
  }
}

async function resolveUnit(ctx: ToolContext, text: string): Promise<{ id: string; name: string } | { error: string } | { found: false } | { ambiguous: string[] }> {
  const match = `is_active AND (upper(code) = upper($1) OR name ILIKE '%' || $1 || '%')`;
  const rows: { id: string; name: string; exact: boolean }[] = await ctx.db.query(
    `SELECT id, name, upper(code) = upper($1) OR lower(name) = lower($1) AS exact FROM organisational_unit
      WHERE ${match} ${ctx.line.all ? '' : 'AND id = ANY($2::uuid[])'}
      ORDER BY 3 DESC, length(name) LIMIT 6`,
    ctx.line.all ? [text] : [text, ctx.line.unitIds],
  );
  if (rows.length === 1 || rows[0]?.exact) return { id: rows[0].id, name: rows[0].name };
  if (rows.length > 1) return { ambiguous: rows.map((r) => r.name) };
  // Units are part of the published organisation chart, so saying a unit lies outside the line reveals nothing.
  const [elsewhere] = await ctx.db.query(`SELECT 1 FROM organisational_unit WHERE ${match} LIMIT 1`, [text]);
  return elsewhere ? { error: 'That unit is outside your line of command.' } : { found: false };
}

async function resolvePerson(ctx: ToolContext, text: string): Promise<{ id: string; name: string } | { found: false } | { ambiguous: string[] }> {
  const q = new Sql();
  const t = q.add(text);
  q.where.push(`a.is_enabled AND p.full_name ILIKE '%' || ${t} || '%'`);
  q.pred({ sql: '', params: [] }, (n) => ctx.access.lineAccountPredicate(ctx.line, 'a', n));
  const rows: { id: string; full_name: string }[] = await ctx.db.query(
    `SELECT a.id, p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE ${q.clause} ORDER BY p.full_name LIMIT 6`,
    q.params,
  );
  if (rows.length === 1) return { id: rows[0].id, name: rows[0].full_name };
  if (rows.length > 1) {
    const exact = rows.find((r) => r.full_name.toLowerCase() === text.toLowerCase());
    if (exact) return { id: exact.id, name: exact.full_name };
    return { ambiguous: rows.map((r) => r.full_name) };
  }
  // Whether someone of that name works elsewhere is not the person's business.
  return { found: false };
}

type Kind = 'letters' | 'matters' | 'tasks';

/** Permission + line predicates for one kind of record. */
function scoped(ctx: ToolContext, kind: Kind, q: Sql): void {
  if (kind === 'letters') {
    q.pred({ sql: '', params: [] }, (n) => ctx.access.itemPredicate(ctx.profile, 'ci', n));
    q.pred({ sql: '', params: [] }, (n) => ctx.access.lineItemPredicate(ctx.profile, ctx.line, 'ci', n));
    q.where.push(`ci.state IN ('DRAFT','REGISTERED')`);
  } else if (kind === 'matters') {
    q.pred({ sql: '', params: [] }, (n) => ctx.access.dossierPredicate(ctx.profile, 'd', n));
    q.pred({ sql: '', params: [] }, (n) => ctx.access.lineDossierPredicate(ctx.profile, ctx.line, 'd', n));
  } else {
    q.pred({ sql: '', params: [] }, (n) => ctx.tasks.visibility(ctx.profile, n, 't'));
    if (!ctx.line.all) {
      const units = q.add(ctx.line.unitIds);
      const me = q.add(ctx.profile.accountId);
      q.where.push(`(EXISTS (SELECT 1 FROM account la WHERE la.id = t.assignee_account_id AND la.organisational_unit_id = ANY(${units}::uuid[]))
        OR t.created_by_account_id = ${me} OR t.owner_account_id = ${me} OR t.assignee_account_id = ${me}
        OR EXISTS (SELECT 1 FROM task_audience lta WHERE lta.task_id = t.id AND lta.account_id = ${me}))`);
    }
    q.where.push('t.archived_at IS NULL');
  }
}

const FROM: Record<Kind, string> = {
  letters: `correspondence_item ci LEFT JOIN organisational_unit ou ON ou.id = ci.owning_unit_id`,
  matters: `dossier d LEFT JOIN organisational_unit ou ON ou.id = d.owning_unit_id
            LEFT JOIN dossier_category dc ON dc.id = d.category_id
            LEFT JOIN responsibility_assignment ra ON ra.dossier_id = d.id AND ra.superseded_at IS NULL
            LEFT JOIN account ha ON ha.id = ra.responsible_account_id LEFT JOIN person hp ON hp.id = ha.person_id`,
  tasks: `task t LEFT JOIN account aa ON aa.id = t.assignee_account_id LEFT JOIN person ap ON ap.id = aa.person_id
          LEFT JOIN organisational_unit ou ON ou.id = aa.organisational_unit_id
          LEFT JOIN dossier td ON td.id = t.dossier_id LEFT JOIN correspondence_item tci ON tci.id = t.correspondence_item_id`,
};

/** A ticket of a confidential project: as restricted as a confidential record. */
const CONFIDENTIAL_TICKET = `EXISTS (SELECT 1 FROM project_milestone pm_c JOIN project p_c ON p_c.id = pm_c.project_id
                                      WHERE pm_c.id = t.project_milestone_id AND p_c.classification = 'CONFIDENTIAL')`;

/** Confidential and secret records: the model never gets them, not even as a count under a filter. */
const IS_RESTRICTED: Record<Kind, string> = {
  letters: `ci.classification IN ('CONFIDENTIAL','SECRET')`,
  matters: `d.classification IN ('CONFIDENTIAL','SECRET')`,
  tasks: `(coalesce(td.classification, '') IN ('CONFIDENTIAL','SECRET') OR coalesce(tci.classification, '') IN ('CONFIDENTIAL','SECRET') OR ${CONFIDENTIAL_TICKET})`,
};

const LETTER_DATE = `(coalesce(ci.registered_at, ci.created_at) AT TIME ZONE 'America/Paramaribo')::date`;
const NO_REPLY = `NOT EXISTS (SELECT 1 FROM correspondence_item r WHERE r.in_reply_to_item_id = ci.id AND r.state = 'REGISTERED')`;
const TASK_OPEN = `t.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW')`;

interface Filters {
  filter: string;
  unit?: { id: string; name: string };
  person?: { id: string; name: string };
  from?: string | null;
  to?: string | null;
  direction?: string | null;
  mine?: boolean;
}

function applyFilters(ctx: ToolContext, kind: Kind, q: Sql, f: Filters): void {
  // Added only when used: PostgreSQL refuses parameters a query does not reference.
  let todayParam: string | null = null;
  const lazy = { toString: () => (todayParam ??= q.add(ctx.today)) };
  const today = lazy as unknown as string;
  if (kind === 'letters') {
    switch (f.filter) {
      case 'open':
      case 'awaiting_reply':
        q.where.push(`ci.direction = 'INCOMING' AND ci.state = 'REGISTERED' AND ci.reply_requested_by IS NOT NULL AND ${NO_REPLY}`);
        break;
      case 'overdue':
        q.where.push(`ci.direction = 'INCOMING' AND ci.state = 'REGISTERED' AND ci.reply_requested_by < ${today}::date AND ${NO_REPLY}`);
        break;
      case 'due_this_week':
        q.where.push(`ci.direction = 'INCOMING' AND ci.state = 'REGISTERED' AND ci.reply_requested_by BETWEEN ${today}::date AND ${today}::date + 7 AND ${NO_REPLY}`);
        break;
      case 'drafts':
        q.where.push(`ci.state = 'DRAFT'`);
        break;
      case 'closed':
        q.where.push(`ci.state = 'REGISTERED' AND NOT (ci.direction = 'INCOMING' AND ci.reply_requested_by IS NOT NULL AND ${NO_REPLY})`);
        break;
      default:
        break;
    }
    if (f.direction) q.where.push(`ci.direction = ${q.add(f.direction)}`);
    if (f.unit) q.where.push(`ci.owning_unit_id = ${q.add(f.unit.id)}`);
    if (f.person) q.where.push(`ci.created_by_account_id = ${q.add(f.person.id)}`);
    if (f.mine) q.where.push(`ci.created_by_account_id = ${q.add(ctx.profile.accountId)}`);
    if (f.from) q.where.push(`${LETTER_DATE} >= ${q.add(f.from)}::date`);
    if (f.to) q.where.push(`${LETTER_DATE} <= ${q.add(f.to)}::date`);
  } else if (kind === 'matters') {
    switch (f.filter) {
      // The same definitions as the dashboards: a finalised matter is no longer open work.
      case 'open':
        q.where.push(`d.state <> 'CLOSED' AND d.processing_state <> 'FINALISED'`);
        break;
      case 'closed':
        q.where.push(`d.state = 'CLOSED'`);
        break;
      case 'overdue':
        q.where.push(`d.state <> 'CLOSED' AND d.processing_state NOT IN ('APPROVED','FINALISED') AND d.due_date < ${today}::date`);
        break;
      case 'due_this_week':
        q.where.push(`d.state <> 'CLOSED' AND d.processing_state NOT IN ('APPROVED','FINALISED') AND d.due_date BETWEEN ${today}::date AND ${today}::date + 7`);
        break;
      case 'awaiting_decision':
        q.where.push(`d.state = 'OPEN' AND d.processing_state = 'UNDER_REVIEW'`);
        break;
      default:
        break;
    }
    if (f.unit) q.where.push(`d.owning_unit_id = ${q.add(f.unit.id)}`);
    if (f.person) q.where.push(`ra.responsible_account_id = ${q.add(f.person.id)}`);
    if (f.mine) q.where.push(`ra.responsible_account_id = ${q.add(ctx.profile.accountId)}`);
    if (f.from) q.where.push(`(d.created_at AT TIME ZONE 'America/Paramaribo')::date >= ${q.add(f.from)}::date`);
    if (f.to) q.where.push(`(d.created_at AT TIME ZONE 'America/Paramaribo')::date <= ${q.add(f.to)}::date`);
  } else {
    switch (f.filter) {
      case 'open':
        q.where.push(TASK_OPEN);
        break;
      case 'closed':
        q.where.push(`NOT ${TASK_OPEN}`);
        break;
      case 'overdue':
        q.where.push(`${TASK_OPEN} AND t.due_date < ${today}::date`);
        break;
      case 'due_this_week':
        q.where.push(`${TASK_OPEN} AND t.due_date BETWEEN ${today}::date AND ${today}::date + 7`);
        break;
      default:
        break;
    }
    if (f.unit) q.where.push(`aa.organisational_unit_id = ${q.add(f.unit.id)}`);
    if (f.person) q.where.push(`t.assignee_account_id = ${q.add(f.person.id)}`);
    if (f.mine) q.where.push(`t.assignee_account_id = ${q.add(ctx.profile.accountId)}`);
    if (f.from) q.where.push(`(t.created_at AT TIME ZONE 'America/Paramaribo')::date >= ${q.add(f.from)}::date`);
    if (f.to) q.where.push(`(t.created_at AT TIME ZONE 'America/Paramaribo')::date <= ${q.add(f.to)}::date`);
  }
}

interface Shaped {
  model: Record<string, unknown>;
  card: { type: string; id: string; identity: string | null; title: string; meta: string; date: string | null; link: string };
}

const SELECT: Record<Kind, string> = {
  letters: `ci.id, ci.registration_identity AS ref, ci.subject AS title, ci.direction, ci.state AS status, ci.classification,
            to_char(ci.reply_requested_by, 'YYYY-MM-DD') AS due, to_char(${LETTER_DATE}, 'YYYY-MM-DD') AS d, ou.name AS unit, NULL::text AS handler,
            (ci.direction = 'INCOMING' AND ci.reply_requested_by IS NOT NULL AND ${NO_REPLY}) AS awaiting`,
  matters: `d.id, d.dossier_identity AS ref, d.subject AS title, d.state, d.processing_state AS status, d.classification,
            to_char(d.due_date, 'YYYY-MM-DD') AS due, to_char((d.created_at AT TIME ZONE 'America/Paramaribo')::date, 'YYYY-MM-DD') AS d,
            ou.name AS unit, hp.full_name AS handler, dc.name AS category`,
  tasks: `t.id, t.reference AS ref, t.title, t.status, t.priority, to_char(t.due_date, 'YYYY-MM-DD') AS due,
          to_char((t.created_at AT TIME ZONE 'America/Paramaribo')::date, 'YYYY-MM-DD') AS d, ou.name AS unit, ap.full_name AS handler,
          (coalesce(td.classification, '') IN ('CONFIDENTIAL','SECRET') OR coalesce(tci.classification, '') IN ('CONFIDENTIAL','SECRET')
           OR ${CONFIDENTIAL_TICKET}) AS restricted,
          td.dossier_identity AS matter`,
};

const ORDER: Record<Kind, string> = {
  letters: `coalesce(ci.reply_requested_by, ${LETTER_DATE}) ASC`,
  matters: `d.due_date ASC NULLS LAST, d.created_at DESC`,
  tasks: `t.due_date ASC NULLS LAST, t.created_at DESC`,
};

async function shape(ctx: ToolContext, kind: Kind, r: Record<string, any>): Promise<Shaped> {
  const en = ctx.language === 'en';
  const restricted = kind === 'tasks' ? Boolean(r.restricted) : RESTRICTED.includes(r.classification);
  const left = await daysLeft(ctx, kind === 'letters' && !r.awaiting ? null : r.due);
  const typeName = kind === 'letters' ? 'letter' : kind === 'matters' ? 'matter' : 'task';
  const statusLabel = label(ctx, r.status);
  const metaParts = [
    restricted ? (en ? 'confidential' : 'vertrouwelijk') : null,
    kind === 'letters' ? label(ctx, r.direction) : null,
    statusLabel,
    r.unit,
    r.handler,
    left === null ? null : left < 0 ? (en ? `${-left} working days late` : `${-left} werkdagen te laat`) : left === 0 ? (en ? 'due today' : 'vandaag') : en ? `${left} working days left` : `nog ${left} werkdagen`,
  ].filter(Boolean);
  const card = {
    type: kind === 'letters' ? 'ITEM' : kind === 'matters' ? 'DOSSIER' : 'TASK',
    id: r.id,
    identity: r.ref,
    title: r.title ?? '',
    meta: metaParts.join(', '),
    date: r.due ?? r.d,
    link: kind === 'letters' ? `/post/${r.id}` : kind === 'matters' ? `/zaken/${r.id}` : `/taken/${r.id}`,
  };
  if (restricted) return { model: { kind: typeName, restricted: true }, card };
  const model: Record<string, unknown> = {
    kind: typeName,
    ref: r.ref ?? (en ? 'draft, not yet registered' : 'concept, nog niet geregistreerd'),
    status: statusLabel,
    unit: r.unit ?? null,
  };
  if (kind === 'letters') {
    model.direction = label(ctx, r.direction);
    model.registered = dmy(r.d);
    if (r.awaiting) model.replyRequestedBy = dmy(r.due);
  } else {
    model.due = dmy(r.due);
    model.handler = r.handler ?? null;
  }
  if (kind === 'matters' && r.category) model.category = r.category;
  if (kind === 'tasks') {
    model.priority = label(ctx, r.priority);
    if (r.matter) model.matter = r.matter;
  }
  if (left !== null) model.workingDaysLeft = left;
  if (ctx.dataPolicy === 'records' && r.title && (kind !== 'letters' || r.classification !== 'SECRET')) model.subject = String(r.title).slice(0, 160);
  return { model, card };
}

function kindArg(v: unknown): Kind | null {
  const s = str(v, 20).toLowerCase();
  if (['letters', 'letter', 'brieven', 'post'].includes(s)) return 'letters';
  if (['matters', 'matter', 'zaken', 'dossiers', 'cases'].includes(s)) return 'matters';
  if (['tasks', 'task', 'taken'].includes(s)) return 'tasks';
  return null;
}

async function filtersFrom(ctx: ToolContext, kind: Kind, a: Record<string, unknown>): Promise<Filters | ToolOutput> {
  const f: Filters = { filter: str(a.filter, 30) || 'all', mine: a.mine === true };
  if (str(a.unit)) {
    const u = await resolveUnit(ctx, str(a.unit));
    if (!('id' in u)) return { ...u, about: 'unit' };
    f.unit = u;
  }
  if (str(a.person)) {
    const p = await resolvePerson(ctx, str(a.person));
    if (!('id' in p)) return { ...p, about: 'person' };
    f.person = p;
  }
  const period = str(a.period, 20);
  const range = period ? periodRange(period, ctx.today) : null;
  f.from = isoDate(a.from) ?? range?.from ?? null;
  f.to = isoDate(a.to) ?? range?.to ?? null;
  const dir = str(a.direction, 10).toUpperCase();
  f.direction = kind === 'letters' && ['INCOMING', 'OUTGOING', 'INTERNAL'].includes(dir) ? dir : null;
  return f;
}

const ID: Record<Kind, string> = { letters: 'ci.id', matters: 'd.id', tasks: 't.id' };
const NOUN: Record<Kind, [string, string, string, string]> = {
  letters: ['vertrouwelijke brief', 'vertrouwelijke brieven', 'confidential letter', 'confidential letters'],
  matters: ['vertrouwelijke zaak', 'vertrouwelijke zaken', 'confidential matter', 'confidential matters'],
  tasks: ['taak bij een vertrouwelijk stuk', 'taken bij vertrouwelijke stukken', 'task on a confidential record', 'tasks on confidential records'],
};

/** Tells the person — not the model — that confidential records were left out of the model's answer. */
function restrictedNote(ctx: ToolContext, kind: Kind, n: number): void {
  if (!n) return;
  const en = ctx.language === 'en';
  const [one, many, oneEn, manyEn] = NOUN[kind];
  ctx.cards.push({
    kind: 'NOTE',
    title: en ? 'Only for you' : 'Alleen voor u',
    body: en
      ? `${n} ${n === 1 ? oneEn : manyEn} you may see ${n === 1 ? 'is' : 'are'} not in the answer above: confidential records never go to the language model.${ctx.cards.some((c) => (c as { kind: string }).kind === 'LIST') ? ' The list shows them.' : ''}`
      : `${n} ${n === 1 ? one : many} die u mag zien, ${n === 1 ? 'staat' : 'staan'} niet in het antwoord hierboven: vertrouwelijke stukken gaan nooit naar het taalmodel.${ctx.cards.some((c) => (c as { kind: string }).kind === 'LIST') ? ' De lijst toont ze wel.' : ''}`,
  } as unknown as Card);
}

async function listOf(ctx: ToolContext, kind: Kind, f: Filters, limit: number, title: string): Promise<ToolOutput> {
  const q = new Sql();
  scoped(ctx, kind, q);
  applyFilters(ctx, kind, q, f);
  const [c] = await ctx.db.query(
    `SELECT count(DISTINCT ${ID[kind]}) FILTER (WHERE NOT ${IS_RESTRICTED[kind]})::int AS n, count(DISTINCT ${ID[kind]}) FILTER (WHERE ${IS_RESTRICTED[kind]})::int AS r
       FROM ${FROM[kind]} WHERE ${q.clause}`,
    q.params,
  );
  // The person sees everything they may see in the card; the model only the records that are not restricted.
  const all = await ctx.db.query(`SELECT ${SELECT[kind]} FROM ${FROM[kind]} WHERE ${q.clause} ORDER BY ${ORDER[kind]} LIMIT ${limit}`, q.params);
  const open = await ctx.db.query(`SELECT ${SELECT[kind]} FROM ${FROM[kind]} WHERE ${q.clause} AND NOT ${IS_RESTRICTED[kind]} ORDER BY ${ORDER[kind]} LIMIT ${limit}`, q.params);
  const cards = await Promise.all(all.map((r: Record<string, unknown>) => shape(ctx, kind, r)));
  const shaped = await Promise.all(open.map((r: Record<string, unknown>) => shape(ctx, kind, r)));
  if (cards.length) ctx.cards.push({ kind: 'LIST', title, rows: cards.map((x) => x.card), count: c.n + c.r } as unknown as Card);
  restrictedNote(ctx, kind, c.r);
  return {
    total: c.n,
    shown: shaped.length,
    items: shaped.map((x) => x.model),
    ...(f.unit ? { unit: f.unit.name } : {}),
    ...(f.person ? { person: f.person.name } : {}),
    ...(f.from || f.to ? { period: `${dmy(f.from ?? null) ?? '…'} – ${dmy(f.to ?? null) ?? '…'}` } : {}),
    ...(c.n > shaped.length ? { note: `Only the first ${shaped.length} of ${c.n} are listed.` } : {}),
  };
}

function lineText(ctx: ToolContext): string {
  return ctx.line.all ? 'whole ministry' : `${ctx.line.unitIds.length} unit(s)`;
}

// ------------------------------------------------------------------ schemas

const S = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: 'string', description, ...extra });
const KIND = S('letters (post: brieven), matters (zaken/dossiers) or tasks (taken)', { enum: ['letters', 'matters', 'tasks'] });
const FILTER = S(
  'open; overdue (past deadline); due_this_week; closed; all; awaiting_reply (letters only: incoming letters waiting for a reply); drafts (letters only: not yet registered); awaiting_decision (matters only)',
  { enum: ['open', 'overdue', 'due_this_week', 'closed', 'all', 'awaiting_reply', 'drafts', 'awaiting_decision'] },
);
const PERIOD = S('Period of registration/creation, computed by the server in Suriname time', {
  enum: ['today', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'last_30_days'],
});
const COMMON: Record<string, Schema> = {
  kind: KIND,
  filter: FILTER,
  unit: S('Unit code or (part of a) name, e.g. JZ or Juridische Zaken. Optional.'),
  person: S('Name (or part of it) of the handler/assignee. Optional.'),
  mine: { type: 'boolean', description: 'Only records of the person asking (their tasks, matters they are responsible for, letters they registered).' },
  period: PERIOD,
  from: S('Start date YYYY-MM-DD (instead of period). Optional.'),
  to: S('End date YYYY-MM-DD (instead of period). Optional.'),
  direction: S('Letters only: incoming, outgoing or internal', { enum: ['incoming', 'outgoing', 'internal'] }),
};

// ------------------------------------------------------------------ tools

export const TOOLS: ToolSpec[] = [
  {
    name: 'help_articles',
    description: 'Search the help articles of the system: how to do something, where to click, what a term means. Returns titles, links and the text of the best matches.',
    parameters: { type: 'object', properties: { query: S('What the person wants to know, in their words') }, required: ['query'] },
    roles: [...BUSINESS, 'AUDITOR', 'SYS_ADMIN'],
    async run(ctx, a) {
      const hits = searchHelp(str(a.query, 300), 3).filter((h) => h.score > 0);
      if (!hits.length) return { found: false, available: HELP.map((h) => h[ctx.language].title) };
      ctx.cards.push({
        kind: 'HELP',
        title: ctx.language === 'en' ? 'Help' : 'Uitleg',
        articles: hits.map((h) => ({ id: h.article.id, title: h.article[ctx.language].title, link: h.article.link })),
      } as unknown as Card);
      return { articles: hits.map((h) => ({ title: h.article[ctx.language].title, link: h.article.link, text: h.article[ctx.language].body.slice(0, 1800) })) };
    },
  },
  {
    name: 'my_work',
    description: 'What is waiting for the person asking: open and overdue tasks, matters awaiting their decision, advice to give, matters they are responsible for, drafts to register.',
    parameters: { type: 'object', properties: {} },
    roles: BUSINESS,
    async run(ctx) {
      const en = ctx.language === 'en';
      const w = await ctx.dashboard.myWork(ctx.actor.accountId);
      const s = w.summary;
      const rows = [
        ...w.reviewQueue.slice(0, 4).map((r: { dossierId: string; dossierIdentity: string; subject: string }) => ({
          type: 'DOSSIER', id: r.dossierId, identity: r.dossierIdentity, title: r.subject, meta: en ? 'awaiting your decision' : 'wacht op uw besluit', date: null, link: `/zaken/${r.dossierId}`,
        })),
        ...w.tasks
          .filter((x: { overdue: boolean; dueDate: string | null }) => x.overdue || x.dueDate)
          .slice(0, 6)
          .map((x: { id: string; reference: string; title: string; overdue: boolean; dueDate: string | null }) => ({
            type: 'TASK', id: x.id, identity: x.reference, title: x.title, meta: x.overdue ? (en ? 'overdue' : 'te laat') : en ? 'due' : 'termijn', date: x.dueDate, link: `/taken/${x.id}`,
          })),
      ];
      for (const pd of ((w as { projectDecisions?: { id: string; reference: string; name: string; kind: string }[] }).projectDecisions ?? []).slice(0, 3)) {
        rows.unshift({
          type: 'PROJECT', id: pd.id, identity: pd.reference, title: pd.name,
          meta: pd.kind === 'BUSINESS_CASE' ? (en ? 'business case awaits your approval' : 'business case wacht op uw goedkeuring') : en ? 'ready for your sign-off' : 'klaar om af te tekenen',
          date: null, link: `/projecten/${pd.id}`,
        } as (typeof rows)[number]);
      }
      if (rows.length) ctx.cards.push({ kind: 'LIST', title: en ? 'My work' : 'Mijn werk', rows, count: rows.length, link: '/' } as unknown as Card);
      // Tasks on confidential records are counted in the person's totals but never named to the model.
      const ids = w.tasks.map((x: { id: string }) => x.id);
      const restricted = new Set<string>(
        ids.length
          ? (
              await ctx.db.query(
                `SELECT t.id FROM ${FROM.tasks} WHERE t.id = ANY($1::uuid[]) AND ${IS_RESTRICTED.tasks}`,
                [ids],
              )
            ).map((r: { id: string }) => r.id)
          : [],
      );
      return {
        today: dmy(w.today),
        openTasks: s.openTasks,
        overdueTasks: s.overdueTasks,
        tasksDueThisWeek: s.dueThisWeek,
        mattersAwaitingMyDecision: s.awaitingMyDecision,
        adviceRequestsToAnswer: s.adviceToGive,
        mattersIAmResponsibleFor: s.responsibleMatters,
        myOverdueMatters: s.overdueMatters,
        draftsToRegister: s.draftsToRegister,
        projectDecisionsWaitingForMe: (s as { projectDecisions?: number }).projectDecisions ?? 0,
        nextTasks: w.tasks
          .filter((x: { id: string }) => !restricted.has(x.id))
          .slice(0, 5)
          .map((x: { reference: string; dueDate: string | null; overdue: boolean; status: string }) => ({ ref: x.reference, due: dmy(x.dueDate), overdue: x.overdue, status: label(ctx, x.status) })),
      };
    },
  },
  {
    name: 'find_record',
    description: 'Look up one letter, matter or task by its number (e.g. IN-2026-00012, DOS-2026-0003, TAAK-2026-0007): status, unit, handler, deadline and working days left. The subject is shown to the person in a card.',
    parameters: { type: 'object', properties: { reference: S('The registration number, matter number or task number') }, required: ['reference'] },
    roles: BUSINESS,
    async run(ctx, a) {
      const ref = str(a.reference, 40).toUpperCase();
      if (!ref) return { found: false };
      const target = await locate(ctx, ref);
      if (!target) return { found: false };
      const q = new Sql();
      scoped(ctx, target.kind, q);
      const idCol = target.kind === 'letters' ? 'ci.id' : target.kind === 'matters' ? 'd.id' : 't.id';
      q.where.push(`${idCol} = ${q.add(target.id)}`);
      const [row] = await ctx.db.query(`SELECT ${SELECT[target.kind]} FROM ${FROM[target.kind]} WHERE ${q.clause} LIMIT 1`, q.params);
      if (!row) {
        // Visible on screen, but outside the person's line: say so, give the link, no details.
        const link = target.kind === 'letters' ? `/post/${target.id}` : target.kind === 'matters' ? `/zaken/${target.id}` : `/taken/${target.id}`;
        return { found: true, outsideYourLine: true, ref, link };
      }
      const s = await shape(ctx, target.kind, row);
      ctx.cards.push({ kind: 'LIST', title: ref, rows: [s.card], count: 1 } as unknown as Card);
      const extra: Record<string, unknown> = {};
      if (target.kind === 'matters' && !s.model.restricted) {
        const [c] = await ctx.db.query(
          `SELECT (SELECT count(*)::int FROM dossier_link dl WHERE dl.dossier_id = $1) AS letters,
                  (SELECT count(*)::int FROM task t WHERE t.dossier_id = $1 AND t.archived_at IS NULL AND ${TASK_OPEN}) AS open_tasks,
                  (SELECT count(*)::int FROM advice_request ar WHERE ar.dossier_id = $1 AND ar.status = 'OPEN') AS open_advice`,
          [target.id],
        );
        Object.assign(extra, { linkedLetters: c.letters, openTasks: c.open_tasks, openAdviceRequests: c.open_advice });
      }
      return { found: true, ...s.model, ...extra, link: s.card.link };
    },
  },
  {
    name: 'list_records',
    description: 'List letters, matters or tasks within the line of command of the person asking, with filters. Returns at most 10 items and the true total. Subjects are shown to the person in a card.',
    parameters: { type: 'object', properties: { ...COMMON, limit: { type: 'integer', description: '1-10, default 10' } }, required: ['kind'] },
    roles: BUSINESS,
    async run(ctx, a) {
      const kind = kindArg(a.kind);
      if (!kind) return { error: 'kind must be letters, matters or tasks' };
      const f = await filtersFrom(ctx, kind, a);
      if (!('filter' in f)) return f;
      const filters = f as Filters;
      const limit = Math.min(Math.max(Number(a.limit) || CAP, 1), CAP);
      const en = ctx.language === 'en';
      const name = { letters: en ? 'Letters' : 'Brieven', matters: en ? 'Matters' : 'Zaken', tasks: en ? 'Tasks' : 'Taken' }[kind];
      const title = filters.filter !== 'all' ? `${name}: ${filterLabel(filters.filter, en)}` : name;
      return listOf(ctx, kind, filters, limit, title);
    },
  },
  {
    name: 'count_records',
    description: 'Count letters, matters or tasks within the line of command, optionally grouped by unit, person, status, month, direction, category or priority. Use for "how many" and "per department" questions.',
    parameters: {
      type: 'object',
      properties: { ...COMMON, group_by: S('Optional grouping', { enum: ['unit', 'person', 'status', 'month', 'direction', 'category', 'priority'] }) },
      required: ['kind'],
    },
    roles: BUSINESS,
    async run(ctx, a) {
      const kind = kindArg(a.kind);
      if (!kind) return { error: 'kind must be letters, matters or tasks' };
      const f = await filtersFrom(ctx, kind, a);
      if (!('filter' in f)) return f;
      const q = new Sql();
      scoped(ctx, kind, q);
      applyFilters(ctx, kind, q, f as Filters);
      const id = ID[kind];
      const [c] = await ctx.db.query(
        `SELECT count(DISTINCT ${id}) FILTER (WHERE NOT ${IS_RESTRICTED[kind]})::int AS n, count(DISTINCT ${id}) FILTER (WHERE ${IS_RESTRICTED[kind]})::int AS r
           FROM ${FROM[kind]} WHERE ${q.clause}`,
        q.params,
      );
      const n = c.n as number;
      restrictedNote(ctx, kind, c.r);
      const group = str(a.group_by, 20);
      const expr = groupExpr(kind, group);
      const out: ToolOutput = { total: n, filter: (f as Filters).filter };
      if ((f as Filters).from || (f as Filters).to) out.period = `${dmy((f as Filters).from ?? null) ?? '…'} – ${dmy((f as Filters).to ?? null) ?? '…'}`;
      if ((f as Filters).unit) out.unit = (f as Filters).unit!.name;
      if ((f as Filters).person) out.person = (f as Filters).person!.name;
      if (group && !expr) return { ...out, note: `Grouping by ${group} is not available for ${kind}.` };
      if (expr) {
        const byUnit = group === 'unit';
        const all: { k: string | null; n: number; uid?: string | null }[] = await ctx.db.query(
          `SELECT ${expr} AS k, count(DISTINCT ${id})::int AS n${byUnit ? ', ou.id AS uid' : ''} FROM ${FROM[kind]}
            WHERE ${q.clause} AND NOT ${IS_RESTRICTED[kind]} GROUP BY ${byUnit ? '1, ou.id' : '1'} ORDER BY 2 DESC, 1 LIMIT 500`,
          q.params,
        );
        const rows = all.slice(0, 25);
        if (all.length > rows.length) out.note = `Only the ${rows.length} largest of ${all.length} groups are listed; the totals cover all of them.`;
        const inLine = (r: { uid?: string | null }) => ctx.line.all || (r.uid ? ctx.line.unitIds.includes(r.uid) : false);
        out.groups = rows.map((r) => ({
          [group]: group === 'status' || group === 'direction' || group === 'priority' ? label(ctx, r.k) : r.k ?? (ctx.language === 'en' ? '(none)' : '(geen)'),
          count: r.n,
          // Outside the line, only records the person is involved in are counted.
          ...(byUnit && !inLine(r) ? { outsideYourLine: true } : {}),
        }));
        if (byUnit && !ctx.line.all) {
          out.inYourLine = all.filter(inLine).reduce((acc, r) => acc + r.n, 0);
          out.involvedOutsideYourLine = all.filter((r) => !inLine(r)).reduce((acc, r) => acc + r.n, 0);
        }
      }
      return out;
    },
  },
  {
    name: 'deadline_risk',
    description: 'Deadline risk within the line of command: matters, tasks and letters awaiting reply that are overdue or due within the next 5 working days, with the most urgent ones.',
    parameters: { type: 'object', properties: { unit: S('Optional unit code or name') } },
    roles: BUSINESS,
    async run(ctx, a) {
      let unit: { id: string; name: string } | undefined;
      if (str(a.unit)) {
        const u = await resolveUnit(ctx, str(a.unit));
        if (!('id' in u)) return { ...u, about: 'unit' };
        unit = u;
      }
      const horizon = await ctx.workingDays.addWorkingDays(ctx.today, 5);
      const result: ToolOutput = { horizon: dmy(horizon), line: lineText(ctx) };
      const urgent: { due: string; s: Shaped; restricted: boolean }[] = [];
      let restrictedTotal = 0;
      for (const kind of ['matters', 'tasks', 'letters'] as Kind[]) {
        const base = () => {
          const q = new Sql();
          scoped(ctx, kind, q);
          applyFilters(ctx, kind, q, { filter: kind === 'letters' ? 'awaiting_reply' : 'open', unit });
          if (kind === 'matters') q.where.push(`d.processing_state <> 'APPROVED'`);
          return q;
        };
        const due = kind === 'letters' ? 'ci.reply_requested_by' : kind === 'matters' ? 'd.due_date' : 't.due_date';
        const id = kind === 'letters' ? 'ci.id' : kind === 'matters' ? 'd.id' : 't.id';
        const c1 = base();
        const t = c1.add(ctx.today);
        const h = c1.add(horizon);
        const R = IS_RESTRICTED[kind];
        const [c] = await ctx.db.query(
          `SELECT count(DISTINCT ${id}) FILTER (WHERE ${due} < ${t}::date AND NOT ${R})::int AS overdue,
                  count(DISTINCT ${id}) FILTER (WHERE ${due} BETWEEN ${t}::date AND ${h}::date AND NOT ${R})::int AS soon,
                  count(DISTINCT ${id}) FILTER (WHERE ${due} <= ${h}::date AND ${R})::int AS restricted
             FROM ${FROM[kind]} WHERE ${c1.clause}`,
          c1.params,
        );
        result[kind] = { overdue: c.overdue, dueWithin5WorkingDays: c.soon };
        restrictedTotal += c.restricted;
        const r1 = base();
        const h2 = r1.add(horizon);
        const rows = await ctx.db.query(
          `SELECT ${SELECT[kind]}, ${R} AS is_restricted FROM ${FROM[kind]} WHERE ${r1.clause} AND ${due} <= ${h2}::date ORDER BY ${due} ASC LIMIT 10`,
          r1.params,
        );
        for (const r of rows) urgent.push({ due: r.due, s: await shape(ctx, kind, r), restricted: Boolean(r.is_restricted) });
      }
      urgent.sort((x, y) => (x.due < y.due ? -1 : 1));
      if (urgent.length) ctx.cards.push({ kind: 'LIST', title: ctx.language === 'en' ? 'Most urgent' : 'Meest dringend', rows: urgent.slice(0, 6).map((u) => u.s.card), count: urgent.length, link: '/assistent?tab=risico' } as unknown as Card);
      if (restrictedTotal) {
        const en = ctx.language === 'en';
        ctx.cards.push({
          kind: 'NOTE',
          title: en ? 'Only for you' : 'Alleen voor u',
          body: en
            ? `${restrictedTotal} confidential ${restrictedTotal === 1 ? 'record is' : 'records are'} late or due soon. They are not in the answer above — confidential records never go to the language model — but the list shows them.`
            : `${restrictedTotal} vertrouwelijke ${restrictedTotal === 1 ? 'stuk is' : 'stukken zijn'} te laat of verloopt binnenkort. Ze staan niet in het antwoord hierboven — vertrouwelijke stukken gaan nooit naar het taalmodel — maar de lijst toont ze wel.`,
        } as unknown as Card);
      }
      result.mostUrgent = urgent.filter((u) => !u.restricted).slice(0, CAP).map((u) => u.s.model);
      if (unit) result.unit = unit.name;
      return result;
    },
  },
  {
    name: 'org_structure',
    description: 'The organisation within the line of command: directorates, sub-directorates, departments, who heads them and how many people work there. With a unit, also lists the people in it (name and job title).',
    parameters: { type: 'object', properties: { unit: S('Optional unit code or name to list its people') } },
    roles: [...BUSINESS, 'SYS_ADMIN'],
    async run(ctx, a) {
      const all = ctx.line.all || ctx.profile.roles.includes('SYS_ADMIN');
      const units: { id: string; code: string; name: string; kind: string; parent: string | null; head: string | null; staff: number }[] = await ctx.db.query(
        `SELECT u.id, u.code, u.name, u.kind, pu.code AS parent, hp.full_name AS head,
                (SELECT count(*)::int FROM account x WHERE x.organisational_unit_id = u.id AND x.is_enabled) AS staff
           FROM organisational_unit u
           LEFT JOIN organisational_unit pu ON pu.id = u.parent_unit_id
           LEFT JOIN account ha ON ha.id = u.head_account_id LEFT JOIN person hp ON hp.id = ha.person_id
          WHERE u.is_active ${all ? '' : 'AND u.id = ANY($1::uuid[])'}
          ORDER BY u.code`,
        all ? [] : [ctx.line.unitIds],
      );
      const out: ToolOutput = {
        line: all ? 'whole ministry' : 'own line',
        units: units.map((u) => ({ code: u.code, name: u.name, type: u.kind, parent: u.parent, head: u.head, staff: u.staff })),
      };
      if (str(a.unit)) {
        const u = all ? await resolveUnit({ ...ctx, line: { all: true, unitIds: [], rootUnitIds: [] } }, str(a.unit)) : await resolveUnit(ctx, str(a.unit));
        if (!('id' in u)) return { ...out, people: u };
        const people: { full_name: string; job_position: string | null }[] = await ctx.db.query(
          `SELECT p.full_name, p.job_position FROM account a JOIN person p ON p.id = a.person_id
            WHERE a.organisational_unit_id = $1 AND a.is_enabled ORDER BY p.full_name LIMIT 30`,
          [u.id],
        );
        out.unit = u.name;
        out.people = people.map((p) => ({ name: p.full_name, jobTitle: p.job_position }));
      }
      return out;
    },
  },
  {
    name: 'summarise_record',
    description: 'Summarise one letter or matter by its number. The summary is made inside the ministry server and shown to the person as a card; you only get confirmation that it was shown.',
    parameters: { type: 'object', properties: { reference: S('Registration number or matter number') }, required: ['reference'] },
    roles: BUSINESS,
    async run(ctx, a) {
      const ref = str(a.reference, 40).toUpperCase();
      const target = ref ? await locate(ctx, ref) : null;
      if (!target || target.kind === 'tasks') return { found: false };
      const ok = target.kind === 'letters' ? await ctx.access.canViewItem(ctx.profile, target.id) : await ctx.access.canViewDossier(ctx.profile, target.id);
      if (!ok) return { found: false };
      if (!(await inLine(ctx, target))) return { found: true, outsideYourLine: true, ref, link: linkOf(target) };
      try {
        const s =
          target.kind === 'letters' ? await ctx.ai.summariseItem(ctx.actor, target.id, ctx.language) : await ctx.ai.summariseDossier(ctx.actor, target.id, ctx.language);
        const link = target.kind === 'letters' ? `/post/${target.id}` : `/zaken/${target.id}`;
        ctx.cards.push({ kind: 'SUMMARY', title: s.headline, bullets: s.bullets, keySentences: s.keySentences, link, sourceInteractionId: s.interactionId } as unknown as Card);
        return { shownToUser: true, ref, points: (s.bullets ?? []).length, link };
      } catch (error) {
        return { error: (error as { status?: number }).status === 403 ? 'Summaries are switched off by the administrator.' : 'The summary could not be made.' };
      }
    },
  },
  {
    name: 'draft_reply',
    description: 'Make a draft reply to one incoming letter by its registration number. The draft is made inside the ministry server and shown to the person as a card; nothing is saved or sent.',
    parameters: { type: 'object', properties: { reference: S('Registration number of the incoming letter') }, required: ['reference'] },
    roles: BUSINESS,
    async run(ctx, a) {
      const ref = str(a.reference, 40).toUpperCase();
      const target = ref ? await locate(ctx, ref) : null;
      if (!target || target.kind !== 'letters' || !(await ctx.access.canViewItem(ctx.profile, target.id))) return { found: false };
      if (!(await inLine(ctx, target))) return { found: true, outsideYourLine: true, ref, link: linkOf(target) };
      try {
        const d = await ctx.ai.draftReply(ctx.actor, target.id, { language: ctx.language });
        ctx.cards.push({ kind: 'DRAFT', title: ctx.language === 'en' ? 'Draft reply' : 'Conceptantwoord', body: d.body, itemId: target.id, sourceInteractionId: d.interactionId, link: `/post/${target.id}` } as unknown as Card);
        return { shownToUser: true, ref, note: 'Parts in [square brackets] are for the person to fill in. To save it: open the letter and choose Beantwoorden.' };
      } catch (error) {
        return { error: (error as { status?: number }).status === 403 ? 'Draft replies are switched off by the administrator.' : 'The draft could not be made.' };
      }
    },
  },
  {
    name: 'retention_overview',
    description: 'Records management: matters by retention state, retention periods that have ended and wait for a decision, legal holds, and what falls due in the next 90 days.',
    parameters: { type: 'object', properties: {} },
    roles: ['RECORDS_MANAGER'],
    async run(ctx) {
      const [c] = await ctx.db.query(
        `SELECT count(*) FILTER (WHERE state = 'CLOSED')::int AS closed,
                count(*) FILTER (WHERE state = 'CLOSED' AND retention_due_date <= $1::date AND NOT legal_hold)::int AS due_for_decision,
                count(*) FILTER (WHERE state = 'CLOSED' AND retention_due_date > $1::date AND retention_due_date <= $1::date + 90)::int AS due_90_days,
                count(*) FILTER (WHERE legal_hold)::int AS legal_hold
           FROM dossier`,
        [ctx.today],
      );
      const states: { s: string; n: number }[] = await ctx.db.query(`SELECT retention_state AS s, count(*)::int AS n FROM dossier GROUP BY 1 ORDER BY 2 DESC`);
      return {
        closedMatters: c.closed,
        retentionEndedAwaitingDecision: c.due_for_decision,
        retentionEndsWithin90Days: c.due_90_days,
        onLegalHold: c.legal_hold,
        byRetentionState: states.map((s) => ({ state: s.s, count: s.n })),
        link: '/archief',
      };
    },
  },
  {
    name: 'audit_overview',
    description: 'Audit and integrity figures: number of logged events by type, failed sign-ins, locked sign-ins and the last integrity check. Counts only.',
    parameters: { type: 'object', properties: { days: { type: 'integer', description: 'Number of days back, 1-365, default 30' } } },
    roles: ['AUDITOR'],
    async run(ctx, a) {
      const days = Math.min(Math.max(Number(a.days) || 30, 1), 365);
      const types: { t: string; n: number }[] = await ctx.db.query(
        `SELECT event_type AS t, count(*)::int AS n FROM audit_event WHERE occurred_at >= now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
        [String(days)],
      );
      const [l] = await ctx.db.query(
        `SELECT count(*) FILTER (WHERE NOT succeeded)::int AS failed, count(*) FILTER (WHERE succeeded)::int AS ok
           FROM login_attempt WHERE occurred_at >= now() - ($1 || ' days')::interval`,
        [String(days)],
      );
      const [anchor] = await ctx.db.query(
        `SELECT to_char((run_at AT TIME ZONE 'America/Paramaribo')::date, 'YYYY-MM-DD') AS d, audit_chain_ok, documents_failed FROM integrity_anchor ORDER BY run_at DESC LIMIT 1`,
      );
      const [{ total }] = await ctx.db.query(`SELECT count(*)::int AS total FROM audit_event WHERE occurred_at >= now() - ($1 || ' days')::interval`, [String(days)]);
      return {
        days,
        totalEvents: total,
        byType: types.map((t) => ({ type: t.t, count: t.n })),
        signIns: { succeeded: l.ok, failed: l.failed },
        lastIntegrityCheck: anchor ? { date: dmy(anchor.d), auditChainIntact: anchor.audit_chain_ok, documentsFailed: anchor.documents_failed } : null,
        link: '/logboek',
      };
    },
  },
  {
    name: 'system_status',
    description: 'System administration status: version, accounts (enabled, disabled, per role), background jobs and outgoing e-mail/SMS queues, and which language model the assistant uses.',
    parameters: { type: 'object', properties: {} },
    roles: ['SYS_ADMIN'],
    async run(ctx) {
      const [acc] = await ctx.db.query(`SELECT count(*) FILTER (WHERE is_enabled)::int AS enabled, count(*) FILTER (WHERE NOT is_enabled)::int AS disabled FROM account`);
      const roles: { r: string; n: number }[] = await ctx.db.query(
        `SELECT fr.code AS r, count(DISTINCT ra.account_id)::int AS n FROM role_assignment ra JOIN functional_role fr ON fr.id = ra.functional_role_id JOIN account a ON a.id = ra.account_id AND a.is_enabled GROUP BY 1 ORDER BY 1`,
      );
      const jobs: { job: string; outcome: string; at: string }[] = await ctx.db.query(
        `SELECT DISTINCT ON (job) job, outcome, to_char(started_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD HH24:MI') AS at FROM job_run ORDER BY job, started_at DESC`,
      );
      const [q] = await ctx.db.query(
        `SELECT (SELECT count(*)::int FROM email_outbox WHERE status <> 'SENT') AS mail, (SELECT count(*)::int FROM sms_outbox WHERE status <> 'SENT') AS sms`,
      );
      return {
        version: BUILD_VERSION,
        accounts: { enabled: acc.enabled, disabled: acc.disabled, byRole: roles.map((r) => ({ role: r.r, count: r.n })) },
        jobs: jobs.map((j) => ({ job: j.job, lastOutcome: j.outcome, lastRun: j.at })),
        outbox: { emailNotSent: q.mail, smsNotSent: q.sms },
        assistant: ctx.engine,
        link: '/beheer',
      };
    },
  },
  ...PROJECT_TOOLS,
];

function filterLabel(f: string, en: boolean): string {
  const m: Record<string, [string, string]> = {
    open: ['open', 'open'],
    overdue: ['te laat', 'overdue'],
    due_this_week: ['termijn deze week', 'due this week'],
    closed: ['afgesloten', 'closed'],
    awaiting_reply: ['wacht op antwoord', 'awaiting reply'],
    drafts: ['concepten', 'drafts'],
    awaiting_decision: ['wacht op besluit', 'awaiting decision'],
  };
  return m[f]?.[en ? 1 : 0] ?? f;
}

function groupExpr(kind: Kind, group: string): string | null {
  const month = {
    letters: `to_char(${LETTER_DATE}, 'YYYY-MM')`,
    matters: `to_char((d.created_at AT TIME ZONE 'America/Paramaribo')::date, 'YYYY-MM')`,
    tasks: `to_char((t.created_at AT TIME ZONE 'America/Paramaribo')::date, 'YYYY-MM')`,
  }[kind];
  const map: Record<Kind, Record<string, string>> = {
    letters: { unit: 'ou.name', status: 'ci.state', month, direction: 'ci.direction' },
    matters: { unit: 'ou.name', person: 'hp.full_name', status: 'd.processing_state', month, category: 'dc.name' },
    tasks: { unit: 'ou.name', person: 'ap.full_name', status: 't.status', month, priority: 't.priority' },
  };
  return map[kind][group] ?? null;
}

/** Whether a visible record is also in the person's line (same predicates as the lists). */
async function inLine(ctx: ToolContext, target: { kind: Kind; id: string }): Promise<boolean> {
  const q = new Sql();
  scoped(ctx, target.kind, q);
  q.where.push(`${ID[target.kind]} = ${q.add(target.id)}`);
  const [row] = await ctx.db.query(`SELECT 1 FROM ${FROM[target.kind]} WHERE ${q.clause} LIMIT 1`, q.params);
  return Boolean(row);
}

function linkOf(target: { kind: Kind; id: string }): string {
  return target.kind === 'letters' ? `/post/${target.id}` : target.kind === 'matters' ? `/zaken/${target.id}` : `/taken/${target.id}`;
}

/** Which record a number points to. Existence is never confirmed without access (see callers). */
async function locate(ctx: ToolContext, ref: string): Promise<{ kind: Kind; id: string } | null> {
  const [d] = await ctx.db.query(`SELECT id FROM dossier WHERE upper(dossier_identity) = $1`, [ref]);
  if (d) return (await ctx.access.canViewDossier(ctx.profile, d.id)) ? { kind: 'matters', id: d.id } : null;
  const [i] = await ctx.db.query(`SELECT id FROM correspondence_item WHERE upper(registration_identity) = $1`, [ref]);
  if (i) return (await ctx.access.canViewItem(ctx.profile, i.id)) ? { kind: 'letters', id: i.id } : null;
  const [t] = await ctx.db.query(`SELECT id FROM task WHERE upper(reference) = $1`, [ref]);
  if (t) {
    const v = ctx.tasks.visibility(ctx.profile, 2);
    const [ok] = await ctx.db.query(`SELECT 1 FROM task t WHERE t.id = $1 AND ${v.sql}`, [t.id, ...v.params]);
    return ok ? { kind: 'tasks', id: t.id } : null;
  }
  return null;
}

/** Layer 2: the tools a role may use. The model never sees the others. */
export function toolsFor(roles: string[], scope: 'work' | 'broad'): ToolSpec[] {
  void scope;
  return TOOLS.filter((t) => t.roles.some((r) => roles.includes(r)));
}

/** Layer 3: every call is checked again before it runs, and its arguments are bounded. */
export async function runTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolOutput> {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) return { error: `Unknown tool ${String(name).slice(0, 40)}.` };
  if (!spec.roles.some((r) => ctx.profile.roles.includes(r))) return { error: 'This information is not available for your role.' };
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (JSON.stringify(a).length > 2000) return { error: 'The request to this tool is too long.' };
  return spec.run(ctx, a);
}
