import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccessProfile, AccessService } from '../access/access.service';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { MANAGEMENT_ROLES, readableDate, todayInSuriname } from '../common/actor';
import { loadDocumentConfig } from '../config/document-config';
import { MalwareScanService } from '../core/malware-scan.service';
import { NotificationService } from '../core/notification.service';
import { addDays, WorkingDaysService } from '../core/working-days.service';
import { DocumentStorage } from '../documents/document-storage';
import { Actor } from '../records/registration.service';
import { SettingsService } from '../settings/settings.service';
import { assertPhaseTakesWork, isOnProject, isProjectPerson, joinAsTicketHolder, leads, lockTicketProject } from '../projects/ticket-rules';

export type TaskStatus = 'OPEN' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING' | 'IN_REVIEW' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';
export const OPEN_STATES: TaskStatus[] = ['OPEN', 'ACCEPTED', 'IN_PROGRESS', 'WAITING', 'IN_REVIEW'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/** The moves a task may make. Anything else is refused. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  OPEN: ['ACCEPTED', 'IN_PROGRESS', 'WAITING', 'IN_REVIEW', 'COMPLETED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['IN_PROGRESS', 'WAITING', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['WAITING', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'],
  WAITING: ['IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'],
  IN_REVIEW: ['IN_PROGRESS', 'WAITING', 'COMPLETED', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  REJECTED: ['OPEN', 'CANCELLED'],
  CANCELLED: [],
};

export interface PersonRef {
  accountId: string;
  name: string;
}

export interface TaskView {
  id: string;
  reference: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: string;
  dueDate: string | null;
  /** Tickets in a project milestone have a start date for the Gantt chart. */
  startDate: string | null;
  overdue: boolean;
  dueInWorkingDays: number | null;
  assignee: PersonRef;
  owner: PersonRef;
  createdBy: PersonRef;
  dossier: { id: string; identity: string; subject: string } | null;
  item: { id: string; identity: string | null; subject: string } | null;
  /** Set when the task is a ticket in a project milestone. */
  project: { id: string; reference: string; name: string; milestoneId: string; milestoneName: string } | null;
  parentTaskId: string | null;
  parentReference: string | null;
  checklistDone: number;
  checklistTotal: number;
  subtaskOpen: number;
  subtaskTotal: number;
  commentCount: number;
  attachmentCount: number;
  audienceCount: number;
  recurrence: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  rejectionReason: string | null;
  cancelledReason: string | null;
  version: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assigneeAccountId: string;
  ownerAccountId?: string;
  audience?: string[];
  dueDate?: string | null;
  priority?: string;
  dossierId?: string | null;
  itemId?: string | null;
  parentTaskId?: string | null;
  checklist?: string[];
  recurrence?: string;
  source?: string;
  templateId?: string | null;
  /** Only through ProjectsService: the ticket's milestone and start date. */
  projectMilestoneId?: string | null;
  startDate?: string | null;
}

export interface TaskListQuery {
  scope?: 'my' | 'owner' | 'audience' | 'assigned' | 'all' | 'unit';
  status?: string;
  priority?: string;
  q?: string;
  dossierId?: string;
  itemId?: string;
  due?: 'overdue' | 'today' | 'week';
  assigneeAccountId?: string;
  includeArchived?: boolean;
  includeClosed?: boolean;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

const SELECT_VIEW = `
  SELECT t.*,
         ap.full_name AS assignee_name, op.full_name AS owner_name, cp.full_name AS creator_name,
         d.dossier_identity, d.subject AS dossier_subject,
         ci.registration_identity AS item_identity, ci.subject AS item_subject,
         pt.reference AS parent_reference,
         pm.name AS milestone_name, pr.id AS project_id, pr.reference AS project_reference, pr.name AS project_name,
         (SELECT count(*)::int FROM task_checklist_item x WHERE x.task_id = t.id AND x.removed_at IS NULL) AS checklist_total,
         (SELECT count(*)::int FROM task_checklist_item x WHERE x.task_id = t.id AND x.removed_at IS NULL AND x.done) AS checklist_done,
         (SELECT count(*)::int FROM task s WHERE s.parent_task_id = t.id) AS subtask_total,
         (SELECT count(*)::int FROM task s WHERE s.parent_task_id = t.id AND s.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW')) AS subtask_open,
         (SELECT count(*)::int FROM task_comment c WHERE c.task_id = t.id) AS comment_count,
         (SELECT count(*)::int FROM task_attachment c WHERE c.task_id = t.id) AS attachment_count,
         (SELECT count(*)::int FROM task_audience c WHERE c.task_id = t.id) AS audience_count
    FROM task t
    JOIN account aa ON aa.id = t.assignee_account_id JOIN person ap ON ap.id = aa.person_id
    JOIN account oa ON oa.id = t.owner_account_id JOIN person op ON op.id = oa.person_id
    JOIN account ca ON ca.id = t.created_by_account_id JOIN person cp ON cp.id = ca.person_id
    LEFT JOIN dossier d ON d.id = t.dossier_id
    LEFT JOIN correspondence_item ci ON ci.id = t.correspondence_item_id
    LEFT JOIN task pt ON pt.id = t.parent_task_id
    LEFT JOIN project_milestone pm ON pm.id = t.project_milestone_id
    LEFT JOIN project pr ON pr.id = pm.project_id`;

/**
 * Tasks and actions — the work that a letter or a matter calls for, assigned
 * to a person, with a deadline, inside the record system instead of beside it.
 *
 * Every change is one transaction with its task event and its audit event. A
 * task is never deleted: it is cancelled with a reason, or archived once done.
 */
@Injectable()
export class TasksService {
  private readonly storage = new DocumentStorage(loadDocumentConfig().storageRoot);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    private readonly workingDays: WorkingDaysService,
    private readonly scanner: MalwareScanService,
  ) {}

  // ---------------------------------------------------------------- reading

