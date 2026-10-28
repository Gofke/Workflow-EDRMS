import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessService } from '../access/access.service';
import { todayInSuriname } from '../common/actor';
import { addDays, WorkingDaysService } from '../core/working-days.service';
import { TasksService } from '../tasks/tasks.service';
import { WorkflowService } from '../workflow/workflow.service';
import { ApprovalsService } from '../approvals/approvals.service';

const OPEN_TASK = `('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW')`;

/**
 * My Work, the management overview, department performance, workload and
 * trends.
 *
 * Counts are ministry-wide for the decision-makers who may see them: a number
 * says how much work there is, not what it is about. Every list that names a
 * matter goes through the record-level evaluator.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly tasks: TasksService,
    private readonly workflow: WorkflowService,
    private readonly approvals: ApprovalsService,
    private readonly workingDays: WorkingDaysService,
  ) {}

  async myWork(accountId: string) {
    const today = todayInSuriname();
    const profile = await this.access.profile(accountId);
    const pred = this.access.dossierPredicate(profile, 'd', 2);
    const [tasks, reviewQueue, advice, responsible, drafts, delegated, standingIn, [{ unread }]] = await Promise.all([
      this.tasks.list(accountId, { scope: 'my', includeClosed: false, limit: 50 }),
      this.workflow.reviewQueueFor(accountId),
      this.approvals.mine(accountId),
      this.dataSource.query(
        `SELECT d.id, d.dossier_identity AS "dossierIdentity", d.subject, d.processing_state AS "processingState",
                to_char(d.due_date, 'YYYY-MM-DD') AS "dueDate", (d.due_date < $${2 + pred.params.length}::date) AS overdue
           FROM dossier d JOIN responsibility_assignment ra ON ra.dossier_id = d.id AND ra.superseded_at IS NULL
          WHERE ra.responsible_account_id = $1 AND d.state <> 'CLOSED' AND d.processing_state <> 'FINALISED' AND ${pred.sql}
          ORDER BY d.due_date NULLS LAST LIMIT 50`,
        [accountId, ...pred.params, today],
      ),
      this.dataSource.query(
        `SELECT ci.id, ci.subject, ci.direction, ci.party, ci.source, ci.created_at AS "createdAt"
           FROM correspondence_item ci WHERE ci.created_by_account_id = $1 AND ci.state = 'DRAFT'
          ORDER BY ci.created_at DESC LIMIT 20`,
        [accountId],
      ),
      this.dataSource.query(
        `SELECT dl.id, p.full_name AS "principalName", dl.permitted_actions AS "actions",
                dl.valid_from AS "validFrom", dl.valid_until AS "validUntil"
           FROM delegation dl JOIN account a ON a.id = dl.principal_account_id JOIN person p ON p.id = a.person_id
          WHERE dl.delegate_account_id = $1 AND dl.revoked_at IS NULL AND dl.valid_until > now() AND dl.valid_from <= now()`,
        [accountId],
      ),
      this.approvals.standingIn(accountId),
      this.dataSource.query(`SELECT count(*)::int AS unread FROM notification WHERE account_id = $1 AND read_at IS NULL`, [accountId]),
    ]);
    const overdueTasks = tasks.data.filter((t) => t.overdue);
    const dueSoon = tasks.data.filter((t) => !t.overdue && t.dueDate && t.dueDate <= addDays(today, 7));
    return {
      today,
      summary: {
        openTasks: tasks.total,
        overdueTasks: overdueTasks.length,
        dueThisWeek: dueSoon.length,
        awaitingMyDecision: reviewQueue.length,
        adviceToGive: advice.length,
        responsibleMatters: responsible.length,
        overdueMatters: responsible.filter((r: { overdue: boolean }) => r.overdue).length,
        draftsToRegister: drafts.length,
        unreadNotifications: unread,
      },
      tasks: tasks.data,
      reviewQueue,
      advice,
      responsible,
      drafts,
      delegated,
      standingIn,
    };
  }

  /** The Minister's and Directeurs' overview. */
  async overview(accountId: string) {
    const today = todayInSuriname();
    const weekEnd = addDays(today, 7);
    const [counts] = await this.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM dossier WHERE state <> 'CLOSED' AND processing_state <> 'FINALISED') AS "openMatters",
         (SELECT count(*)::int FROM dossier WHERE state <> 'CLOSED' AND processing_state NOT IN ('APPROVED','FINALISED') AND due_date < $1::date) AS "overdueMatters",
         (SELECT count(*)::int FROM dossier WHERE state <> 'CLOSED' AND processing_state NOT IN ('APPROVED','FINALISED') AND due_date BETWEEN $1::date AND $2::date) AS "dueThisWeek",
         (SELECT count(*)::int FROM dossier WHERE processing_state = 'UNDER_REVIEW') AS "underReview",
         (SELECT count(*)::int FROM correspondence_item WHERE registered_at >= date_trunc('month', now() AT TIME ZONE 'America/Paramaribo') AT TIME ZONE 'America/Paramaribo') AS "registeredThisMonth",
         (SELECT count(*)::int FROM workflow_event WHERE event_type = 'FINALISED' AND occurred_at >= date_trunc('month', now() AT TIME ZONE 'America/Paramaribo') AT TIME ZONE 'America/Paramaribo') AS "finalisedThisMonth",
         (SELECT count(*)::int FROM task WHERE status IN ${OPEN_TASK} AND archived_at IS NULL) AS "openTasks",
         (SELECT count(*)::int FROM task WHERE status IN ${OPEN_TASK} AND archived_at IS NULL AND due_date < $1::date) AS "overdueTasks",
         (SELECT count(*)::int FROM correspondence_item WHERE state = 'DRAFT') AS "draftsWaiting",
         (SELECT count(*)::int FROM advice_request WHERE status = 'OPEN') AS "openAdvice"`,
      [today, weekEnd],
    );
    const awaitingMinister = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM dossier d
         JOIN LATERAL (SELECT reviewer_account_id FROM workflow_event we WHERE we.dossier_id = d.id AND we.event_type = 'SUBMITTED' ORDER BY occurred_at DESC LIMIT 1) s ON true
         JOIN role_assignment ra ON ra.account_id = s.reviewer_account_id AND ra.revoked_at IS NULL
         JOIN functional_role r ON r.id = ra.functional_role_id AND r.code = 'MINISTER'
        WHERE d.processing_state = 'UNDER_REVIEW'`,
    );
    const onTime = await this.onTime(90);
    const handling = await this.dataSource.query(
      `SELECT round(avg(extract(epoch FROM (f.at - d.created_at)) / 86400)::numeric, 1)::float AS days
         FROM dossier d JOIN LATERAL (SELECT max(occurred_at) AS at FROM workflow_event WHERE dossier_id = d.id AND event_type = 'FINALISED') f ON f.at IS NOT NULL
        WHERE f.at > now() - interval '90 days'`,
    );
    const profile = await this.access.profile(accountId);
    const pred = this.access.dossierPredicate(profile, 'd', 2);
    const overdueList = await this.dataSource.query(
      `SELECT d.id, d.dossier_identity AS "dossierIdentity", d.subject, to_char(d.due_date, 'YYYY-MM-DD') AS "dueDate",
              d.processing_state AS "processingState", rp.full_name AS "responsibleName", u.name AS unit
         FROM dossier d
         LEFT JOIN responsibility_assignment ra ON ra.dossier_id = d.id AND ra.superseded_at IS NULL
         LEFT JOIN account a ON a.id = ra.responsible_account_id LEFT JOIN person rp ON rp.id = a.person_id
         LEFT JOIN organisational_unit u ON u.id = d.owning_unit_id
        WHERE d.state <> 'CLOSED' AND d.processing_state NOT IN ('APPROVED','FINALISED') AND d.due_date < $1::date AND ${pred.sql}
        ORDER BY d.due_date LIMIT 15`,
      [today, ...pred.params],
    );
    for (const row of overdueList) row.workingDaysLate = await this.workingDays.workingDaysBetween(row.dueDate, today);
    const recentPred = this.access.dossierPredicate(profile, 'd', 1);
    const recent = await this.dataSource.query(
      `SELECT we.event_type AS "eventType", we.occurred_at AS "occurredAt", d.id AS "dossierId", d.dossier_identity AS "dossierIdentity",
              d.subject, p.full_name AS "actorName"
         FROM workflow_event we JOIN dossier d ON d.id = we.dossier_id
         JOIN account a ON a.id = we.actor_account_id JOIN person p ON p.id = a.person_id
        WHERE ${recentPred.sql}
        ORDER BY we.occurred_at DESC LIMIT 10`,
      recentPred.params,
    );
    return {
      today,
      counts: { ...counts, awaitingMinister: awaitingMinister[0].n },
      onTime,
      averageHandlingDays: handling[0]?.days ?? null,
      byUnit: await this.departments(90),
      overdue: overdueList,
      recentDecisions: recent,
      trends: await this.trends(6),
    };
  }

  /** Share of matters finalised by their due date, over the last `days` days. */
  async onTime(days: number) {
    const [row] = await this.dataSource.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE (f.at AT TIME ZONE 'America/Paramaribo')::date <= d.due_date)::int AS on_time
         FROM dossier d JOIN LATERAL (SELECT max(occurred_at) AS at FROM workflow_event WHERE dossier_id = d.id AND event_type = 'FINALISED') f ON f.at IS NOT NULL
        WHERE d.due_date IS NOT NULL AND f.at > now() - make_interval(days => $1)`,
      [days],
    );
    return { total: row.total, onTime: row.on_time, percentage: row.total ? Math.round((row.on_time / row.total) * 100) : null };
  }

  async departments(days = 90) {
    const today = todayInSuriname();
    return this.dataSource.query(
      `SELECT u.id, u.name, u.code,
              (SELECT count(*)::int FROM correspondence_item ci WHERE ci.owning_unit_id = u.id AND ci.registered_at > now() - make_interval(days => $1)) AS registered,
              (SELECT count(*)::int FROM dossier d WHERE d.owning_unit_id = u.id AND d.state <> 'CLOSED' AND d.processing_state <> 'FINALISED') AS open,
              (SELECT count(*)::int FROM dossier d WHERE d.owning_unit_id = u.id AND d.state <> 'CLOSED' AND d.processing_state NOT IN ('APPROVED','FINALISED') AND d.due_date < $2::date) AS overdue,
              (SELECT count(*)::int FROM dossier d JOIN LATERAL (SELECT max(occurred_at) AS at FROM workflow_event WHERE dossier_id = d.id AND event_type = 'FINALISED') f ON f.at IS NOT NULL
                 WHERE d.owning_unit_id = u.id AND f.at > now() - make_interval(days => $1)) AS finalised,
              (SELECT round(avg(extract(epoch FROM (f.at - d.created_at)) / 86400)::numeric, 1)::float FROM dossier d
                 JOIN LATERAL (SELECT max(occurred_at) AS at FROM workflow_event WHERE dossier_id = d.id AND event_type = 'FINALISED') f ON f.at IS NOT NULL
                 WHERE d.owning_unit_id = u.id AND f.at > now() - make_interval(days => $1)) AS "avgHandlingDays",
              (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE round(100.0 * count(*) FILTER (WHERE (f.at AT TIME ZONE 'America/Paramaribo')::date <= d.due_date) / count(*))::int END
                 FROM dossier d JOIN LATERAL (SELECT max(occurred_at) AS at FROM workflow_event WHERE dossier_id = d.id AND event_type = 'FINALISED') f ON f.at IS NOT NULL
                 WHERE d.owning_unit_id = u.id AND d.due_date IS NOT NULL AND f.at > now() - make_interval(days => $1)) AS "onTimePct",
              (SELECT count(*)::int FROM task t JOIN account a ON a.id = t.assignee_account_id
                 WHERE a.organisational_unit_id = u.id AND t.status IN ${OPEN_TASK} AND t.archived_at IS NULL) AS "openTasks",
              (SELECT count(*)::int FROM task t JOIN account a ON a.id = t.assignee_account_id
                 WHERE a.organisational_unit_id = u.id AND t.status IN ${OPEN_TASK} AND t.archived_at IS NULL AND t.due_date < $2::date) AS "overdueTasks"
         FROM organisational_unit u WHERE u.is_active
        ORDER BY u.name`,
      [days, today],
    );
  }

  async workload() {
    const today = todayInSuriname();
    return this.dataSource.query(
      `SELECT a.id AS "accountId", p.full_name AS name, u.name AS unit,
              count(t.id) FILTER (WHERE t.status IN ${OPEN_TASK})::int AS "openTasks",
              count(t.id) FILTER (WHERE t.status IN ${OPEN_TASK} AND t.due_date < $1::date)::int AS "overdueTasks",
              count(t.id) FILTER (WHERE t.status IN ${OPEN_TASK} AND t.due_date BETWEEN $1::date AND $2::date)::int AS "dueThisWeek",
              count(t.id) FILTER (WHERE t.status = 'COMPLETED' AND t.completed_at > now() - interval '30 days')::int AS "completed30d",
              (SELECT count(*)::int FROM responsibility_assignment ra JOIN dossier d ON d.id = ra.dossier_id
                WHERE ra.responsible_account_id = a.id AND ra.superseded_at IS NULL AND d.state <> 'CLOSED' AND d.processing_state <> 'FINALISED') AS "responsibleMatters",
              (SELECT count(*)::int FROM advice_request ar WHERE ar.requested_from_account_id = a.id AND ar.status = 'OPEN') AS "openAdvice"
         FROM account a JOIN person p ON p.id = a.person_id
         LEFT JOIN organisational_unit u ON u.id = a.organisational_unit_id
         LEFT JOIN task t ON t.assignee_account_id = a.id AND t.archived_at IS NULL
        WHERE a.is_enabled AND EXISTS (SELECT 1 FROM role_assignment ra JOIN functional_role r ON r.id = ra.functional_role_id
                                        WHERE ra.account_id = a.id AND ra.revoked_at IS NULL AND r.code IN ('SUPPORT_STAFF','DIRECTEUR','ONDER_DIRECTEUR','MINISTER','RECORDS_MANAGER'))
        GROUP BY a.id, p.full_name, u.name
        ORDER BY "openTasks" DESC, p.full_name`,
      [today, addDays(today, 7)],
    );
  }

  async trends(months = 12) {
    const letters = await this.dataSource.query(
      `WITH m AS (SELECT generate_series(date_trunc('month', now() AT TIME ZONE 'America/Paramaribo') - make_interval(months => $1 - 1),
                                         date_trunc('month', now() AT TIME ZONE 'America/Paramaribo'), interval '1 month') AS month)
       SELECT to_char(m.month, 'YYYY-MM') AS month,
              count(ci.id) FILTER (WHERE ci.direction = 'INCOMING')::int AS incoming,
              count(ci.id) FILTER (WHERE ci.direction = 'OUTGOING')::int AS outgoing,
              count(ci.id) FILTER (WHERE ci.direction = 'INTERNAL')::int AS internal,
              (SELECT count(*)::int FROM workflow_event we WHERE we.event_type = 'FINALISED'
                 AND date_trunc('month', we.occurred_at AT TIME ZONE 'America/Paramaribo') = m.month) AS finalised,
              (SELECT count(*)::int FROM task t WHERE t.status = 'COMPLETED'
                 AND date_trunc('month', t.completed_at AT TIME ZONE 'America/Paramaribo') = m.month) AS "tasksCompleted"
         FROM m LEFT JOIN correspondence_item ci
           ON date_trunc('month', ci.registered_at AT TIME ZONE 'America/Paramaribo') = m.month
        GROUP BY m.month ORDER BY m.month`,
      [months],
    );
    const senders = await this.dataSource.query(
      `SELECT ci.party AS name, count(*)::int AS letters
         FROM correspondence_item ci
        WHERE ci.direction = 'INCOMING' AND ci.state = 'REGISTERED' AND ci.party IS NOT NULL
          AND ci.registered_at > now() - make_interval(months => $1)
        GROUP BY ci.party ORDER BY count(*) DESC LIMIT 10`,
      [months],
    );
    return { months: letters, topSenders: senders };
  }
}
