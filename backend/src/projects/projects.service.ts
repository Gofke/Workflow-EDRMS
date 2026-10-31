import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccessProfile, AccessService, isUuid } from '../access/access.service';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { MANAGEMENT_ROLES, readableDate, todayInSuriname } from '../common/actor';
import { NotificationService } from '../core/notification.service';
import { Actor } from '../records/registration.service';
import { OPEN_STATES, TasksService } from '../tasks/tasks.service';
import { isProjectPerson } from './ticket-rules';

export type ProjectStatus = 'PROPOSED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type BusinessCaseStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETURNED';
/**
 * What a person may see of a project (need-to-know):
 *
 *   FULL      owner and project manager: everything, every ticket
 *   OVERVIEW  stakeholder: business case, milestones, team, progress — no ticket contents
 *   SUMMARY   line of command over the project's unit (Minister: all; directors,
 *             sub-directors and heads: their line): status, phase, progress, dates
 *   MEMBER    team member or contractor: the project's frame and their own tickets
 *
 * A confidential project is never shown to the line of command; only to the
 * people on it. Tickets follow TasksService.visibility: outside FULL, a person
 * sees only the tickets they hold, own or follow.
 */
export type ProjectAccess = 'FULL' | 'OVERVIEW' | 'SUMMARY' | 'MEMBER';
export type ProjectRole = 'OWNER' | 'MANAGER' | 'STAKEHOLDER' | 'MEMBER';

