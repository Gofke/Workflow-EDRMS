/**
 * The assistant's project tools (V0.5.0). Read-only, and never wider than the
 * project screens: every call goes through ProjectsService, which applies
 * need-to-know — a team member gets their own tickets, a stakeholder the
 * overview, the line of command a summary, a confidential project only the
 * people on it.
 *
 * What the model receives is metadata: numbers, statuses, phases, dates,
 * progress, counts and the names of the people who answer for the work. Project
 * names and ticket titles go to the person as cards, unless the ministry chose
 * the "records" data policy for a model on its own network. Confidential
 * projects never reach the model at all; a note card tells the person.
 */
import { BUSINESS_ROLES } from '../../common/actor';
import type { ProjectDetail, ProjectSummaryView } from '../../projects/projects.service';
import { Card } from '../chat.service';
import { Schema } from './types';
import type { ToolContext, ToolOutput, ToolSpec } from './tools';

const S = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: 'string', description, ...extra });

const STATUS: Record<string, [string, string]> = {
  PROPOSED: ['business case', 'business case'],
  ACTIVE: ['loopt', 'running'],
  ON_HOLD: ['gepauzeerd', 'on hold'],
  COMPLETED: ['afgerond', 'completed'],
  CANCELLED: ['stopgezet', 'cancelled'],
};
const BC: Record<string, [string, string]> = {
  DRAFT: ['in opbouw', 'being written'],
  SUBMITTED: ['ter goedkeuring bij de opdrachtgever', 'awaiting the owner\'s approval'],
  APPROVED: ['goedgekeurd', 'approved'],
  RETURNED: ['teruggestuurd naar de projectleider', 'returned to the project manager'],
};
const ROLE: Record<string, [string, string]> = {
  OWNER: ['opdrachtgever', 'owner'],
  MANAGER: ['projectleider', 'project manager'],
  STAKEHOLDER: ['belanghebbende', 'stakeholder'],
  MEMBER: ['teamlid', 'team member'],
};
const ACCESS: Record<string, [string, string]> = {
  FULL: ['volledig (opdrachtgever of projectleider)', 'full (owner or project manager)'],
  OVERVIEW: ['overzicht als belanghebbende, zonder ticketinhoud', 'stakeholder overview, without ticket contents'],
  SUMMARY: ['samenvatting via de lijn, zonder business case en tickets', 'summary through the line of command, without business case and tickets'],
  MEMBER: ['teamlid: alleen eigen tickets', 'team member: own tickets only'],
};
const STATUS_FILTER: Record<string, string> = { running: 'ACTIVE', business_case: 'PROPOSED', on_hold: 'ON_HOLD', completed: 'COMPLETED', cancelled: 'CANCELLED' };
const TICKET: Record<string, [string, string]> = {
  OPEN: ['open', 'open'],
  ACCEPTED: ['geaccepteerd', 'accepted'],
  IN_PROGRESS: ['in uitvoering', 'in progress'],
  WAITING: ['wachtend', 'waiting'],
  IN_REVIEW: ['ter controle', 'in review'],
  COMPLETED: ['voltooid', 'completed'],
  CANCELLED: ['geannuleerd', 'cancelled'],
  REJECTED: ['afgewezen', 'rejected'],
};

function l(ctx: ToolContext, map: Record<string, [string, string]>, code: string | null | undefined): string | null {
  if (!code) return null;
  return map[code]?.[ctx.language === 'en' ? 1 : 0] ?? code.toLowerCase();
}