  async list(accountId: string, query: TaskListQuery): Promise<{ data: TaskView[]; total: number; page: number; limit: number }> {
    const { where, params } = await this.listFilter(accountId, query);
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
    const page = Math.max(Number(query.page) || 1, 1);
    const [{ total }] = await this.dataSource.query(`SELECT count(*)::int AS total FROM task t WHERE ${where}`, params);
    const rows = await this.dataSource.query(
      `${SELECT_VIEW} WHERE ${where}
        ORDER BY (t.status IN ('COMPLETED','CANCELLED','REJECTED')),
                 t.due_date ASC NULLS LAST,
                 CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                 t.created_at DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    );
    return { data: await this.views(rows), total, page, limit };
  }

  async counts(accountId: string): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const scope of ['my', 'owner', 'audience', 'assigned', 'all'] as const) {
      const { where, params } = await this.listFilter(accountId, { scope });
      const [{ n }] = await this.dataSource.query(
        `SELECT count(*)::int AS n FROM task t WHERE ${where} AND t.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW')`,
        params,
      );
      result[scope] = n;
    }
    const { where, params } = await this.listFilter(accountId, { scope: 'my', due: 'overdue' });
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM task t WHERE ${where}`, params);
    result.overdue = n;
    return result;
  }

  /**
   * The filter for a list. Visibility first: a person sees tasks they created,
   * own, hold, or are in the audience of; managers see every task; a unit head
   * sees the tasks held in their unit. A task on a classified matter is shown
   * only to someone who may see that matter or who is part of the task.
   */
  /**
   * Which tasks a person may see, as SQL on alias t, with parameters numbered
   * from `next`. The same rule the task screens use; the assistant uses it too.
   */
  visibility(profile: AccessProfile, next: number, alias = 't'): { sql: string; params: unknown[] } {
    const params: unknown[] = [profile.accountId];
    const me = `$${next}`;
    const t = alias;
    const manager = profile.roles.some((r) => MANAGEMENT_ROLES.includes(r));
    const involved = `(${t}.created_by_account_id = ${me} OR ${t}.owner_account_id = ${me} OR ${t}.assignee_account_id = ${me}
        OR EXISTS (SELECT 1 FROM task_audience ta WHERE ta.task_id = ${t}.id AND ta.account_id = ${me}))`;
    const headOf = `EXISTS (SELECT 1 FROM account x JOIN organisational_unit u ON u.id = x.organisational_unit_id
        WHERE x.id = ${t}.assignee_account_id AND u.head_account_id = ${me})`;
    const dp = this.access.dossierPredicate(profile, 'dd', next + params.length);
    params.push(...dp.params);
    const ip = this.access.itemPredicate(profile, 'ii', next + params.length);
    params.push(...ip.params);
    const matterOk = `((${t}.dossier_id IS NULL OR EXISTS (SELECT 1 FROM dossier dd WHERE dd.id = ${t}.dossier_id AND ${dp.sql}))
        AND (${t}.correspondence_item_id IS NULL OR EXISTS (SELECT 1 FROM correspondence_item ii WHERE ii.id = ${t}.correspondence_item_id AND ${ip.sql})))`;
    // A project ticket is need-to-know: whoever holds or follows it and the project's
    // current owner and manager — not the line of command, not other team members.
    // Having created, owned or followed a ticket counts only while the person is still
    // on the project: a replaced project manager loses the tickets with the project.
    const projectLead = `EXISTS (SELECT 1 FROM project_milestone pm_v JOIN project p_v ON p_v.id = pm_v.project_id
        WHERE pm_v.id = ${t}.project_milestone_id AND (p_v.owner_account_id = ${me} OR p_v.manager_account_id = ${me}))`;
    const stillOnProject = `EXISTS (SELECT 1 FROM project_milestone pm_w JOIN project_member pmm ON pmm.project_id = pm_w.project_id
        WHERE pm_w.id = ${t}.project_milestone_id AND pmm.account_id = ${me} AND pmm.removed_at IS NULL)`;
    const ticketInvolved = `(${t}.assignee_account_id = ${me}
        OR ((${t}.created_by_account_id = ${me} OR ${t}.owner_account_id = ${me}
             OR EXISTS (SELECT 1 FROM task_audience ta WHERE ta.task_id = ${t}.id AND ta.account_id = ${me})) AND ${stillOnProject}))`;
    return {
      sql: `((${t}.project_milestone_id IS NULL AND (${involved} OR ((${manager ? 'true' : 'false'} OR ${headOf}) AND ${matterOk})))
        OR (${t}.project_milestone_id IS NOT NULL AND (${ticketInvolved} OR ${projectLead})))`,
      params,
    };
  }

  /** Whether the person runs (owns or manages) the project a ticket belongs to. */
  private async leadsProjectOf(accountId: string, task: TaskView): Promise<boolean> {
    if (!task.project) return false;
    const [row] = await this.dataSource.query(
      `SELECT 1 FROM project WHERE id = $1 AND (owner_account_id = $2 OR manager_account_id = $2)`,
      [task.project.id, accountId],
    );
    return !!row;
  }

  private async listFilter(accountId: string, query: TaskListQuery): Promise<{ where: string; params: unknown[] }> {
    const profile = await this.access.profile(accountId);
    const v = this.visibility(profile, 1);
    const params: unknown[] = [...v.params];
    const me = '$1';
    const visible = v.sql;
    const clauses = [visible];
    switch (query.scope ?? 'all') {
      case 'my':
        clauses.push(`t.assignee_account_id = ${me}`);
        break;
      case 'owner':
        clauses.push(`t.owner_account_id = ${me}`);
        break;
      case 'audience':
        clauses.push(`EXISTS (SELECT 1 FROM task_audience ta WHERE ta.task_id = t.id AND ta.account_id = ${me})`);
        break;
      case 'assigned':
        clauses.push(`t.created_by_account_id = ${me} AND t.assignee_account_id <> ${me}`);
        break;
      case 'unit':
        clauses.push(`EXISTS (SELECT 1 FROM account x WHERE x.id = t.assignee_account_id AND x.organisational_unit_id = (SELECT organisational_unit_id FROM account WHERE id = ${me}))`);
        break;
      default:
        break;
    }
    if (!query.includeArchived) clauses.push('t.archived_at IS NULL');
    if (query.status) {
      const statuses = query.status.split(',').filter((s) => Object.keys(TRANSITIONS).includes(s));
      if (statuses.length) {
        params.push(statuses);
        clauses.push(`t.status = ANY($${params.length})`);
      }
    } else if (query.includeClosed === false) {
      clauses.push(`t.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW')`);
    }
    if (query.priority && PRIORITIES.includes(query.priority)) {
      params.push(query.priority);
      clauses.push(`t.priority = $${params.length}`);
    }
    if (query.q?.trim()) {
      params.push(`%${query.q.trim()}%`);
      clauses.push(`(t.title ILIKE $${params.length} OR t.reference ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
    }
    if (query.dossierId) {
      params.push(query.dossierId);
      clauses.push(`t.dossier_id = $${params.length}`);
    }
    if (query.itemId) {
      params.push(query.itemId);
      clauses.push(`t.correspondence_item_id = $${params.length}`);
    }
    if (query.assigneeAccountId) {
      params.push(query.assigneeAccountId);
      clauses.push(`t.assignee_account_id = $${params.length}`);
    }
    const today = todayInSuriname();
    if (query.due === 'overdue') {
      params.push(today);
      clauses.push(`t.due_date < $${params.length}::date AND t.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW')`);
    } else if (query.due === 'today') {
      params.push(today);
      clauses.push(`t.due_date = $${params.length}::date`);
    } else if (query.due === 'week') {
      params.push(today, addDays(today, 7));
      clauses.push(`t.due_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`);
    }
    if (query.from) {
      params.push(query.from);
      clauses.push(`t.due_date >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(query.to);
      clauses.push(`t.due_date <= $${params.length}::date`);
    }
    return { where: clauses.join(' AND '), params };
  }

  async detail(accountId: string, taskId: string) {
    const task = await this.viewOrFail(accountId, taskId);
    const [checklist, subtasks, comments, attachments, audience, events] = await Promise.all([
      this.dataSource.query(
        `SELECT c.id, c.label, c.position, c.done, c.done_at AS "doneAt", p.full_name AS "doneByName"
           FROM task_checklist_item c LEFT JOIN account a ON a.id = c.done_by_account_id LEFT JOIN person p ON p.id = a.person_id
          WHERE c.task_id = $1 AND c.removed_at IS NULL ORDER BY c.position, c.created_at`,
        [taskId],
      ),
      this.dataSource.query(`${SELECT_VIEW} WHERE t.parent_task_id = $1 ORDER BY t.created_at`, [taskId]).then((rows) => this.views(rows)),
      this.dataSource.query(
        `SELECT c.id, c.body, c.created_at AS "createdAt", p.full_name AS "authorName", c.author_account_id AS "authorAccountId"
           FROM task_comment c JOIN account a ON a.id = c.author_account_id JOIN person p ON p.id = a.person_id
          WHERE c.task_id = $1 ORDER BY c.created_at`,
        [taskId],
      ),
      this.dataSource.query(
        `SELECT t.id, t.original_filename AS "filename", t.media_type AS "mediaType", t.byte_size::int AS "byteSize",
                t.content_hash AS "contentHash", t.uploaded_at AS "uploadedAt", p.full_name AS "uploadedByName"
           FROM task_attachment t JOIN account a ON a.id = t.uploaded_by_account_id JOIN person p ON p.id = a.person_id
          WHERE t.task_id = $1 ORDER BY t.uploaded_at`,
        [taskId],
      ),
      this.dataSource.query(
        `SELECT ta.account_id AS "accountId", p.full_name AS "name"
           FROM task_audience ta JOIN account a ON a.id = ta.account_id JOIN person p ON p.id = a.person_id
          WHERE ta.task_id = $1 ORDER BY p.full_name`,
        [taskId],
      ),
      this.dataSource.query(
        `SELECT e.event_type AS "eventType", e.from_value AS "fromValue", e.to_value AS "toValue", e.note,
                e.occurred_at AS "occurredAt", p.full_name AS "actorName", obp.full_name AS "onBehalfOfName"
           FROM task_event e JOIN account a ON a.id = e.actor_account_id JOIN person p ON p.id = a.person_id
           LEFT JOIN account oba ON oba.id = e.on_behalf_of_account_id LEFT JOIN person obp ON obp.id = oba.person_id
          WHERE e.task_id = $1 ORDER BY e.occurred_at`,
        [taskId],
      ),
    ]);
    await this.access.recordView(accountId, 'TASK', taskId, `${task.reference} — ${task.title}`);
    return { task, checklist, subtasks, comments, attachments, audience, events, permissions: await this.permissions(accountId, task) };
  }

  async permissions(accountId: string, task: TaskView) {
    const roles = (await this.access.profile(accountId)).roles;
    // On a project ticket the project's owner and manager act as managers; the
    // line of command does not (need-to-know).
    const manager = task.project ? await this.leadsProjectOf(accountId, task) : roles.some((r) => MANAGEMENT_ROLES.includes(r));
    const ownerish = task.owner.accountId === accountId || task.createdBy.accountId === accountId;
    // On a ticket, having created or owned it counts only while the person is on the project.
    const isOwner = ownerish && (!task.project || manager || (await isOnProject(this.dataSource, task.project.id, accountId)));
    const isAssignee = task.assignee.accountId === accountId;
    const open = OPEN_STATES.includes(task.status);
    return {
      canEdit: (isOwner || manager) && task.status !== 'CANCELLED' && !task.archivedAt,
      canChangeStatus: (isAssignee || isOwner || manager) && task.status !== 'CANCELLED' && !task.archivedAt,
      canAcceptOrReject: isAssignee && task.status === 'OPEN',
      canComplete: (isAssignee || isOwner || manager) && open,
      canCancel: (isOwner || manager) && open,
      canArchive: (isOwner || manager) && ['COMPLETED', 'CANCELLED'].includes(task.status) && !task.archivedAt,
      canComment: true,
      canAddSubtask: (isOwner || isAssignee || manager) && open,
    };
  }

  private async viewOrFail(accountId: string, taskId: string): Promise<TaskView> {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new NotFoundException('Unknown task.');
    const { where, params } = await this.listFilter(accountId, { scope: 'all', includeArchived: true });
    params.push(taskId);
    const rows = await this.dataSource.query(`${SELECT_VIEW} WHERE ${where} AND t.id = $${params.length}`, params);
    if (!rows.length) throw new NotFoundException('Unknown task.');
    return (await this.views(rows))[0];
  }

  private async views(rows: Record<string, unknown>[]): Promise<TaskView[]> {
    const today = todayInSuriname();
    const out: TaskView[] = [];
    for (const r of rows) {
      const due = r.due_date ? toDate(r.due_date) : null;
      const status = r.status as TaskStatus;
      const open = OPEN_STATES.includes(status);
      out.push({
        id: r.id as string,
        reference: r.reference as string,
        title: r.title as string,
        description: r.description as string,
        status,
        priority: r.priority as string,
        dueDate: due,
        startDate: r.start_date ? toDate(r.start_date) : null,
        overdue: !!due && open && due < today,
        dueInWorkingDays: due && open ? await this.workingDays.workingDaysBetween(today, due) : null,
        assignee: { accountId: r.assignee_account_id as string, name: r.assignee_name as string },
        owner: { accountId: r.owner_account_id as string, name: r.owner_name as string },
        createdBy: { accountId: r.created_by_account_id as string, name: r.creator_name as string },
        dossier: r.dossier_id ? { id: r.dossier_id as string, identity: r.dossier_identity as string, subject: r.dossier_subject as string } : null,
        item: r.correspondence_item_id
          ? { id: r.correspondence_item_id as string, identity: (r.item_identity as string) ?? null, subject: r.item_subject as string }
          : null,
        project: r.project_milestone_id
          ? {
              id: r.project_id as string,
              reference: r.project_reference as string,
              name: r.project_name as string,
              milestoneId: r.project_milestone_id as string,
              milestoneName: r.milestone_name as string,
            }
          : null,
        parentTaskId: (r.parent_task_id as string) ?? null,
        parentReference: (r.parent_reference as string) ?? null,
        checklistDone: r.checklist_done as number,
        checklistTotal: r.checklist_total as number,
        subtaskOpen: r.subtask_open as number,
        subtaskTotal: r.subtask_total as number,
        commentCount: r.comment_count as number,
        attachmentCount: r.attachment_count as number,
        audienceCount: r.audience_count as number,
        recurrence: r.recurrence as string,
        source: r.source as string,
        createdAt: new Date(r.created_at as string).toISOString(),
        updatedAt: new Date(r.updated_at as string).toISOString(),
        completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
        archivedAt: r.archived_at ? new Date(r.archived_at as string).toISOString() : null,
        rejectionReason: (r.rejection_reason as string) ?? null,
        cancelledReason: (r.cancelled_reason as string) ?? null,
        version: r.version as number,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- creating

  async create(actor: Actor, input: CreateTaskInput): Promise<TaskView> {
    const title = (input.title ?? '').trim();
    if (!title) throw new BadRequestException('A title is required.');
    if (input.priority && !PRIORITIES.includes(input.priority)) throw new BadRequestException('Unknown priority.');
    if (input.recurrence && !['NONE', 'WEEKLY', 'MONTHLY'].includes(input.recurrence)) throw new BadRequestException('Unknown recurrence.');
    if (input.recurrence && input.recurrence !== 'NONE' && !input.dueDate) {
      throw new BadRequestException('A repeating task needs a first due date.');
    }
    await this.assertAccount(input.assigneeAccountId, 'assignee');
    const owner = input.ownerAccountId ?? actor.accountId;
    await this.assertAccount(owner, 'owner');
    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new BadRequestException('Enter a valid due date.');
    if (input.dueDate && input.dueDate < todayInSuriname() && input.source !== 'RECURRENCE') {
      throw new BadRequestException('The due date cannot be in the past.');
    }
    if (input.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new BadRequestException('Enter a valid start date.');
    if (input.startDate && input.dueDate && input.startDate > input.dueDate) throw new BadRequestException('The start date must be on or before the due date.');
    if (input.dossierId) {
      await this.access.assertDossier(actor.accountId, input.dossierId);
      const [d] = await this.dataSource.query(`SELECT state FROM dossier WHERE id = $1`, [input.dossierId]);
      if (d.state === 'CLOSED') throw new BadRequestException('This dossier is closed. Reopen the dossier before changing it.');
    }
    if (input.itemId) await this.access.assertItem(actor.accountId, input.itemId);
    let parent: TaskView | null = null;
    if (input.parentTaskId) {
      parent = await this.viewOrFail(actor.accountId, input.parentTaskId);
      if (parent.parentTaskId) throw new BadRequestException('A subtask cannot have subtasks of its own.');
      if (!OPEN_STATES.includes(parent.status)) throw new BadRequestException('Subtasks can be added only to an open task.');
      if (!(await this.permissions(actor.accountId, parent)).canAddSubtask) throw new ForbiddenException('You may not add subtasks to this task.');
    }
    const audience = [...new Set(input.audience ?? [])].filter((id) => id !== input.assigneeAccountId);
    for (const id of audience) await this.assertAccount(id, 'audience member');
    // A project ticket (or a subtask of one) stays inside its project: no matter or
    // letter, and only people who may be on the project.
    const milestoneId = input.projectMilestoneId ?? parent?.project?.milestoneId ?? null;
    if (milestoneId && (input.dossierId || input.itemId)) throw new BadRequestException('A project ticket is not linked to a matter or a letter.');
    // A repeating copy would be made outside the project's rules: tickets do not repeat.
    if (milestoneId && input.recurrence && input.recurrence !== 'NONE') throw new BadRequestException('A project ticket does not repeat. Plan each one in its phase.');
    const numbering = await this.settings.get('numbering');
    const id = await this.dataSource.transaction(async (manager) => {
      const project = milestoneId ? await lockTicketProject(manager, milestoneId) : null;
      if (project) {
        assertPhaseTakesWork(project);
        const lead = leads(project, actor.accountId);
        if (!lead && !parent) throw new ForbiddenException('Only the owner or the project manager adds tickets.');
        if (lead) {
          if (!(await isProjectPerson(manager, input.assigneeAccountId))) throw new BadRequestException('The assignee must be an active ministry account.');
        } else if (!(await isOnProject(manager, project.id, input.assigneeAccountId))) {
          throw new BadRequestException('A subtask of a ticket goes to someone on the project. Ask the project manager to add the person first.');
        }
        for (const a of audience) {
          if (!(await isOnProject(manager, project.id, a))) throw new BadRequestException('Only people on the project can follow a ticket.');
        }
        if (!(await isOnProject(manager, project.id, owner))) throw new BadRequestException('The owner of a ticket must be on the project.');
      }
      const [{ nextval }] = await manager.query(`SELECT nextval('task_sequence') AS nextval`);
      const reference = numbering.taskPattern
        .replace('{YEAR}', String(new Date().getFullYear()))
        .replace('{SEQ}', String(nextval).padStart(numbering.taskPadding, '0'));
      const [row] = await manager.query(
        `INSERT INTO task (reference, title, description, priority, due_date, assignee_account_id, owner_account_id,
            created_by_account_id, on_behalf_of_account_id, dossier_id, correspondence_item_id, parent_task_id,
            template_id, recurrence, source, series_id, project_milestone_id, start_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [
          reference,
          title,
          (input.description ?? '').trim(),
          input.priority ?? 'MEDIUM',
          input.dueDate ?? null,
          input.assigneeAccountId,
          owner,
          actor.accountId,
          actor.onBehalfOfAccountId ?? null,
          input.dossierId ?? parent?.dossier?.id ?? null,
          input.itemId ?? parent?.item?.id ?? null,
          input.parentTaskId ?? null,
          input.templateId ?? null,
          input.recurrence ?? 'NONE',
          input.source ?? 'MANUAL',
          null,
          // A subtask of a ticket stays in the ticket's milestone, under the same need-to-know rule.
          milestoneId,
          input.startDate ?? null,
        ],
      ).catch((error: Error) => {
        if (/dossier is closed/.test(error.message)) {
          throw new BadRequestException('This dossier is closed. Reopen the dossier before changing it.');
        }
        throw error;
      });
      const taskId = row.id as string;
      let position = 0;
      for (const label of input.checklist ?? []) {
        if (!label?.trim()) continue;
        await manager.query(`INSERT INTO task_checklist_item (task_id, label, position) VALUES ($1, $2, $3)`, [taskId, label.trim().slice(0, 300), position++]);
      }
      for (const accountId of audience) {
        await manager.query(`INSERT INTO task_audience (task_id, account_id, added_by_account_id) VALUES ($1, $2, $3)`, [taskId, accountId, actor.accountId]);
      }
      if (project) {
        // In the same transaction: the holder joins the team, and the project's history
        // records the ticket by its number only (stakeholders read the history).
        if (leads(project, actor.accountId)) await joinAsTicketHolder(manager, this.audit, actor, project, input.assigneeAccountId, reference);
        await manager.query(`INSERT INTO project_event (project_id, event_type, actor_account_id, note) VALUES ($1, 'TICKET_ADDED', $2, $3)`, [
          project.id,
          actor.accountId,
          parent ? `${reference} (subtask of ${parent.reference})` : reference,
        ]);
      }
      await this.event(manager, taskId, 'CREATED', actor, null, null, input.source && input.source !== 'MANUAL' ? `source: ${input.source}` : null);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.TASK_CREATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${reference} — ${title}`.slice(0, 260),
        newValue: `assigned to ${await this.nameOf(manager, input.assigneeAccountId)}${input.dueDate ? `, due ${input.dueDate}` : ''}`,
        summary: `${actor.description} created task ${reference} (${title}) for ${await this.nameOf(manager, input.assigneeAccountId)}.`.slice(0, 600),
      });
      return taskId;
    });
    const view = await this.viewOrFail(actor.accountId, id);
    await this.notifications.notify({
      recipients: [view.assignee.accountId, ...audience],
      kind: 'TASK_ASSIGNED',
      params: { title: view.title, reference: view.reference, actor: actorName(actor), due: view.dueDate ? readableDate(view.dueDate) : null },
      link: `/taken/${id}`,
      subjectType: 'TASK',
      subjectId: id,
      actorAccountId: actor.accountId,
    });
    return view;
  }

  // ---------------------------------------------------------------- changing

  async update(
    actor: Actor,
    taskId: string,
    input: {
      version: number;
      title?: string;
      description?: string;
      assigneeAccountId?: string;
      ownerAccountId?: string;
      audience?: string[];
      dueDate?: string | null;
      startDate?: string | null;
      priority?: string;
      recurrence?: string;
    },
  ): Promise<TaskView> {
    const task = await this.viewOrFail(actor.accountId, taskId);
    const perms = await this.permissions(actor.accountId, task);
    if (!perms.canEdit) throw new ForbiddenException('Only the owner of this task may change it.');
    if (task.version !== input.version) throw stale();
    if (input.priority && !PRIORITIES.includes(input.priority)) throw new BadRequestException('Unknown priority.');
    if (input.title !== undefined && !input.title.trim()) throw new BadRequestException('A title is required.');
    if (input.assigneeAccountId) await this.assertAccount(input.assigneeAccountId, 'assignee');
    if (input.ownerAccountId) await this.assertAccount(input.ownerAccountId, 'owner');
    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new BadRequestException('Enter a valid due date.');
    if (input.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new BadRequestException('Enter a valid start date.');
    const nextStart = input.startDate !== undefined ? input.startDate : task.startDate;
    const nextDue = input.dueDate !== undefined ? input.dueDate : task.dueDate;
    if (nextStart && nextDue && nextStart > nextDue) throw new BadRequestException('The start date must be on or before the due date.');
    const changes: { field: string; from: string | null; to: string | null }[] = [];
    const set = (field: string, from: string | null, to: string | null | undefined) => {
      if (to !== undefined && (to ?? null) !== (from ?? null)) changes.push({ field, from, to: to ?? null });
    };
    set('title', task.title, input.title?.trim());
    set('description', task.description, input.description?.trim());
    set('assignee', task.assignee.accountId, input.assigneeAccountId);
    set('owner', task.owner.accountId, input.ownerAccountId);
    set('due', task.dueDate, input.dueDate);
    set('start', task.startDate, input.startDate);
    set('priority', task.priority, input.priority);
    set('recurrence', task.recurrence, input.recurrence);
    const reassigned = changes.find((c) => c.field === 'assignee');
    if (task.project) {
      // A ticket's owner is the project manager; who holds it is the project's call.
      if (changes.some((c) => c.field === 'owner')) throw new BadRequestException('The owner of a project ticket is the project manager.');
      if (input.recurrence && input.recurrence !== 'NONE') throw new BadRequestException('A project ticket does not repeat. Plan each one in its phase.');
      if (reassigned && !(await this.leadsProjectOf(actor.accountId, task))) throw new ForbiddenException("Only the project's owner or manager reassigns a ticket.");
    }
    const result = await this.dataSource.transaction(async (manager) => {
      if (task.project) {
        const project = await lockTicketProject(manager, task.project.milestoneId);
        if (reassigned) {
          assertPhaseTakesWork(project);
          if (!(await isProjectPerson(manager, input.assigneeAccountId as string))) throw new BadRequestException('The assignee must be an active ministry account.');
          await joinAsTicketHolder(manager, this.audit, actor, project, input.assigneeAccountId as string, task.reference);
        }
        for (const a of input.audience ?? []) {
          if (!(await isOnProject(manager, project.id, a))) throw new BadRequestException('Only people on the project can follow a ticket.');
        }
      }
      const outcome = await manager.query(
        `UPDATE task SET
           title = coalesce($3, title), description = coalesce($4, description),
           assignee_account_id = coalesce($5, assignee_account_id), owner_account_id = coalesce($6, owner_account_id),
           due_date = CASE WHEN $7::boolean THEN $8::date ELSE due_date END,
           priority = coalesce($9, priority), recurrence = coalesce($10, recurrence),
           status = CASE WHEN $11::boolean AND status = 'REJECTED' THEN 'OPEN' ELSE status END,
           rejection_reason = CASE WHEN $11::boolean THEN NULL ELSE rejection_reason END,
           start_date = CASE WHEN $12::boolean THEN $13::date ELSE start_date END,
           version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $2`,
        [
          taskId,
          input.version,
          input.title?.trim() ?? null,
          input.description?.trim() ?? null,
          input.assigneeAccountId ?? null,
          input.ownerAccountId ?? null,
          input.dueDate !== undefined,
          input.dueDate ?? null,
          input.priority ?? null,
          input.recurrence ?? null,
          !!reassigned,
          input.startDate !== undefined,
          input.startDate ?? null,
        ],
      );
      if (outcome[1] === 0) throw stale();
      if (input.audience) {
        const wanted = new Set(input.audience);
        await manager.query(`DELETE FROM task_audience WHERE task_id = $1 AND NOT (account_id = ANY($2))`, [taskId, [...wanted]]);
        for (const id of wanted) {
          await manager.query(
            `INSERT INTO task_audience (task_id, account_id, added_by_account_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [taskId, id, actor.accountId],
          );
        }
      }
      for (const c of changes) {
        const from = c.field === 'assignee' || c.field === 'owner' ? await this.nameOf(manager, c.from) : c.from;
        const to = c.field === 'assignee' || c.field === 'owner' ? await this.nameOf(manager, c.to) : c.to;
        await this.event(manager, taskId, c.field === 'assignee' ? 'ASSIGNED' : `CHANGED_${c.field.toUpperCase()}`, actor, truncate(from), truncate(to), null);
      }
      if (changes.length) {
        await this.audit.recordInTransaction(manager, {
          eventType: reassigned ? AuditEventType.TASK_ASSIGNED : AuditEventType.TASK_UPDATED,
          actorAccountId: actor.accountId,
          actorDescription: actor.description,
          representedAuthority: actor.representedAuthority ?? null,
          subjectDescription: `${task.reference} — ${task.title}`.slice(0, 260),
          newValue: changes.map((c) => c.field).join(', '),
          summary: `${actor.description} changed ${changes.map((c) => c.field).join(', ')} of task ${task.reference}.`,
        });
      }
      return changes;
    });
    const view = await this.viewOrFail(actor.accountId, taskId);
    if (reassigned) {
      await this.notifications.notify({
        recipients: [view.assignee.accountId],
        kind: 'TASK_ASSIGNED',
        params: { title: view.title, reference: view.reference, actor: actorName(actor), due: view.dueDate ? readableDate(view.dueDate) : null },
        link: `/taken/${taskId}`,
        subjectType: 'TASK',
        subjectId: taskId,
        actorAccountId: actor.accountId,
      });
    } else if (result.length) {
      await this.notifications.notify({
        recipients: [view.assignee.accountId],
        kind: 'TASK_UPDATED',
        params: { title: view.title, reference: view.reference, actor: actorName(actor), change: result.map((c) => c.field).join(', ') },
        link: `/taken/${taskId}`,
        subjectType: 'TASK',
        subjectId: taskId,
        actorAccountId: actor.accountId,
      });
    }
    return view;
  }

  async changeStatus(actor: Actor, taskId: string, to: TaskStatus, version: number, note?: string): Promise<TaskView> {
    const task = await this.viewOrFail(actor.accountId, taskId);
    const perms = await this.permissions(actor.accountId, task);
    if (!(TRANSITIONS[task.status] ?? []).includes(to)) {
      throw new BadRequestException(`A task that is ${task.status.toLowerCase().replace('_', ' ')} cannot become ${to.toLowerCase().replace('_', ' ')}.`);
    }
    if (task.version !== version) throw stale();
    if (to === 'COMPLETED') {
      if (!perms.canComplete) throw new ForbiddenException('You are not permitted to complete this task.');
      await this.assertCompletable(task);
    } else if (to === 'CANCELLED') {
      if (!perms.canCancel) throw new ForbiddenException('Only the owner of this task may cancel it.');
      if (!note?.trim()) throw new BadRequestException('A reason is required when cancelling a task.');
    } else if (to === 'REJECTED') {
      if (!perms.canAcceptOrReject) throw new ForbiddenException('Only the person the task is assigned to may decline it.');
      if (!note?.trim()) throw new BadRequestException('A reason is required when declining a task.');
    } else if (to === 'ACCEPTED') {
      if (!perms.canAcceptOrReject) throw new ForbiddenException('Only the person the task is assigned to may accept it.');
    } else if (task.status === 'COMPLETED' && to === 'IN_PROGRESS') {
      if (!perms.canEdit) throw new ForbiddenException('Only the owner may reopen a completed task.');
    } else if (!perms.canChangeStatus) {
      throw new ForbiddenException('You are not permitted to change this task.');
    }
    const eventType =
      to === 'COMPLETED' ? 'COMPLETED' : to === 'CANCELLED' ? 'CANCELLED' : to === 'REJECTED' ? 'REJECTED' : to === 'ACCEPTED' ? 'ACCEPTED' : 'STATUS_CHANGED';
    await this.dataSource.transaction(async (manager) => {
      if (task.project && OPEN_STATES.includes(to) && !OPEN_STATES.includes(task.status)) {
        // Reopening a ticket is new work: only in a running project and an open phase,
        // checked under the project's lock in the same transaction as the change.
        assertPhaseTakesWork(await lockTicketProject(manager, task.project.milestoneId));
      }
      const outcome = await manager.query(
        `UPDATE task SET status = $3::varchar,
           completed_at = CASE WHEN $3::varchar = 'COMPLETED' THEN now() ELSE NULL END,
           cancelled_reason = CASE WHEN $3::varchar = 'CANCELLED' THEN $4::varchar ELSE cancelled_reason END,
           rejection_reason = CASE WHEN $3::varchar = 'REJECTED' THEN $4::varchar ELSE rejection_reason END,
           version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $2`,
        [taskId, version, to, note?.trim() || null],
      );
      if (outcome[1] === 0) throw stale();
      await this.event(manager, taskId, eventType, actor, task.status, to, note?.trim() || null);
      await this.audit.recordInTransaction(manager, {
        eventType:
          to === 'COMPLETED'
            ? AuditEventType.TASK_COMPLETED
            : to === 'CANCELLED'
              ? AuditEventType.TASK_CANCELLED
              : to === 'REJECTED'
                ? AuditEventType.TASK_REJECTED
                : to === 'ACCEPTED'
                  ? AuditEventType.TASK_ACCEPTED
                  : AuditEventType.TASK_STATUS_CHANGED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${task.reference} — ${task.title}`.slice(0, 260),
        previousValue: task.status,
        newValue: to,
        summary: `${actor.description} moved task ${task.reference} from ${task.status} to ${to}${note?.trim() ? ` (${note.trim()})` : ''}.`.slice(0, 600),
      });
    });
    if (to === 'COMPLETED' && task.recurrence !== 'NONE' && task.dueDate) {
      await this.spawnNext(actor, task);
    }
    const view = await this.viewOrFail(actor.accountId, taskId);
    const kind = to === 'COMPLETED' ? 'TASK_COMPLETED' : to === 'REJECTED' ? 'TASK_REJECTED' : to === 'CANCELLED' ? 'TASK_CANCELLED' : 'TASK_UPDATED';
    await this.notifications.notify({
      recipients: to === 'CANCELLED' ? [view.assignee.accountId] : [view.owner.accountId, view.createdBy.accountId, to === 'COMPLETED' ? view.assignee.accountId : null],
      kind,
      params: { title: view.title, reference: view.reference, actor: actorName(actor), reason: note ?? '', change: `status → ${to}` },
      link: `/taken/${taskId}`,
      subjectType: 'TASK',
      subjectId: taskId,
      actorAccountId: actor.accountId,
    });
    return view;
  }

  private async assertCompletable(task: TaskView): Promise<void> {
    const rules = await this.settings.get('tasks');
    if (rules.requireChecklistForCompletion && task.checklistDone < task.checklistTotal) {
      throw new BadRequestException(
        `This task cannot be completed yet: ${task.checklistTotal - task.checklistDone} checklist item(s) are still open.`,
      );
    }
    if (rules.requireSubtasksForCompletion && task.subtaskOpen > 0) {
      throw new BadRequestException(`This task cannot be completed yet: ${task.subtaskOpen} subtask(s) are still open.`);
    }
  }

  /** A repeating task: the next occurrence, same work, next due date. */
  private async spawnNext(actor: Actor, task: TaskView): Promise<void> {
    if (task.project) return; // tickets do not repeat (refused at create and update)
    const next = task.recurrence === 'WEEKLY' ? addDays(task.dueDate as string, 7) : addMonth(task.dueDate as string);
    const due = await this.workingDays.addWorkingDays(next, 0);
    const checklist: { label: string }[] = await this.dataSource.query(
      `SELECT label FROM task_checklist_item WHERE task_id = $1 AND removed_at IS NULL ORDER BY position`,
      [task.id],
    );
    const audience: { account_id: string }[] = await this.dataSource.query(`SELECT account_id FROM task_audience WHERE task_id = $1`, [task.id]);
    const created = await this.create(actor, {
      title: task.title,
      description: task.description,
      assigneeAccountId: task.assignee.accountId,
      ownerAccountId: task.owner.accountId,
      audience: audience.map((a) => a.account_id),
      dueDate: due,
      priority: task.priority,
      dossierId: task.dossier?.id ?? null,
      itemId: task.item?.id ?? null,
      checklist: checklist.map((c) => c.label),
      recurrence: task.recurrence,
      source: 'RECURRENCE',
    });
    const [first] = await this.dataSource.query(`SELECT coalesce(series_id, id) AS series FROM task WHERE id = $1`, [task.id]);
    await this.dataSource.query(`UPDATE task SET series_id = $2 WHERE id IN ($1, $3)`, [task.id, first.series, created.id]);
  }

  async archive(actor: Actor, taskId: string): Promise<TaskView> {
    const task = await this.viewOrFail(actor.accountId, taskId);
    const perms = await this.permissions(actor.accountId, task);
    if (!perms.canArchive) throw new BadRequestException('Only a completed or cancelled task can be archived, by its owner.');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE task SET archived_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
      await this.event(manager, taskId, 'ARCHIVED', actor, null, null, null);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.TASK_ARCHIVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${task.reference} — ${task.title}`.slice(0, 260),
        summary: `${actor.description} archived task ${task.reference}.`,
      });
    });
    return this.viewOrFail(actor.accountId, taskId);
  }

  // ---------------------------------------------------------------- checklist

  async addChecklistItem(actor: Actor, taskId: string, label: string) {
    const task = await this.viewOrFail(actor.accountId, taskId);
    await this.assertCanWork(actor, task);
    if (!label?.trim()) throw new BadRequestException('A checklist item needs a label.');
    const [{ pos }] = await this.dataSource.query(
      `SELECT coalesce(max(position), -1) + 1 AS pos FROM task_checklist_item WHERE task_id = $1`,
      [taskId],
    );
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`INSERT INTO task_checklist_item (task_id, label, position) VALUES ($1, $2, $3)`, [taskId, label.trim().slice(0, 300), pos]);
      await this.event(manager, taskId, 'CHECKLIST_ADDED', actor, null, truncate(label.trim()), null);
      await manager.query(`UPDATE task SET updated_at = now() WHERE id = $1`, [taskId]);
    });
    return this.detail(actor.accountId, taskId);
  }

  async updateChecklistItem(actor: Actor, taskId: string, itemId: string, input: { done?: boolean; label?: string; remove?: boolean }) {
    const task = await this.viewOrFail(actor.accountId, taskId);
    await this.assertCanWork(actor, task);
    const [item] = await this.dataSource.query(
      `SELECT * FROM task_checklist_item WHERE id = $1 AND task_id = $2 AND removed_at IS NULL`,
      [itemId, taskId],
    );
    if (!item) throw new NotFoundException('Unknown checklist item.');
    await this.dataSource.transaction(async (manager) => {
      if (input.remove) {
        await manager.query(`UPDATE task_checklist_item SET removed_at = now() WHERE id = $1`, [itemId]);
        await this.event(manager, taskId, 'CHECKLIST_REMOVED', actor, truncate(item.label), null, null);
      } else {
        if (input.label !== undefined && input.label.trim() && input.label.trim() !== item.label) {
          await manager.query(`UPDATE task_checklist_item SET label = $2 WHERE id = $1`, [itemId, input.label.trim().slice(0, 300)]);
          await this.event(manager, taskId, 'CHECKLIST_RENAMED', actor, truncate(item.label), truncate(input.label.trim()), null);
        }
        if (input.done !== undefined && input.done !== item.done) {
          await manager.query(
            `UPDATE task_checklist_item SET done = $2, done_by_account_id = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
               done_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1`,
            [itemId, input.done, actor.accountId],
          );
          await this.event(manager, taskId, input.done ? 'CHECKLIST_DONE' : 'CHECKLIST_UNDONE', actor, null, truncate(item.label), null);
        }
      }
      await manager.query(`UPDATE task SET updated_at = now() WHERE id = $1`, [taskId]);
    });
    return this.detail(actor.accountId, taskId);
  }

  // ---------------------------------------------------------------- comments, attachments

  async comment(actor: Actor, taskId: string, body: string) {
    const task = await this.viewOrFail(actor.accountId, taskId);
    const text = (body ?? '').trim();
    if (!text) throw new BadRequestException('A comment cannot be empty.');
    if (text.length > 5000) throw new BadRequestException('A comment is at most 5000 characters.');
    // Mentions are written as @[Name](account-id) by the screen.
    const mentioned = [...text.matchAll(/@\[[^\]]{1,200}\]\(([0-9a-f-]{36})\)/gi)].map((m) => m[1]);
    const valid: string[] = mentioned.length
      ? (await this.dataSource.query(`SELECT id FROM account WHERE id = ANY($1) AND is_enabled`, [mentioned])).map((r: { id: string }) => r.id)
      : [];
    await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO task_comment (task_id, author_account_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [taskId, actor.accountId, text],
      );
      for (const id of valid) {
        await manager.query(`INSERT INTO task_mention (comment_id, account_id) VALUES ($1, $2)`, [row.id, id]);
      }
      await manager.query(`UPDATE task SET updated_at = now() WHERE id = $1`, [taskId]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.TASK_COMMENTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${task.reference} — ${task.title}`.slice(0, 260),
        summary: `${actor.description} commented on task ${task.reference}.`,
      });
    });
    const excerpt = plainMentions(text).slice(0, 160);
    await this.notifications.notify({
      recipients: valid,
      kind: 'TASK_MENTION',
      params: { reference: task.reference, actor: actorName(actor), excerpt },
      link: `/taken/${taskId}`,
      subjectType: 'TASK',
      subjectId: taskId,
      actorAccountId: actor.accountId,
    });
    await this.notifications.notify({
      recipients: [task.assignee.accountId, task.owner.accountId].filter((id) => !valid.includes(id)),
      kind: 'TASK_COMMENT',
      params: { reference: task.reference, actor: actorName(actor), excerpt },
      link: `/taken/${taskId}`,
      subjectType: 'TASK',
      subjectId: taskId,
      actorAccountId: actor.accountId,
    });
    return this.detail(actor.accountId, taskId);
  }

  async attach(actor: Actor, taskId: string, file: { originalname: string; mimetype: string; buffer: Buffer }) {
    const task = await this.viewOrFail(actor.accountId, taskId);
    await this.assertCanWork(actor, task);
    const config = loadDocumentConfig();
    if (!file?.buffer?.length) throw new BadRequestException('No file was received, or the file is empty.');
    if (file.buffer.length > config.maxBytes) throw new BadRequestException('That file is larger than the configured limit.');
    if (!config.allowedMediaTypes.includes(file.mimetype)) {
      throw new BadRequestException(`Files of type ${file.mimetype} are not accepted.`);
    }
    await this.scanner.assertClean(file.buffer, file.originalname, actor.accountId);
    const { storageKey, contentHash } = await this.storage.put(file.buffer);
    const filename = file.originalname.replace(/[\\/\0]/g, '_').slice(0, 400);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO task_attachment (task_id, original_filename, media_type, byte_size, content_hash, storage_key, uploaded_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [taskId, filename, file.mimetype, file.buffer.length, contentHash, storageKey, actor.accountId],
      );
      await manager.query(`UPDATE task SET updated_at = now() WHERE id = $1`, [taskId]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.TASK_ATTACHMENT_ADDED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${task.reference} — ${task.title}`.slice(0, 260),
        newValue: `${filename} (sha256 ${contentHash.slice(0, 12)}…)`,
        summary: `${actor.description} attached ${filename} to task ${task.reference}.`.slice(0, 600),
      });
    });
    return this.detail(actor.accountId, taskId);
  }

  async attachmentContent(accountId: string, taskId: string, attachmentId: string) {
    await this.viewOrFail(accountId, taskId);
    const [row] = await this.dataSource.query(`SELECT * FROM task_attachment WHERE id = $1 AND task_id = $2`, [attachmentId, taskId]);
    if (!row) throw new NotFoundException('Unknown attachment.');
    const bytes = await this.storage.get(row.storage_key, row.content_hash);
    return { bytes, mediaType: row.media_type as string, filename: row.original_filename as string };
  }

  async bulkAssign(actor: Actor, taskIds: string[], assigneeAccountId: string): Promise<{ updated: string[]; skipped: { id: string; reason: string }[] }> {
    await this.assertAccount(assigneeAccountId, 'assignee');
    const updated: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of [...new Set(taskIds)].slice(0, 200)) {
      try {
        const task = await this.viewOrFail(actor.accountId, id);
        if (task.assignee.accountId === assigneeAccountId) {
          skipped.push({ id, reason: 'already assigned' });
          continue;
        }
        await this.update(actor, id, { version: task.version, assigneeAccountId });
        updated.push(id);
      } catch (error) {
        skipped.push({ id, reason: (error as Error).message });
      }
    }
    return { updated, skipped };
  }

  // ---------------------------------------------------------------- helpers

  private async assertCanWork(actor: Actor, task: TaskView): Promise<void> {
    const perms = await this.permissions(actor.accountId, task);
    if (!perms.canChangeStatus) throw new ForbiddenException('You are not permitted to change this task.');
    if (!OPEN_STATES.includes(task.status)) throw new BadRequestException('This task is no longer open.');
  }

  private async assertAccount(accountId: string, what: string): Promise<void> {
    if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) throw new BadRequestException(`Choose a valid ${what}.`);
    const rows = await this.dataSource.query(`SELECT 1 FROM account WHERE id = $1 AND is_enabled`, [accountId]);
    if (!rows.length) throw new BadRequestException(`That ${what} is not an active account.`);
  }

  private async event(
    manager: EntityManager,
    taskId: string,
    type: string,
    actor: Actor,
    from: string | null,
    to: string | null,
    note: string | null,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO task_event (task_id, event_type, actor_account_id, on_behalf_of_account_id, from_value, to_value, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [taskId, type, actor.accountId, actor.onBehalfOfAccountId ?? null, from, to, note?.slice(0, 600) ?? null],
    );
  }

  private async nameOf(manager: EntityManager, accountId: string | null): Promise<string | null> {
    if (!accountId) return null;
    const [row] = await manager.query(`SELECT p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1`, [accountId]);
    return row?.full_name ?? null;
  }
}

function stale(): ConflictException {
  return new ConflictException('Someone else changed this task while you were working on it. Reload and try again.');
}

function toDate(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value as Date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addMonth(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function truncate(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

export function actorName(actor: Actor): string {
  return actor.description.replace(/\s*\([^)]*@[^)]*\)\s*$/, '');
}

export function plainMentions(text: string): string {
  return text.replace(/@\[([^\]]{1,200})\]\([0-9a-f-]{36}\)/gi, '@$1');
}