const CLOSED_TICKET = ['COMPLETED', 'CANCELLED', 'REJECTED'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PersonRef {
  accountId: string;
  name: string;
}

export interface MilestoneView {
  id: string;
  position: number;
  name: string;
  description: string;
  gate: 'BUSINESS_CASE' | 'CLOSURE' | null;
  startDate: string;
  endDate: string;
  status: 'PLANNED' | 'ACTIVE' | 'CLOSED';
  closedAt: string | null;
  late: boolean;
  tickets: { total: number; done: number; open: number; overdue: number };
}

export interface ProjectSummaryView {
  id: string;
  reference: string;
  name: string;
  status: ProjectStatus;
  classification: 'INTERNAL' | 'CONFIDENTIAL';
  unit: { id: string; code: string; name: string };
  owner: PersonRef;
  manager: PersonRef;
  startDate: string;
  endDate: string;
  businessCaseStatus: BusinessCaseStatus;
  phase: { position: number; count: number; name: string } | null;
  progress: number;
  late: boolean;
  ticketCounts: { total: number; done: number; open: number; overdue: number };
  milestones: Pick<MilestoneView, 'id' | 'position' | 'name' | 'gate' | 'startDate' | 'endDate' | 'status' | 'late'>[];
  myRole: ProjectRole | null;
  access: ProjectAccess;
  memberCount: number;
  version: number;
}

export interface TicketView {
  id: string;
  reference: string;
  title: string;
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  overdue: boolean;
  milestoneId: string;
  assignee: PersonRef;
  completedAt: string | null;
}

interface ProjectRow {
  id: string;
  reference: string;
  name: string;
  description: string;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  owner_account_id: string;
  owner_name: string;
  manager_account_id: string;
  manager_name: string;
  classification: 'INTERNAL' | 'CONFIDENTIAL';
  status: ProjectStatus;
  status_before_hold: ProjectStatus | null;
  status_reason: string | null;
  start_date: string | Date;
  end_date: string | Date;
  business_case_status: BusinessCaseStatus;
  bc_problem: string;
  bc_solution: string;
  bc_benefits: string;
  bc_costs: string;
  bc_risks: string;
  budget: string | null;
  bc_submitted_at: Date | null;
  bc_decided_at: Date | null;
  bc_decider_name: string | null;
  bc_return_reason: string | null;
  created_at: Date;
  completed_at: Date | null;
  version: number;
  my_member_role: 'STAKEHOLDER' | 'MEMBER' | null;
  member_count: number;
}

const SELECT_PROJECT = `
  SELECT p.*, u.code AS unit_code, u.name AS unit_name,
         op.full_name AS owner_name, mp.full_name AS manager_name, dp.full_name AS bc_decider_name,
         (SELECT m.role FROM project_member m WHERE m.project_id = p.id AND m.account_id = $1 AND m.removed_at IS NULL) AS my_member_role,
         (SELECT count(*)::int FROM project_member m WHERE m.project_id = p.id AND m.removed_at IS NULL) AS member_count
    FROM project p
    JOIN organisational_unit u ON u.id = p.unit_id
    JOIN account oa ON oa.id = p.owner_account_id JOIN person op ON op.id = oa.person_id
    JOIN account ma ON ma.id = p.manager_account_id JOIN person mp ON mp.id = ma.person_id
    LEFT JOIN account da ON da.id = p.bc_decided_by_account_id LEFT JOIN person dp ON dp.id = da.person_id`;

export interface CreateProjectInput {
  name: string;
  description?: string;
  unitId: string;
  ownerAccountId?: string;
  managerAccountId: string;
  startDate: string;
  endDate: string;
  classification?: 'INTERNAL' | 'CONFIDENTIAL';
  stakeholders?: string[];
  members?: string[];
  /** Optional own phases; the first is the business case and the last the closure. Default: the four-phase template. */
  milestones?: { name: string; startDate: string; endDate: string; description?: string }[];
}

/**
 * Projects for the ministry: owner, project manager, stakeholders and team; a
 * business case the owner approves before the work starts; milestones; tickets
 * (tasks in a milestone) for the Gantt chart; and need-to-know access.
 *
 * Every change is one transaction with its project event and its audit event.
 * Nothing is deleted: a project is completed or cancelled with a reason.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly tasks: TasksService,
  ) {}

  // ---------------------------------------------------------------- who sees what

  /** May the person start a project: a decision-maker or the head of a unit. */
  async canCreate(profile: AccessProfile): Promise<boolean> {
    if (profile.roles.some((r) => MANAGEMENT_ROLES.includes(r))) return true;
    const [row] = await this.dataSource.query(`SELECT 1 FROM organisational_unit WHERE is_active AND head_account_id = $1 LIMIT 1`, [profile.accountId]);
    return !!row;
  }

  /**
   * The projects a person may see at all, as SQL on alias p, parameters from
   * `next`: the people on it, and — unless confidential — the line of command
   * over its unit.
   */
  async visibility(profile: AccessProfile, next: number, alias = 'p'): Promise<{ sql: string; params: unknown[] }> {
    const me = `$${next}`;
    const onIt = `(${alias}.owner_account_id = ${me} OR ${alias}.manager_account_id = ${me}
        OR EXISTS (SELECT 1 FROM project_member pm_x WHERE pm_x.project_id = ${alias}.id AND pm_x.account_id = ${me} AND pm_x.removed_at IS NULL))`;
    const line = await this.summaryUnits(profile);
    if (line === 'all') return { sql: `(${onIt} OR ${alias}.classification <> 'CONFIDENTIAL')`, params: [profile.accountId] };
    if (!line.length) return { sql: onIt, params: [profile.accountId] };
    return {
      sql: `(${onIt} OR (${alias}.classification <> 'CONFIDENTIAL' AND ${alias}.unit_id = ANY($${next + 1}::uuid[])))`,
      params: [profile.accountId, line],
    };
  }

  /** The units whose projects a person sees in summary: their line, if they lead one. */
  private async summaryUnits(profile: AccessProfile): Promise<'all' | string[]> {
    if (profile.roles.includes('MINISTER')) return 'all';
    const leads = profile.roles.some((r) => MANAGEMENT_ROLES.includes(r)) || (await this.headsAUnit(profile.accountId));
    if (!leads) return [];
    const scope = await this.access.lineScope(profile);
    return scope.all ? 'all' : scope.unitIds;
  }

  private async headsAUnit(accountId: string): Promise<boolean> {
    const [row] = await this.dataSource.query(`SELECT 1 FROM organisational_unit WHERE is_active AND head_account_id = $1 LIMIT 1`, [accountId]);
    return !!row;
  }

  private roleOf(row: ProjectRow, accountId: string): ProjectRole | null {
    if (row.owner_account_id === accountId) return 'OWNER';
    if (row.manager_account_id === accountId) return 'MANAGER';
    return row.my_member_role ?? null;
  }

  private async accessOf(row: ProjectRow, profile: AccessProfile): Promise<ProjectAccess | null> {
    const role = this.roleOf(row, profile.accountId);
    if (role === 'OWNER' || role === 'MANAGER') return 'FULL';
    if (role === 'STAKEHOLDER') return 'OVERVIEW';
    if (row.classification !== 'CONFIDENTIAL') {
      const line = await this.summaryUnits(profile);
      if (line === 'all' || line.includes(row.unit_id)) return 'SUMMARY';
    }
    return role === 'MEMBER' ? 'MEMBER' : null;
  }

  // ---------------------------------------------------------------- reading

  async list(accountId: string, query: { scope?: 'mine' | 'all'; status?: string; q?: string } = {}): Promise<{ data: ProjectSummaryView[]; canCreate: boolean }> {
    const profile = await this.access.profile(accountId);
    const v = await this.visibility(profile, 1);
    const params: unknown[] = [...v.params];
    const clauses = [v.sql];
    if (query.scope === 'mine') {
      clauses.push(`(p.owner_account_id = $1 OR p.manager_account_id = $1
        OR EXISTS (SELECT 1 FROM project_member pm_m WHERE pm_m.project_id = p.id AND pm_m.account_id = $1 AND pm_m.removed_at IS NULL))`);
    }
    if (query.status) {
      const statuses = query.status.split(',').filter((s) => ['PROPOSED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'].includes(s));
      if (statuses.length) {
        params.push(statuses);
        clauses.push(`p.status = ANY($${params.length})`);
      }
    }
    if (query.q?.trim()) {
      params.push(`%${query.q.trim()}%`);
      clauses.push(`(p.name ILIKE $${params.length} OR p.reference ILIKE $${params.length})`);
    }
    const rows: ProjectRow[] = await this.dataSource.query(
      `${SELECT_PROJECT} WHERE ${clauses.join(' AND ')}
        ORDER BY CASE p.status WHEN 'ACTIVE' THEN 0 WHEN 'PROPOSED' THEN 1 WHEN 'ON_HOLD' THEN 2 WHEN 'COMPLETED' THEN 3 ELSE 4 END, p.start_date DESC, p.reference`,
      params,
    );
    const data: ProjectSummaryView[] = [];
    for (const row of rows) {
      const level = await this.accessOf(row, profile);
      if (level) data.push(await this.summaryOf(row, level, accountId));
    }
    return { data, canCreate: await this.canCreate(profile) };
  }

  /** The project as one person may see it. Unknown and not-permitted look the same. */
  async detail(accountId: string, projectId: string) {
    const profile = await this.access.profile(accountId);
    const { row, level } = await this.loadVisible(profile, projectId);
    const summary = await this.summaryOf(row, level, accountId);
    const milestones = await this.milestones(row.id);
    const full = level === 'FULL';
    const overview = full || level === 'OVERVIEW';
    const tickets = await this.tickets(profile, row.id, full);
    const team = overview ? await this.team(row.id) : [];
    const events = overview ? await this.events(row.id) : [];
    await this.access.recordView(accountId, 'PROJECT', row.id, `${row.reference} — ${row.name}`);
    return {
      ...summary,
      // The line of command gets the frame only: no free text.
      description: level === 'SUMMARY' ? '' : row.description,
      statusReason: level === 'SUMMARY' ? null : row.status_reason,
      createdAt: new Date(row.created_at).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      businessCase: overview
        ? {
            status: row.business_case_status,
            problem: row.bc_problem,
            solution: row.bc_solution,
            benefits: row.bc_benefits,
            costs: row.bc_costs,
            risks: row.bc_risks,
            budget: row.budget === null ? null : Number(row.budget),
            submittedAt: row.bc_submitted_at ? new Date(row.bc_submitted_at).toISOString() : null,
            decidedAt: row.bc_decided_at ? new Date(row.bc_decided_at).toISOString() : null,
            decidedBy: row.bc_decider_name,
            returnReason: row.bc_return_reason,
          }
        : { status: row.business_case_status },
      milestones,
      tickets,
      ticketsShown: full ? 'all' : 'own',
      team,
      events,
      permissions: this.permissions(row, level, accountId, milestones),
    };
  }

  private async loadVisible(profile: AccessProfile, projectId: string): Promise<{ row: ProjectRow; level: ProjectAccess }> {
    if (!isUuid(projectId)) throw new NotFoundException('Unknown project.');
    const rows: ProjectRow[] = await this.dataSource.query(`${SELECT_PROJECT} WHERE p.id = $2`, [profile.accountId, projectId]);
    if (!rows.length) throw new NotFoundException('Unknown project.');
    const level = await this.accessOf(rows[0], profile);
    if (!level) throw new NotFoundException('Unknown project.');
    return { row: rows[0], level };
  }

  private async summaryOf(row: ProjectRow, level: ProjectAccess, accountId: string): Promise<ProjectSummaryView> {
    const milestones = await this.milestones(row.id);
    const active = milestones.find((m) => m.status === 'ACTIVE') ?? null;
    const tickets = milestones.reduce(
      (acc, m) => ({ total: acc.total + m.tickets.total, done: acc.done + m.tickets.done, open: acc.open + m.tickets.open, overdue: acc.overdue + m.tickets.overdue }),
      { total: 0, done: 0, open: 0, overdue: 0 },
    );
    const today = todayInSuriname();
    const running = ['PROPOSED', 'ACTIVE'].includes(row.status);
    return {
      id: row.id,
      reference: row.reference,
      name: row.name,
      status: row.status,
      classification: row.classification,
      unit: { id: row.unit_id, code: row.unit_code, name: row.unit_name },
      owner: { accountId: row.owner_account_id, name: row.owner_name },
      manager: { accountId: row.manager_account_id, name: row.manager_name },
      startDate: toDate(row.start_date),
      endDate: toDate(row.end_date),
      businessCaseStatus: row.business_case_status,
      phase: active ? { position: active.position, count: milestones.length, name: active.name } : null,
      progress: progressOf(milestones, row.status),
      late: running && (toDate(row.end_date) < today || milestones.some((m) => m.late)),
      ticketCounts: tickets,
      milestones: milestones.map(({ id, position, name, gate, startDate, endDate, status, late }) => ({ id, position, name, gate, startDate, endDate, status, late })),
      myRole: this.roleOf(row, accountId),
      access: level,
      memberCount: row.member_count,
      version: row.version,
    };
  }

  private async milestones(projectId: string): Promise<MilestoneView[]> {
    const today = todayInSuriname();
    const rows = await this.dataSource.query(
      `SELECT m.*,
              (SELECT count(*)::int FROM task t WHERE t.project_milestone_id = m.id AND t.parent_task_id IS NULL AND t.status NOT IN ('CANCELLED','REJECTED')) AS total,
              (SELECT count(*)::int FROM task t WHERE t.project_milestone_id = m.id AND t.parent_task_id IS NULL AND t.status = 'COMPLETED') AS done,
              -- open work counts subtasks too: a phase closes only when nothing in it is open
              (SELECT count(*)::int FROM task t WHERE t.project_milestone_id = m.id AND t.status = ANY($2)) AS open,
              (SELECT count(*)::int FROM task t WHERE t.project_milestone_id = m.id AND t.status = ANY($2) AND t.due_date < $3::date) AS overdue
         FROM project_milestone m WHERE m.project_id = $1 ORDER BY m.position`,
      [projectId, OPEN_STATES, today],
    );
    return rows.map((m: Record<string, unknown>) => ({
      id: m.id as string,
      position: m.position as number,
      name: m.name as string,
      description: m.description as string,
      gate: (m.gate as MilestoneView['gate']) ?? null,
      startDate: toDate(m.start_date as string),
      endDate: toDate(m.end_date as string),
      status: m.status as MilestoneView['status'],
      closedAt: m.closed_at ? new Date(m.closed_at as string).toISOString() : null,
      late: m.status !== 'CLOSED' && toDate(m.end_date as string) < today,
      tickets: { total: m.total as number, done: m.done as number, open: m.open as number, overdue: m.overdue as number },
    }));
  }

  /** The tickets a person may see: all of them for the owner and manager, otherwise only their own. */
  private async tickets(profile: AccessProfile, projectId: string, all: boolean): Promise<TicketView[]> {
    const params: unknown[] = [projectId];
    let where = 'true';
    if (!all) {
      const v = this.tasks.visibility(profile, 2);
      params.push(...v.params);
      where = v.sql;
    }
    const today = todayInSuriname();
    const rows = await this.dataSource.query(
      `SELECT t.id, t.reference, t.title, t.status, t.priority, t.start_date, t.due_date, t.completed_at,
              t.project_milestone_id, t.assignee_account_id, p.full_name AS assignee_name
         FROM task t JOIN project_milestone m ON m.id = t.project_milestone_id
         JOIN account a ON a.id = t.assignee_account_id JOIN person p ON p.id = a.person_id
        WHERE m.project_id = $1 AND t.parent_task_id IS NULL AND t.archived_at IS NULL AND ${where}
        ORDER BY m.position, t.start_date NULLS LAST, t.due_date NULLS LAST, t.reference`,
      params,
    );
    return rows.map((r: Record<string, unknown>) => {
      const due = r.due_date ? toDate(r.due_date as string) : null;
      return {
        id: r.id as string,
        reference: r.reference as string,
        title: r.title as string,
        status: r.status as string,
        priority: r.priority as string,
        startDate: r.start_date ? toDate(r.start_date as string) : null,
        dueDate: due,
        overdue: !!due && OPEN_STATES.includes(r.status as never) && due < today,
        milestoneId: r.project_milestone_id as string,
        assignee: { accountId: r.assignee_account_id as string, name: r.assignee_name as string },
        completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
      };
    });
  }

  private async team(projectId: string) {
    return this.dataSource.query(
      `SELECT m.account_id AS "accountId", p.full_name AS "name", p.job_position AS "jobPosition", m.role, u.name AS "unitName", m.added_at AS "addedAt",
              (SELECT count(*)::int FROM task t JOIN project_milestone pm ON pm.id = t.project_milestone_id
                WHERE pm.project_id = m.project_id AND t.assignee_account_id = m.account_id AND t.status = ANY($2)) AS "openTickets"
         FROM project_member m JOIN account a ON a.id = m.account_id JOIN person p ON p.id = a.person_id
         LEFT JOIN organisational_unit u ON u.id = a.organisational_unit_id
        WHERE m.project_id = $1 AND m.removed_at IS NULL
        ORDER BY CASE m.role WHEN 'STAKEHOLDER' THEN 0 ELSE 1 END, p.full_name`,
      [projectId, OPEN_STATES],
    );
  }

  private async events(projectId: string) {
    return this.dataSource.query(
      `SELECT e.event_type AS "eventType", e.note, e.occurred_at AS "occurredAt", p.full_name AS "actorName"
         FROM project_event e JOIN account a ON a.id = e.actor_account_id JOIN person p ON p.id = a.person_id
        WHERE e.project_id = $1 ORDER BY e.occurred_at DESC LIMIT 100`,
      [projectId],
    );
  }

  private permissions(row: ProjectRow, level: ProjectAccess, accountId: string, milestones: MilestoneView[]) {
    const owner = row.owner_account_id === accountId;
    const manager = row.manager_account_id === accountId;
    const lead = owner || manager;
    const live = ['PROPOSED', 'ACTIVE'].includes(row.status);
    const bcOpen = ['DRAFT', 'RETURNED'].includes(row.business_case_status) && row.status === 'PROPOSED';
    const active = milestones.find((m) => m.status === 'ACTIVE');
    return {
      canEdit: lead && !['COMPLETED', 'CANCELLED'].includes(row.status),
      canChangeOwnerOrManager: owner && !['COMPLETED', 'CANCELLED'].includes(row.status),
      canAddStakeholders: owner && !['COMPLETED', 'CANCELLED'].includes(row.status),
      canAddMembers: lead && !['COMPLETED', 'CANCELLED'].includes(row.status),
      canEditBusinessCase: manager && bcOpen,
      canSubmitBusinessCase: manager && bcOpen,
      canDecideBusinessCase: owner && row.business_case_status === 'SUBMITTED' && row.status === 'PROPOSED',
      canAddTickets: lead && live,
      canAddMilestone: lead && live,
      // Offered once every ticket of the current phase is finished.
      canCloseMilestone: !!active && live && active.gate === null && lead && active.tickets.open === 0,
      canSignOffClosure: !!active && live && active.gate === 'CLOSURE' && owner && active.tickets.open === 0,
      canHold: owner && live,
      canResume: owner && row.status === 'ON_HOLD',
      canCancel: owner && (live || row.status === 'ON_HOLD'),
      seesAllTickets: level === 'FULL',
    };
  }

  // ---------------------------------------------------------------- creating

  async create(actor: Actor, input: CreateProjectInput) {
    const profile = await this.access.profile(actor.accountId);
    if (!(await this.canCreate(profile))) {
      throw new ForbiddenException('Only the Minister, a Directeur, an Onder-Directeur or the head of a unit may start a project.');
    }
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('A project needs a name.');
    if (!DATE.test(input.startDate ?? '') || !DATE.test(input.endDate ?? '')) throw new BadRequestException('Enter a valid start and end date.');
    if (input.endDate < input.startDate) throw new BadRequestException('The end date must be on or after the start date.');
    const unit = await this.unitOrFail(input.unitId);
    const line = await this.summaryUnits(profile);
    if (line !== 'all' && !line.includes(unit.id) && profile.unitId !== unit.id) {
      throw new ForbiddenException('A project can only be started for a unit in your own line.');
    }
    const ownerId = input.ownerAccountId ?? actor.accountId;
    if (ownerId === input.managerAccountId) throw new BadRequestException('The owner and the project manager must be two different people: one writes the business case, the other decides on it.');
    await this.assertPerson(ownerId, 'owner');
    await this.assertPerson(input.managerAccountId, 'project manager');
    const phases = this.phases(input);
    const stakeholders = [...new Set(input.stakeholders ?? [])].filter((id) => id !== ownerId && id !== input.managerAccountId);
    const members = [...new Set(input.members ?? [])].filter((id) => id !== ownerId && id !== input.managerAccountId && !stakeholders.includes(id));
    for (const id of [...stakeholders, ...members]) await this.assertPerson(id, 'team member');
    const projectId = await this.dataSource.transaction(async (m) => {
      const [{ nextval }] = await m.query(`SELECT nextval('project_sequence') AS nextval`);
      const reference = `PRJ-${input.startDate.slice(0, 4)}-${String(nextval).padStart(3, '0')}`;
      const [row] = await m.query(
        `INSERT INTO project (reference, name, description, unit_id, owner_account_id, manager_account_id, classification, start_date, end_date, created_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [reference, name, (input.description ?? '').trim(), unit.id, ownerId, input.managerAccountId, input.classification ?? 'INTERNAL', input.startDate, input.endDate, actor.accountId],
      );
      const id = row.id as string;
      for (const [i, ph] of phases.entries()) {
        await m.query(
          `INSERT INTO project_milestone (project_id, position, name, description, gate, start_date, end_date, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, i + 1, ph.name, ph.description ?? '', i === 0 ? 'BUSINESS_CASE' : i === phases.length - 1 ? 'CLOSURE' : null, ph.startDate, ph.endDate, i === 0 ? 'ACTIVE' : 'PLANNED'],
        );
      }
      for (const s of stakeholders) await m.query(`INSERT INTO project_member (project_id, account_id, role, added_by_account_id) VALUES ($1,$2,'STAKEHOLDER',$3)`, [id, s, actor.accountId]);
      for (const s of members) await m.query(`INSERT INTO project_member (project_id, account_id, role, added_by_account_id) VALUES ($1,$2,'MEMBER',$3)`, [id, s, actor.accountId]);
      await this.event(m, id, 'CREATED', actor, `${phases.length} phases, ${readableDate(input.startDate)} – ${readableDate(input.endDate)}`);
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.PROJECT_CREATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${reference} — ${name}`.slice(0, 260),
        newValue: `owner ${await this.nameOf(m, ownerId)}, project manager ${await this.nameOf(m, input.managerAccountId)}, ${phases.length} phases`,
        summary: `${actor.description} started project ${reference} (${name}).`.slice(0, 600),
      });
      return id;
    });
    const [{ reference }] = await this.dataSource.query(`SELECT reference FROM project WHERE id = $1`, [projectId]);
    await this.tellRole(actor, projectId, reference, name, input.managerAccountId, 'MANAGER');
    if (ownerId !== actor.accountId) await this.tellRole(actor, projectId, reference, name, ownerId, 'OWNER');
    for (const s of stakeholders) await this.tellRole(actor, projectId, reference, name, s, 'STAKEHOLDER');
    for (const s of members) await this.tellRole(actor, projectId, reference, name, s, 'MEMBER');
    return this.detail(actor.accountId, projectId);
  }

  /** The phases: the person's own, or the standard four over the project's span. */
  private phases(input: CreateProjectInput): { name: string; startDate: string; endDate: string; description?: string }[] {
    if (input.milestones?.length) {
      if (input.milestones.length < 3 || input.milestones.length > 8) throw new BadRequestException('A project has between 3 and 8 phases: the business case, the work, and the closure.');
      for (const m of input.milestones) {
        if (!m.name?.trim()) throw new BadRequestException('Every phase needs a name.');
        if (!DATE.test(m.startDate ?? '') || !DATE.test(m.endDate ?? '') || m.endDate < m.startDate) throw new BadRequestException(`Enter valid dates for the phase "${m.name}".`);
      }
      return input.milestones.map((m) => ({ ...m, name: m.name.trim() }));
    }
    const shares = [0.15, 0.25, 0.45, 0.15];
    const names = ['Business case', 'Documentatie en ontwerp', 'Uitvoering', 'Afsluiting en overdracht'];
    const span = Math.max(dayDiff(input.startDate, input.endDate), 3);
    let from = input.startDate;
    return names.map((name, i) => {
      const last = i === names.length - 1;
      const days = Math.max(Math.round(span * shares[i]), 1);
      const to = last ? input.endDate : minDate(addDay(from, days - 1), input.endDate);
      const phase = { name, startDate: from, endDate: to < from ? from : to };
      from = minDate(addDay(phase.endDate, 1), input.endDate);
      return phase;
    });
  }

  // ---------------------------------------------------------------- changing the project

  async update(
    actor: Actor,
    projectId: string,
    input: { version: number; name?: string; description?: string; startDate?: string; endDate?: string; classification?: 'INTERNAL' | 'CONFIDENTIAL'; ownerAccountId?: string; managerAccountId?: string },
  ) {
    const { row } = await this.loadForChange(actor, projectId);
    const owner = row.owner_account_id === actor.accountId;
    if (!owner && row.manager_account_id !== actor.accountId) throw new ForbiddenException('Only the owner or the project manager may change the project.');
    if ((input.ownerAccountId || input.managerAccountId || input.classification) && !owner) {
      throw new ForbiddenException('Only the owner may hand the project over, appoint the project manager or change its classification.');
    }
    if (['COMPLETED', 'CANCELLED'].includes(row.status)) throw new BadRequestException('This project is closed.');
    if (row.version !== input.version) throw stale();
    if (input.name !== undefined && !input.name.trim()) throw new BadRequestException('A project needs a name.');
    const start = input.startDate ?? toDate(row.start_date);
    const end = input.endDate ?? toDate(row.end_date);
    if (!DATE.test(start) || !DATE.test(end) || end < start) throw new BadRequestException('The end date must be on or after the start date.');
    if (input.ownerAccountId) await this.assertPerson(input.ownerAccountId, 'owner');
    if (input.managerAccountId) await this.assertPerson(input.managerAccountId, 'project manager');
    const handingOver = (input.ownerAccountId && input.ownerAccountId !== row.owner_account_id) || (input.managerAccountId && input.managerAccountId !== row.manager_account_id);
    if (handingOver && row.business_case_status === 'SUBMITTED') {
      throw new BadRequestException('The business case is waiting for a decision. Decide on it (or return it) before changing the owner or the project manager.');
    }
    if ((input.ownerAccountId ?? row.owner_account_id) === (input.managerAccountId ?? row.manager_account_id)) {
      throw new BadRequestException('The owner and the project manager must be two different people: one writes the business case, the other decides on it.');
    }
    const changed: string[] = [];
    if (input.name !== undefined && input.name.trim() !== row.name) changed.push('name');
    if (input.description !== undefined && input.description.trim() !== row.description) changed.push('description');
    if (start !== toDate(row.start_date) || end !== toDate(row.end_date)) changed.push('dates');
    if (input.classification && input.classification !== row.classification) changed.push('classification');
    if (input.ownerAccountId && input.ownerAccountId !== row.owner_account_id) changed.push('owner');
    if (input.managerAccountId && input.managerAccountId !== row.manager_account_id) changed.push('project manager');
    if (!changed.length) return this.detail(actor.accountId, projectId);
    await this.dataSource.transaction(async (m) => {
      const out = await m.query(
        `UPDATE project SET name = coalesce($3, name), description = coalesce($4, description), start_date = $5, end_date = $6,
                classification = coalesce($7, classification), owner_account_id = coalesce($8, owner_account_id),
                manager_account_id = coalesce($9, manager_account_id), version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2`,
        [projectId, input.version, input.name?.trim() ?? null, input.description?.trim() ?? null, start, end, input.classification ?? null, input.ownerAccountId ?? null, input.managerAccountId ?? null],
      );
      if (out[1] === 0) throw stale();
      // A new owner or manager is no longer listed as a plain member.
      for (const id of [input.ownerAccountId, input.managerAccountId].filter(Boolean)) {
        await m.query(`UPDATE project_member SET removed_at = now() WHERE project_id = $1 AND account_id = $2 AND removed_at IS NULL`, [projectId, id]);
      }
      // A new project manager takes over the tickets the previous one owned; the
      // previous one keeps no access through them (TasksService.visibility).
      let moved = 0;
      if (changed.includes('project manager')) {
        const out = await m.query(
          `UPDATE task SET owner_account_id = $3, version = version + 1, updated_at = now()
            WHERE owner_account_id = $2 AND project_milestone_id IN (SELECT id FROM project_milestone WHERE project_id = $1)`,
          [projectId, row.manager_account_id, input.managerAccountId],
        );
        moved = out[1] ?? 0;
      }
      const handover: string[] = [];
      if (changed.includes('owner')) handover.push(`owner ${row.owner_name} → ${await this.nameOf(m, input.ownerAccountId!)}`);
      if (changed.includes('project manager')) handover.push(`project manager ${row.manager_name} → ${await this.nameOf(m, input.managerAccountId!)}${moved ? ` (${moved} ticket${moved === 1 ? '' : 's'} handed over)` : ''}`);
      await this.event(m, projectId, 'UPDATED', actor, [changed.filter((c) => c !== 'owner' && c !== 'project manager').join(', '), ...handover].filter(Boolean).join('; '));
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.PROJECT_UPDATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        previousValue: changed.includes('classification') ? row.classification : null,
        newValue: [changed.join(', '), ...handover].join('; ').slice(0, 600),
        summary: `${actor.description} changed ${changed.join(', ')} of project ${row.reference}${handover.length ? `: ${handover.join('; ')}` : ''}.`.slice(0, 600),
      });
    });
    if (input.managerAccountId && input.managerAccountId !== row.manager_account_id) await this.tellRole(actor, projectId, row.reference, row.name, input.managerAccountId, 'MANAGER');
    if (input.ownerAccountId && input.ownerAccountId !== row.owner_account_id) await this.tellRole(actor, projectId, row.reference, row.name, input.ownerAccountId, 'OWNER');
    return this.detail(actor.accountId, projectId);
  }

  async addMember(actor: Actor, projectId: string, accountId: string, role: 'STAKEHOLDER' | 'MEMBER') {
    const { row } = await this.loadForChange(actor, projectId);
    const owner = row.owner_account_id === actor.accountId;
    const manager = row.manager_account_id === actor.accountId;
    if (role === 'STAKEHOLDER' && !owner) throw new ForbiddenException('Only the owner appoints stakeholders.');
    if (!owner && !manager) throw new ForbiddenException('Only the owner or the project manager may add people to the project.');
    if (['COMPLETED', 'CANCELLED'].includes(row.status)) throw new BadRequestException('This project is closed.');
    if (accountId === row.owner_account_id || accountId === row.manager_account_id) throw new BadRequestException('The owner and the project manager are already on the project.');
    await this.assertPerson(accountId, 'team member');
    const [current] = await this.dataSource.query(`SELECT role FROM project_member WHERE project_id = $1 AND account_id = $2 AND removed_at IS NULL`, [projectId, accountId]);
    if (current?.role === role) throw new BadRequestException(`This person is already on the project as ${role === 'STAKEHOLDER' ? 'stakeholder' : 'team member'}.`);
    // Changing someone's role (stakeholder ↔ team member) is the owner's decision.
    if (current && !owner) throw new ForbiddenException("Only the owner changes a person's role on the project.");
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO project_member (project_id, account_id, role, added_by_account_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (project_id, account_id) DO UPDATE SET role = EXCLUDED.role, removed_at = NULL, added_by_account_id = EXCLUDED.added_by_account_id, added_at = now()`,
        [projectId, accountId, role, actor.accountId],
      );
      const who = await this.nameOf(m, accountId);
      await this.event(m, projectId, current ? 'MEMBER_ROLE_CHANGED' : 'MEMBER_ADDED', actor, `${who} (${role === 'STAKEHOLDER' ? 'stakeholder' : 'team'})`);
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.PROJECT_MEMBER_ADDED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        previousValue: current ? `${who}: ${String(current.role).toLowerCase()}` : null,
        newValue: `${who}: ${role.toLowerCase()}`,
        summary: (current
          ? `${actor.description} changed the role of ${who} on project ${row.reference} from ${String(current.role).toLowerCase()} to ${role.toLowerCase()}.`
          : `${actor.description} added ${who} to project ${row.reference} as ${role.toLowerCase()}.`
        ).slice(0, 600),
      });
    });
    await this.tellRole(actor, projectId, row.reference, row.name, accountId, role);
    return this.detail(actor.accountId, projectId);
  }

  async removeMember(actor: Actor, projectId: string, accountId: string) {
    const { row } = await this.loadForChange(actor, projectId);
    if (!isUuid(accountId)) throw new NotFoundException('This person is not on the project.');
    const owner = row.owner_account_id === actor.accountId;
    const manager = row.manager_account_id === actor.accountId;
    const [member] = await this.dataSource.query(`SELECT role FROM project_member WHERE project_id = $1 AND account_id = $2 AND removed_at IS NULL`, [projectId, accountId]);
    if (!member) throw new NotFoundException('This person is not on the project.');
    if (!owner && !(manager && member.role === 'MEMBER')) throw new ForbiddenException('Only the owner removes stakeholders; the owner or the project manager removes team members.');
    const [{ n }] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM task t JOIN project_milestone pm ON pm.id = t.project_milestone_id
        WHERE pm.project_id = $1 AND t.assignee_account_id = $2 AND t.status = ANY($3)`,
      [projectId, accountId, OPEN_STATES],
    );
    if (n > 0) throw new BadRequestException(`This person still holds ${n} open ticket${n === 1 ? '' : 's'}. Reassign them first.`);
    await this.dataSource.transaction(async (m) => {
      await m.query(`UPDATE project_member SET removed_at = now() WHERE project_id = $1 AND account_id = $2`, [projectId, accountId]);
      // Leaving the project ends following its tickets.
      await m.query(
        `DELETE FROM task_audience WHERE account_id = $2 AND task_id IN (SELECT t.id FROM task t JOIN project_milestone pm ON pm.id = t.project_milestone_id WHERE pm.project_id = $1)`,
        [projectId, accountId],
      );
      const who = await this.nameOf(m, accountId);
      await this.event(m, projectId, 'MEMBER_REMOVED', actor, who);
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.PROJECT_MEMBER_REMOVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        previousValue: `${who}: ${String(member.role).toLowerCase()}`,
        summary: `${actor.description} removed ${who} from project ${row.reference}.`.slice(0, 600),
      });
    });
    return this.detail(actor.accountId, projectId);
  }

  // ---------------------------------------------------------------- the business case

  async saveBusinessCase(
    actor: Actor,
    projectId: string,
    input: { version: number; problem?: string; solution?: string; benefits?: string; costs?: string; risks?: string; budget?: number | null },
  ) {
    const { row } = await this.loadForChange(actor, projectId);
    // Separation of duties: the project manager writes, the owner decides.
    if (row.manager_account_id !== actor.accountId) throw new ForbiddenException('The project manager writes the business case; the owner decides on it.');
    if (!(['DRAFT', 'RETURNED'].includes(row.business_case_status) && row.status === 'PROPOSED')) throw new BadRequestException('The business case can only be changed before it is submitted.');
    if (row.version !== input.version) throw stale();
    if (input.budget !== undefined && input.budget !== null && (!Number.isFinite(input.budget) || input.budget < 0)) throw new BadRequestException('Enter the budget as a positive amount.');
    await this.dataSource.transaction(async (m) => {
      const out = await m.query(
        `UPDATE project SET bc_problem = coalesce($3, bc_problem), bc_solution = coalesce($4, bc_solution), bc_benefits = coalesce($5, bc_benefits),
                bc_costs = coalesce($6, bc_costs), bc_risks = coalesce($7, bc_risks),
                budget = CASE WHEN $8::boolean THEN $9::numeric ELSE budget END, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2`,
        [projectId, input.version, clean(input.problem), clean(input.solution), clean(input.benefits), clean(input.costs), clean(input.risks), input.budget !== undefined, input.budget ?? null],
      );
      if (out[1] === 0) throw stale();
      const fields = (
        [
          ['problem', input.problem, row.bc_problem],
          ['solution', input.solution, row.bc_solution],
          ['benefits', input.benefits, row.bc_benefits],
          ['costs', input.costs, row.bc_costs],
          ['risks', input.risks, row.bc_risks],
        ] as [string, string | undefined, string | null][]
      )
        .filter(([, v, was]) => clean(v) !== null && clean(v) !== (was ?? ''))
        .map(([k]) => k);
      if (input.budget !== undefined && (input.budget ?? null) !== (row.budget === null ? null : Number(row.budget))) fields.push('budget');
      await this.event(m, projectId, 'BUSINESS_CASE_SAVED', actor, fields.length ? fields.join(', ') : null);
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.PROJECT_UPDATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        newValue: `business case: ${fields.join(', ') || 'saved without changes'}`,
        summary: `${actor.description} saved the business case of project ${row.reference}${fields.length ? ` (${fields.join(', ')})` : ''}.`.slice(0, 600),
      });
    });
    return this.detail(actor.accountId, projectId);
  }

  async submitBusinessCase(actor: Actor, projectId: string, version: number) {
    const { row } = await this.loadForChange(actor, projectId);
    if (row.manager_account_id !== actor.accountId) throw new ForbiddenException('The project manager submits the business case.');
    if (!(['DRAFT', 'RETURNED'].includes(row.business_case_status) && row.status === 'PROPOSED')) throw new BadRequestException('This business case is not open for submission.');
    if (row.version !== version) throw stale();
    const missing = [
      ['problem', row.bc_problem],
      ['solution', row.bc_solution],
      ['benefits', row.bc_benefits],
      ['costs', row.bc_costs],
    ].filter(([, v]) => !String(v ?? '').trim()).map(([k]) => k);
    if (missing.length) throw new BadRequestException(`Complete the business case first: ${missing.join(', ')}.`);
    const [bc] = await this.milestones(projectId);
    await this.dataSource.transaction(async (m) => {
      // Counted again under the project's lock: a ticket cannot slip in between.
      if (bc) await this.assertNothingOpen(m, projectId, bc.id, 'of the business case phase');
      const out = await m.query(
        `UPDATE project SET business_case_status = 'SUBMITTED', bc_submitted_at = now(), bc_return_reason = NULL, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2`,
        [projectId, version],
      );
      if (out[1] === 0) throw stale();
      await this.event(m, projectId, 'BUSINESS_CASE_SUBMITTED', actor, null);
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.BUSINESS_CASE_SUBMITTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        newValue: `to ${row.owner_name}`,
        summary: `${actor.description} submitted the business case of project ${row.reference} to ${row.owner_name}.`.slice(0, 600),
      });
    });
    await this.notifications.notify({
      recipients: [row.owner_account_id],
      kind: 'BUSINESS_CASE_SUBMITTED',
      params: { name: row.name, reference: row.reference, actor: actorName(actor) },
      link: `/projecten/${projectId}`,
      subjectType: 'PROJECT',
      subjectId: projectId,
      actorAccountId: actor.accountId,
    });
    return this.detail(actor.accountId, projectId);
  }

  /** The owner approves (the business case phase closes and the work starts) or returns it with a reason. */
  async decideBusinessCase(actor: Actor, projectId: string, decision: 'APPROVE' | 'RETURN', version: number, reason?: string) {
    const { row } = await this.loadForChange(actor, projectId);
    if (row.owner_account_id !== actor.accountId) throw new ForbiddenException('Only the owner of the project decides on the business case.');
    if (row.business_case_status !== 'SUBMITTED' || row.status !== 'PROPOSED') throw new BadRequestException('There is no business case waiting for a decision.');
    if (row.version !== version) throw stale();
    if (decision === 'RETURN' && !reason?.trim()) throw new BadRequestException('Give a reason for returning the business case.');
    // Separation of duties, whatever roles were swapped since: whoever wrote or
    // submitted this business case does not decide on it.
    const [wrote] = await this.dataSource.query(
      `SELECT 1 FROM project_event WHERE project_id = $1 AND actor_account_id = $2 AND event_type IN ('BUSINESS_CASE_SAVED','BUSINESS_CASE_SUBMITTED') LIMIT 1`,
      [projectId, actor.accountId],
    );
    if (wrote) throw new ForbiddenException('You wrote or submitted this business case, so you cannot decide on it. Hand the project over to another owner first.');
    const milestones = await this.milestones(projectId);
    const [bc, next] = milestones;
    await this.dataSource.transaction(async (m) => {
      if (decision === 'APPROVE') {
        await this.assertNothingOpen(m, projectId, bc.id, 'of the business case phase');
        const out = await m.query(
          `UPDATE project SET business_case_status = 'APPROVED', status = 'ACTIVE', bc_decided_at = now(), bc_decided_by_account_id = $3,
                  version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`,
          [projectId, version, actor.accountId],
        );
        if (out[1] === 0) throw stale();
        await m.query(`UPDATE project_milestone SET status = 'CLOSED', closed_at = now(), closed_by_account_id = $2 WHERE id = $1`, [bc.id, actor.accountId]);
        if (next) await m.query(`UPDATE project_milestone SET status = 'ACTIVE' WHERE id = $1`, [next.id]);
        await this.event(m, projectId, 'BUSINESS_CASE_APPROVED', actor, reason?.trim() || null);
        await this.audit.recordInTransaction(m, {
          eventType: AuditEventType.BUSINESS_CASE_APPROVED,
          actorAccountId: actor.accountId,
          actorDescription: actor.description,
          representedAuthority: actor.representedAuthority ?? null,
          subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
          previousValue: 'SUBMITTED',
          newValue: `APPROVED; phase "${bc.name}" closed${next ? `, phase "${next.name}" started` : ''}`,
          summary: `${actor.description} approved the business case of project ${row.reference}; the project is active.`.slice(0, 600),
        });
      } else {
        const out = await m.query(
          `UPDATE project SET business_case_status = 'RETURNED', bc_decided_at = now(), bc_decided_by_account_id = $3, bc_return_reason = $4,
                  version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`,
          [projectId, version, actor.accountId, reason!.trim().slice(0, 600)],
        );
        if (out[1] === 0) throw stale();
        await this.event(m, projectId, 'BUSINESS_CASE_RETURNED', actor, reason!.trim().slice(0, 600));
        await this.audit.recordInTransaction(m, {
          eventType: AuditEventType.BUSINESS_CASE_RETURNED,
          actorAccountId: actor.accountId,
          actorDescription: actor.description,
          representedAuthority: actor.representedAuthority ?? null,
          subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
          previousValue: 'SUBMITTED',
          newValue: 'RETURNED',
          summary: `${actor.description} returned the business case of project ${row.reference}: ${reason!.trim()}`.slice(0, 600),
        });
      }
    });
    const approved = decision === 'APPROVE';
    await this.notifications.notify({
      recipients: [row.manager_account_id],
      kind: 'BUSINESS_CASE_DECIDED',
      params: {
        name: row.name,
        reference: row.reference,
        actor: actorName(actor),
        decision: approved ? 'goedgekeurd' : 'teruggestuurd',
        decisionEn: approved ? 'approved' : 'returned',
        reason: approved ? null : reason!.trim(),
      },
      link: `/projecten/${projectId}`,
      subjectType: 'PROJECT',
      subjectId: projectId,
      actorAccountId: actor.accountId,
    });
    if (approved && next) await this.tellPhase(actor, row, projectId, next.name, `De business case is goedgekeurd; de fase "${next.name}" is begonnen.`, `The business case was approved; the phase "${next.name}" has started.`);
    return this.detail(actor.accountId, projectId);
  }

  // ---------------------------------------------------------------- milestones

  async addMilestone(actor: Actor, projectId: string, input: { name: string; description?: string; startDate: string; endDate: string }) {
    const { row } = await this.loadForChange(actor, projectId);
    if (row.owner_account_id !== actor.accountId && row.manager_account_id !== actor.accountId) throw new ForbiddenException('Only the owner or the project manager plans the phases.');
    if (!['PROPOSED', 'ACTIVE'].includes(row.status)) throw new BadRequestException('Phases can only be added to a running project.');
    if (!input.name?.trim()) throw new BadRequestException('A phase needs a name.');
    if (!DATE.test(input.startDate ?? '') || !DATE.test(input.endDate ?? '') || input.endDate < input.startDate) throw new BadRequestException('Enter a valid start and end date.');
    const milestones = await this.milestones(projectId);
    if (milestones.length >= 8) throw new BadRequestException('A project has at most 8 phases.');
    const closure = milestones[milestones.length - 1];
    if (closure.status !== 'PLANNED') throw new BadRequestException('The closure phase has started; no phases can be added any more.');
    await this.dataSource.transaction(async (m) => {
      // The new phase goes before the closure, which stays last.
      await m.query(`UPDATE project_milestone SET position = position + 100 WHERE id = $1`, [closure.id]);
      await m.query(
        `INSERT INTO project_milestone (project_id, position, name, description, start_date, end_date, status) VALUES ($1,$2,$3,$4,$5,$6,'PLANNED')`,
        [projectId, closure.position, input.name.trim(), (input.description ?? '').trim(), input.startDate, input.endDate],
      );
      await m.query(`UPDATE project_milestone SET position = $2 WHERE id = $1`, [closure.id, closure.position + 1]);
      await this.event(m, projectId, 'MILESTONE_ADDED', actor, input.name.trim());
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.MILESTONE_CHANGED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        newValue: `phase added: ${input.name.trim()} (${readableDate(input.startDate)} – ${readableDate(input.endDate)})`,
        summary: `${actor.description} added the phase "${input.name.trim()}" to project ${row.reference}.`.slice(0, 600),
      });
    });
    return this.detail(actor.accountId, projectId);
  }

  async updateMilestone(actor: Actor, projectId: string, milestoneId: string, input: { version: number; name?: string; description?: string; startDate?: string; endDate?: string }) {
    const { row } = await this.loadForChange(actor, projectId);
    if (row.owner_account_id !== actor.accountId && row.manager_account_id !== actor.accountId) throw new ForbiddenException('Only the owner or the project manager plans the phases.');
    if (!['PROPOSED', 'ACTIVE', 'ON_HOLD'].includes(row.status)) throw new BadRequestException('This project is closed.');
    if (row.version !== input.version) throw stale();
    const ms = (await this.milestones(projectId)).find((x) => x.id === milestoneId);
    if (!ms) throw new NotFoundException('Unknown phase.');
    if (ms.status === 'CLOSED') throw new BadRequestException('A closed phase cannot be changed.');
    const start = input.startDate ?? ms.startDate;
    const end = input.endDate ?? ms.endDate;
    if (!DATE.test(start) || !DATE.test(end) || end < start) throw new BadRequestException('Enter a valid start and end date.');
    if (input.name !== undefined && !input.name.trim()) throw new BadRequestException('A phase needs a name.');
    await this.dataSource.transaction(async (m) => {
      const out = await m.query(`UPDATE project SET version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`, [projectId, input.version]);
      if (out[1] === 0) throw stale();
      await m.query(`UPDATE project_milestone SET name = coalesce($2, name), description = coalesce($3, description), start_date = $4, end_date = $5 WHERE id = $1`, [
        milestoneId,
        input.name?.trim() ?? null,
        input.description?.trim() ?? null,
        start,
        end,
      ]);
      const what = `${input.name?.trim() ?? ms.name}: ${readableDate(start)} – ${readableDate(end)}`;
      await this.event(m, projectId, 'MILESTONE_CHANGED', actor, what);
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.MILESTONE_CHANGED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        previousValue: `${ms.name}: ${readableDate(ms.startDate)} – ${readableDate(ms.endDate)}`,
        newValue: what,
        summary: `${actor.description} changed the phase "${ms.name}" of project ${row.reference}.`.slice(0, 600),
      });
    });
    return this.detail(actor.accountId, projectId);
  }

  /**
   * Closes the active phase once its tickets are done, and starts the next. The
   * business case phase closes only through the owner's approval; the closure
   * phase is signed off by the owner and completes the project.
   */
  async closeMilestone(actor: Actor, projectId: string, milestoneId: string, version: number, note?: string) {
    const { row } = await this.loadForChange(actor, projectId);
    const owner = row.owner_account_id === actor.accountId;
    const lead = owner || row.manager_account_id === actor.accountId;
    if (!lead) throw new ForbiddenException('Only the owner or the project manager closes a phase.');
    if (!['PROPOSED', 'ACTIVE'].includes(row.status)) throw new BadRequestException('This project is not running.');
    if (row.version !== version) throw stale();
    const milestones = await this.milestones(projectId);
    const i = milestones.findIndex((x) => x.id === milestoneId);
    const ms = milestones[i];
    if (!ms) throw new NotFoundException('Unknown phase.');
    if (ms.status !== 'ACTIVE') throw new BadRequestException('Only the current phase can be closed.');
    if (ms.gate === 'BUSINESS_CASE') throw new BadRequestException('The business case phase closes when the owner approves the business case.');
    if (ms.gate === 'CLOSURE' && !owner) throw new ForbiddenException('The owner signs off the closure of the project.');
    const next = milestones[i + 1];
    const completes = ms.gate === 'CLOSURE';
    if (completes && milestones.some((x) => x.id !== ms.id && x.status !== 'CLOSED')) throw new BadRequestException('Close every other phase before signing off the project.');
    await this.dataSource.transaction(async (m) => {
      await this.assertNothingOpen(m, projectId, ms.id, 'of this phase');
      await m.query(`UPDATE project_milestone SET status = 'CLOSED', closed_at = now(), closed_by_account_id = $2 WHERE id = $1`, [ms.id, actor.accountId]);
      if (next) await m.query(`UPDATE project_milestone SET status = 'ACTIVE' WHERE id = $1`, [next.id]);
      const out = await m.query(
        `UPDATE project SET version = version + 1, updated_at = now(),
                status = CASE WHEN $3::boolean THEN 'COMPLETED' ELSE status END,
                completed_at = CASE WHEN $3::boolean THEN now() ELSE completed_at END
          WHERE id = $1 AND version = $2`,
        [projectId, version, completes],
      );
      if (out[1] === 0) throw stale();
      await this.event(m, projectId, completes ? 'COMPLETED' : 'MILESTONE_CLOSED', actor, note?.trim() || ms.name);
      await this.audit.recordInTransaction(m, {
        eventType: completes ? AuditEventType.PROJECT_COMPLETED : AuditEventType.MILESTONE_CLOSED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        previousValue: ms.name,
        newValue: completes ? 'project completed' : next ? `next phase: ${next.name}` : null,
        summary: (completes
          ? `${actor.description} signed off the closure of project ${row.reference}; the project is completed.`
          : `${actor.description} closed the phase "${ms.name}" of project ${row.reference}${next ? `; "${next.name}" has started` : ''}.`
        ).slice(0, 600),
      });
    });
    if (completes) await this.tellPhase(actor, row, projectId, 'afgerond', 'Het project is afgerond en door de opdrachtgever afgetekend.', 'The project is completed and signed off by the owner.', 'completed');
    else if (next) await this.tellPhase(actor, row, projectId, next.name, `De fase "${ms.name}" is afgesloten; "${next.name}" is begonnen.`, `The phase "${ms.name}" is closed; "${next.name}" has started.`);
    return this.detail(actor.accountId, projectId);
  }

  // ---------------------------------------------------------------- tickets

  async addTicket(
    actor: Actor,
    projectId: string,
    input: { milestoneId: string; title: string; description?: string; assigneeAccountId: string; startDate?: string; dueDate?: string; priority?: string; checklist?: string[] },
  ) {
    const { row } = await this.loadForChange(actor, projectId);
    if (row.owner_account_id !== actor.accountId && row.manager_account_id !== actor.accountId) throw new ForbiddenException('Only the owner or the project manager adds tickets.');
    if (!['PROPOSED', 'ACTIVE'].includes(row.status)) throw new BadRequestException('Tickets can only be added to a running project.');
    const ms = (await this.milestones(projectId)).find((x) => x.id === input.milestoneId);
    if (!ms) throw new BadRequestException('Choose a phase of this project.');
    if (ms.status === 'CLOSED') throw new BadRequestException('This phase is closed.');
    await this.assertPerson(input.assigneeAccountId, 'assignee');
    const task = await this.tasks.create(actor, {
      title: input.title,
      description: input.description,
      assigneeAccountId: input.assigneeAccountId,
      ownerAccountId: row.manager_account_id,
      dueDate: input.dueDate ?? null,
      startDate: input.startDate ?? null,
      priority: input.priority,
      checklist: input.checklist,
      projectMilestoneId: ms.id,
    });
    // The holder joins the team and the history records the ticket number, in the
    // same transaction as the ticket itself (TasksService.create, ticket-rules.ts).
    return task;
  }

  // ---------------------------------------------------------------- status

  async changeStatus(actor: Actor, projectId: string, action: 'HOLD' | 'RESUME' | 'CANCEL', version: number, reason?: string) {
    const { row } = await this.loadForChange(actor, projectId);
    if (row.owner_account_id !== actor.accountId) throw new ForbiddenException('Only the owner puts a project on hold, resumes or cancels it.');
    if (row.version !== version) throw stale();
    let to: ProjectStatus;
    if (action === 'HOLD') {
      if (!['PROPOSED', 'ACTIVE'].includes(row.status)) throw new BadRequestException('Only a running project can be put on hold.');
      to = 'ON_HOLD';
    } else if (action === 'RESUME') {
      if (row.status !== 'ON_HOLD') throw new BadRequestException('This project is not on hold.');
      to = row.status_before_hold ?? 'ACTIVE';
    } else {
      if (!['PROPOSED', 'ACTIVE', 'ON_HOLD'].includes(row.status)) throw new BadRequestException('This project is already closed.');
      to = 'CANCELLED';
    }
    if (!reason?.trim()) throw new BadRequestException('Give a reason.');
    let cancelledTickets = 0;
    await this.dataSource.transaction(async (m) => {
      const out = await m.query(
        `UPDATE project SET status = $3::varchar, status_before_hold = CASE WHEN $3::varchar = 'ON_HOLD' THEN status ELSE NULL END, status_reason = $4,
                version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`,
        [projectId, version, to, reason?.trim().slice(0, 600) ?? null],
      );
      if (out[1] === 0) throw stale();
      if (to === 'CANCELLED') {
        // A stopped project leaves no open work in anyone's list.
        const open: { id: string; status: string }[] = await m.query(
          `SELECT t.id, t.status FROM task t JOIN project_milestone pm ON pm.id = t.project_milestone_id
            WHERE pm.project_id = $1 AND t.status = ANY($2) FOR UPDATE OF t`,
          [projectId, OPEN_STATES],
        );
        for (const t of open) {
          await m.query(`UPDATE task SET status = 'CANCELLED', cancelled_reason = $2, version = version + 1, updated_at = now() WHERE id = $1`, [
            t.id,
            `Project ${row.reference} stopgezet`,
          ]);
          await m.query(
            `INSERT INTO task_event (task_id, event_type, actor_account_id, from_value, to_value, note) VALUES ($1, 'CANCELLED', $2, $3, 'CANCELLED', $4)`,
            [t.id, actor.accountId, t.status, `Project ${row.reference} stopgezet`],
          );
        }
        cancelledTickets = open.length;
      }
      await this.event(m, projectId, `STATUS_${to}`, actor, reason?.trim().slice(0, 600) ?? null);
      await this.audit.recordInTransaction(m, {
        eventType: AuditEventType.PROJECT_STATUS_CHANGED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${row.reference} — ${row.name}`.slice(0, 260),
        previousValue: row.status,
        newValue: to,
        summary: `${actor.description} set project ${row.reference} to ${to.toLowerCase().replace('_', ' ')}: ${reason!.trim()}${cancelledTickets ? ` (${cancelledTickets} open ticket${cancelledTickets === 1 ? '' : 's'} cancelled)` : ''}.`.slice(0, 600),
      });
    });
    const nl = { ON_HOLD: 'gepauzeerd', CANCELLED: 'stopgezet', ACTIVE: 'hervat', PROPOSED: 'hervat', COMPLETED: 'afgerond' }[to];
    const en = { ON_HOLD: 'on hold', CANCELLED: 'cancelled', ACTIVE: 'resumed', PROPOSED: 'resumed', COMPLETED: 'completed' }[to];
    await this.tellPhase(actor, row, projectId, nl, `Het project is ${nl}${reason?.trim() ? `: ${reason.trim()}` : '.'}`, `The project is ${en}${reason?.trim() ? `: ${reason.trim()}` : '.'}`, en);
    return this.detail(actor.accountId, projectId);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Inside a transaction: locks the project and counts the open work (subtasks
   * included) of a phase, so that a new ticket and a gate cannot pass each other.
   */
  private async assertNothingOpen(m: EntityManager, projectId: string, milestoneId: string, where: string): Promise<void> {
    await m.query(`SELECT 1 FROM project WHERE id = $1 FOR UPDATE`, [projectId]);
    const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM task WHERE project_milestone_id = $1 AND status = ANY($2)`, [milestoneId, OPEN_STATES]);
    if (n > 0) throw new BadRequestException(`Close the ${n} open ticket${n === 1 ? '' : 's'} ${where} first.`);
  }

  /** A change needs the project in view (unknown and not-permitted look the same). */
  private async loadForChange(actor: Actor, projectId: string) {
    const profile = await this.access.profile(actor.accountId);
    return this.loadVisible(profile, projectId);
  }

  private async unitOrFail(unitId: string): Promise<{ id: string }> {
    if (!isUuid(unitId)) throw new BadRequestException('Choose the unit the project belongs to.');
    const [unit] = await this.dataSource.query(`SELECT id FROM organisational_unit WHERE id = $1 AND is_active`, [unitId]);
    if (!unit) throw new BadRequestException('Choose the unit the project belongs to.');
    return unit;
  }

  /** Projects are for people with a business role: never the system administrator or the auditor alone. */
  private async assertPerson(accountId: string, what: string): Promise<void> {
    if (!isUuid(accountId)) throw new BadRequestException(`Choose the ${what}.`);
    if (!(await isProjectPerson(this.dataSource, accountId))) throw new BadRequestException(`The ${what} must be an active ministry account.`);
  }

  private async event(m: EntityManager, projectId: string, type: string, actor: Actor, note: string | null): Promise<void> {
    await m.query(`INSERT INTO project_event (project_id, event_type, actor_account_id, note) VALUES ($1, $2, $3, $4)`, [projectId, type, actor.accountId, note?.slice(0, 600) ?? null]);
  }

  private async nameOf(m: EntityManager, accountId: string): Promise<string> {
    const [row] = await m.query(`SELECT p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1`, [accountId]);
    return row?.full_name ?? 'unknown';
  }

  private async tellRole(actor: Actor, projectId: string, reference: string, name: string, accountId: string, role: ProjectRole) {
    if (accountId === actor.accountId) return;
    const nl = { OWNER: 'opdrachtgever', MANAGER: 'projectleider', STAKEHOLDER: 'belanghebbende', MEMBER: 'teamlid' }[role];
    const en = { OWNER: 'owner', MANAGER: 'project manager', STAKEHOLDER: 'stakeholder', MEMBER: 'team member' }[role];
    await this.notifications.notify({
      recipients: [accountId],
      kind: 'PROJECT_ROLE',
      params: { reference, name, role: nl, roleEn: en, actor: actorName(actor) },
      link: `/projecten/${projectId}`,
      subjectType: 'PROJECT',
      subjectId: projectId,
      actorAccountId: actor.accountId,
    });
  }

  /** Tells the people on the project about a new phase or status. */
  private async tellPhase(actor: Actor, row: ProjectRow, projectId: string, phase: string, change: string, changeEn: string, phaseEn = phase) {
    const members: { account_id: string }[] = await this.dataSource.query(`SELECT account_id FROM project_member WHERE project_id = $1 AND removed_at IS NULL`, [projectId]);
    const recipients = [...new Set([row.owner_account_id, row.manager_account_id, ...members.map((x) => x.account_id)])].filter((id) => id !== actor.accountId);
    if (!recipients.length) return;
    await this.notifications.notify({
      recipients,
      kind: 'PROJECT_PHASE',
      params: { reference: row.reference, name: row.name, phase, phaseEn, change, changeEn },
      link: `/projecten/${projectId}`,
      subjectType: 'PROJECT',
      subjectId: projectId,
      actorAccountId: actor.accountId,
    });
  }
}

/**
 * Progress over the phases: a closed phase counts in full, the current phase by
 * its finished tickets, a planned phase not yet. A completed project is 100.
 */
export function progressOf(milestones: Pick<MilestoneView, 'status' | 'tickets'>[], status: ProjectStatus): number {
  if (status === 'COMPLETED') return 100;
  if (!milestones.length) return 0;
  const sum = milestones.reduce((acc, m) => acc + (m.status === 'CLOSED' ? 1 : m.status === 'ACTIVE' && m.tickets.total ? m.tickets.done / m.tickets.total : 0), 0);
  return Math.round((sum / milestones.length) * 100);
}

function toDate(value: string | Date): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function addDay(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayDiff(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function clean(v: string | undefined): string | null {
  return v === undefined ? null : v.trim().slice(0, 8000);
}

function stale(): ConflictException {
  return new ConflictException('Someone else changed this project in the meantime. Reload and try again.');
}

function actorName(actor: Actor): string {
  return actor.description.replace(/\s*\(.*\)$/, '');
}

/** A project as the detail screen (and the assistant) receives it. */
export type ProjectDetail = Awaited<ReturnType<ProjectsService['detail']>>;