function dmy(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

function str(v: unknown, max = 120): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** One project as the model may know it: metadata, and the name only under the records policy. */
function forModel(ctx: ToolContext, p: ProjectSummaryView): ToolOutput {
  return {
    ref: p.reference,
    ...(ctx.dataPolicy === 'records' ? { name: p.name } : {}),
    status: l(ctx, STATUS, p.status),
    // Phase names are written by people, like subjects: the name only under the records policy.
    phase: p.phase ? `${p.phase.position}/${p.phase.count}${ctx.dataPolicy === 'records' ? ` ${p.phase.name}` : ''}` : null,
    progressPercent: p.progress,
    behindSchedule: p.late,
    start: dmy(p.startDate),
    end: dmy(p.endDate),
    unit: p.unit.name,
    owner: p.owner.name,
    projectManager: p.manager.name,
    businessCase: l(ctx, BC, p.businessCaseStatus),
    openTickets: p.ticketCounts.open,
    overdueTickets: p.ticketCounts.overdue,
    yourRole: l(ctx, ROLE, p.myRole),
    yourAccess: l(ctx, ACCESS, p.access),
  };
}

function cardRow(ctx: ToolContext, p: ProjectSummaryView) {
  const en = ctx.language === 'en';
  const parts = [
    l(ctx, STATUS, p.status),
    p.phase ? `${en ? 'phase' : 'fase'} ${p.phase.position}/${p.phase.count}` : null,
    `${p.progress}%`,
    p.late ? (en ? 'behind schedule' : 'loopt achter') : null,
    p.ticketCounts.overdue ? `${p.ticketCounts.overdue} ${en ? 'overdue' : 'te laat'}` : null,
    p.classification === 'CONFIDENTIAL' ? (en ? 'confidential' : 'vertrouwelijk') : null,
  ].filter(Boolean);
  return { type: 'PROJECT', id: p.id, identity: p.reference, title: p.name, meta: parts.join(' · '), date: null, link: `/projecten/${p.id}` };
}

function confidentialNote(ctx: ToolContext, n: number): void {
  if (!n) return;
  const en = ctx.language === 'en';
  ctx.cards.push({
    kind: 'NOTE',
    title: en ? 'Only for you' : 'Alleen voor u',
    body: en
      ? `${n} confidential project${n === 1 ? '' : 's'} you are on ${n === 1 ? 'is' : 'are'} not in the answer above: confidential projects never go to the language model. The list shows ${n === 1 ? 'it' : 'them'}.`
      : `${n} vertrouwelijk${n === 1 ? ' project' : 'e projecten'} waar u op staat, ${n === 1 ? 'staat' : 'staan'} niet in het antwoord hierboven: vertrouwelijke projecten gaan nooit naar het taalmodel. De lijst toont ${n === 1 ? 'het' : 'ze'} wel.`,
  } as unknown as Card);
}

export const PROJECT_TOOLS: ToolSpec[] = [
  {
    name: 'projects',
    description:
      'The projects the person may see (need-to-know): status, current phase, progress, start and end, behind schedule, owner, project manager, business case status, open and overdue tickets, and the person\'s own role. Filter by a name or number (PRJ-2026-003), by status, or to only late projects, only projects waiting for the person\'s decision as owner, or only projects the person has a role in. Project names are shown to the person in a card.',
    parameters: {
      type: 'object',
      properties: {
        query: S('Part of the project name, or its number (PRJ-yyyy-nnn). Leave empty for all.'),
        status: S('Only projects with this status', { enum: ['any', 'running', 'business_case', 'on_hold', 'completed', 'cancelled'] }),
        only: S('late: behind schedule or with overdue tickets; awaiting_my_decision: a business case waiting for the person as owner; mine: projects the person has a role in', { enum: ['all', 'late', 'awaiting_my_decision', 'mine'] }),
      },
    },
    roles: [...BUSINESS_ROLES],
    async run(ctx, a) {
      const only = str(a.only, 30);
      const status = STATUS_FILTER[str(a.status, 30)];
      const list = await ctx.projects.list(ctx.actor.accountId, { scope: only === 'mine' ? 'mine' : 'all', q: str(a.query, 80) || undefined, status });
      let rows = list.data;
      if (only === 'late') rows = rows.filter((p) => p.late || p.ticketCounts.overdue > 0);
      if (only === 'awaiting_my_decision') rows = rows.filter((p) => p.myRole === 'OWNER' && p.businessCaseStatus === 'SUBMITTED' && p.status === 'PROPOSED');
      const en = ctx.language === 'en';
      if (rows.length) {
        ctx.cards.push({ kind: 'LIST', title: en ? 'Projects' : 'Projecten', rows: rows.slice(0, 12).map((p) => cardRow(ctx, p)), count: rows.length, link: '/projecten' } as unknown as Card);
      }
      const open = rows.filter((p) => p.classification !== 'CONFIDENTIAL');
      confidentialNote(ctx, rows.length - open.length);
      if (!open.length) return { found: false, total: 0, ...(rows.length ? { onlyConfidential: true } : {}) };
      return { total: open.length, projects: open.slice(0, 12).map((p) => forModel(ctx, p)) };
    },
  },
  {
    name: 'project_detail',
    description:
      'One project in detail, as far as the person may see it: its phases with dates, status and tickets done, the business case status, and — for the owner and project manager all tickets, for a team member their own tickets — each ticket\'s number, status, assignee, start and due date, and whether it is overdue. Give the project number or part of its name.',
    parameters: { type: 'object', properties: { project: S('The project number (PRJ-yyyy-nnn) or part of its name') }, required: ['project'] },
    roles: [...BUSINESS_ROLES],
    async run(ctx, a) {
      const query = str(a.project, 80);
      if (!query) return { found: false };
      const matches = (await ctx.projects.list(ctx.actor.accountId, { q: query })).data;
      if (!matches.length) return { found: false };
      const en = ctx.language === 'en';
      if (matches.length > 1) {
        const exact = matches.find((p) => p.reference.toUpperCase() === query.toUpperCase());
        if (!exact) {
          ctx.cards.push({ kind: 'LIST', title: en ? 'Which project?' : 'Welk project?', rows: matches.slice(0, 8).map((p) => cardRow(ctx, p)), count: matches.length } as unknown as Card);
          const open = matches.filter((p) => p.classification !== 'CONFIDENTIAL');
          confidentialNote(ctx, matches.length - open.length);
          return { found: true, ambiguous: true, candidates: open.slice(0, 8).map((p) => ({ ref: p.reference, status: l(ctx, STATUS, p.status), ...(ctx.dataPolicy === 'records' ? { name: p.name } : {}) })) };
        }
        matches.splice(0, matches.length, exact);
      }
      const d = (await ctx.projects.detail(ctx.actor.accountId, matches[0].id)) as unknown as ProjectDetail;
      const late = d.tickets.filter((x) => x.overdue);
      ctx.cards.push({
        kind: 'LIST',
        title: `${d.reference} — ${d.name}`,
        rows: [
          cardRow(ctx, d as unknown as ProjectSummaryView),
          ...(late.length ? late : d.tickets.filter((x) => !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(x.status)))
            .slice(0, 7)
            .map((x) => ({
              type: 'TASK',
              id: x.id,
              identity: x.reference,
              title: x.title,
              meta: `${x.assignee.name} · ${x.overdue ? (en ? 'overdue' : 'te laat') : l(ctx, TICKET, x.status)}${en ? ', due' : ', termijn'}`,
              date: x.dueDate,
              link: `/taken/${x.id}`,
            })),
        ],
        count: 1 + Math.min(7, late.length || d.tickets.length),
        link: `/projecten/${d.id}`,
      } as unknown as Card);
      if (d.classification === 'CONFIDENTIAL') {
        confidentialNote(ctx, 1);
        return { found: true, confidential: true, shownToThePersonInACard: true };
      }
      return {
        ...forModel(ctx, d as unknown as ProjectSummaryView),
        ticketsYouMaySee: d.ticketsShown === 'all' ? (en ? 'all tickets of the project' : 'alle tickets van het project') : en ? 'only your own tickets' : 'alleen uw eigen tickets',
        phases: d.milestones.map((m) => ({
          n: m.position,
          ...(ctx.dataPolicy === 'records' ? { name: m.name } : {}),
          gate: m.gate === 'BUSINESS_CASE' ? (en ? 'owner approves the business case' : 'opdrachtgever keurt business case goed') : m.gate === 'CLOSURE' ? (en ? 'owner signs off' : 'opdrachtgever tekent af') : null,
          start: dmy(m.startDate),
          end: dmy(m.endDate),
          status: m.status === 'CLOSED' ? (en ? 'closed' : 'afgesloten') : m.status === 'ACTIVE' ? (en ? 'current' : 'huidige fase') : en ? 'planned' : 'gepland',
          pastEndDate: m.late,
          ticketsDone: m.tickets.done,
          ticketsTotal: m.tickets.total,
          overdue: m.tickets.overdue,
        })),
        ...(d.businessCase && 'decidedBy' in d.businessCase && d.businessCase.decidedBy ? { businessCaseDecidedBy: d.businessCase.decidedBy, businessCaseDecidedOn: dmy(d.businessCase.decidedAt) } : {}),
        ...(d.businessCase && 'returnReason' in d.businessCase && d.businessCase.returnReason && ctx.dataPolicy === 'records' ? { returnReason: d.businessCase.returnReason } : {}),
        tickets: d.tickets.slice(0, 25).map((x) => ({
          ref: x.reference,
          ...(ctx.dataPolicy === 'records' ? { title: x.title } : {}),
          phase: d.milestones.find((m) => m.id === x.milestoneId)?.position ?? null,
          status: l(ctx, TICKET, x.status),
          assignee: x.assignee.name,
          start: dmy(x.startDate),
          due: dmy(x.dueDate),
          overdue: x.overdue,
        })),
        ticketsTotalShown: d.tickets.length,
        ...(d.team.length ? { team: (d.team as { name: string; role: string; openTickets: number }[]).map((m) => ({ name: m.name, role: l(ctx, ROLE, m.role), openTickets: m.openTickets })) } : {}),
      };
    },
  },
];
