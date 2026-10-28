import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { readableDate, todayInSuriname } from '../common/actor';
import { emailHtml, NotificationService } from '../core/notification.service';
import { WorkingDaysService } from '../core/working-days.service';
import { OrgService } from '../org/org.service';
import { SettingsService } from '../settings/settings.service';

interface Subject {
  type: 'TASK' | 'DOSSIER' | 'ADVICE';
  id: string;
  label: string;
  due: string;
  holder: string | null;
  holderName: string | null;
  owner: string | null;
  unitHead: string | null;
  link: string;
}

export interface DeadlineRunResult {
  today: string;
  reminders: number;
  overdue: number;
  escalations: number;
}

/**
 * Deadlines that act on their own.
 *
 * Every open task, matter and advice request with a due date is looked at in
 * working days: a reminder on each configured day before; a notice on the day
 * after; and, when it stays overdue, an escalation to the holder's supervisor
 * and then to the supervisor's supervisor. Each notice is sent once —
 * deadline_notice remembers it — so running the job twice sends nothing twice.
 *
 * The same scheduler sends the daily summary e-mail to those who chose it and
 * the weekly overview to the decision-makers.
 */
@Injectable()
export class DeadlinesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Deadlines');
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    private readonly workingDays: WorkingDaysService,
    private readonly org: OrgService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.SCHEDULER_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    setTimeout(() => void this.tick(), 5_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scheduler beat: deliver the outbox; hourly, the deadline run; at their hours, the summaries. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.notifications.flush();
      const hourKey = now.toISOString().slice(0, 13);
      if (!(await this.ranSince('deadlines', hourKey))) await this.logged('deadlines', hourKey, () => this.run());
      const local = new Date(now.getTime() - 3 * 3600_000);
      const n = await this.settings.get('notifications');
      const dayKey = local.toISOString().slice(0, 10);
      if (local.getUTCHours() >= n.digestHour && !(await this.ranSince('digest', dayKey))) {
        await this.logged('digest', dayKey, () => this.sendDigests());
      }
      if (local.getUTCDay() === n.weeklyReportWeekday && local.getUTCHours() >= n.weeklyReportHour && !(await this.ranSince('weekly-report', dayKey))) {
        await this.logged('weekly-report', dayKey, () => this.sendWeeklyReports());
      }
    } catch (error) {
      this.logger.error(`Scheduler beat failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async ranSince(job: string, key: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM job_run WHERE job = $1 AND outcome->>'key' = $2 AND finished_at IS NOT NULL LIMIT 1`,
      [job, key],
    );
    return rows.length > 0;
  }

  async logged<T>(job: string, key: string, work: () => Promise<T>): Promise<T> {
    const [row] = await this.dataSource.query(`INSERT INTO job_run (job, outcome) VALUES ($1, $2) RETURNING id`, [job, JSON.stringify({ key })]);
    try {
      const result = await work();
      await this.dataSource.query(`UPDATE job_run SET finished_at = now(), outcome = $2 WHERE id = $1`, [
        row.id,
        JSON.stringify({ key, result }),
      ]);
      return result;
    } catch (error) {
      await this.dataSource.query(`UPDATE job_run SET finished_at = now(), outcome = $2 WHERE id = $1`, [
        row.id,
        JSON.stringify({ key, error: (error as Error).message }),
      ]);
      throw error;
    }
  }

  /** The deadline run. `today` may be given to test or to replay a day. */
  async run(today = todayInSuriname()): Promise<DeadlineRunResult> {
    const cfg = await this.settings.get('deadlines');
    const result: DeadlineRunResult = { today, reminders: 0, overdue: 0, escalations: 0 };
    for (const s of await this.subjects()) {
      if (s.due >= today) {
        const left = await this.workingDays.workingDaysBetween(today, s.due);
        if (cfg.reminderDaysBefore.includes(left) && s.holder) {
          if (await this.once(s, `REMINDER_${left}`, s.holder)) {
            await this.notifications.notify({
              recipients: [s.holder],
              kind: 'DEADLINE_REMINDER',
              params: { label: s.label, days: left, due: readableDate(s.due) },
              link: s.link,
              subjectType: s.type === 'ADVICE' ? 'ADVICE' : s.type,
              subjectId: s.id,
            });
            result.reminders += 1;
          }
        }
        continue;
      }
      const late = await this.workingDays.workingDaysBetween(s.due, today);
      if (late < 1) continue; // the due date fell on a weekend or holiday; nothing is late yet
      const overdueTo = [s.holder, s.owner].filter((x): x is string => !!x);
      for (const recipient of overdueTo) {
        if (await this.once(s, 'OVERDUE', recipient)) {
          await this.notifications.notify({
            recipients: [recipient],
            kind: 'DEADLINE_OVERDUE',
            params: { label: s.label, due: readableDate(s.due) },
            link: s.link,
            subjectType: s.type === 'ADVICE' ? 'ADVICE' : s.type,
            subjectId: s.id,
          });
          result.overdue += 1;
        }
      }
      if (late >= Math.max(cfg.escalateAfterWorkingDays, 1)) {
        const first = s.holder ? await this.org.supervisorOf(s.holder) : s.unitHead;
        if (first && (await this.once(s, 'ESCALATION_1', first))) {
          await this.escalate(s, first, late, 1);
          result.escalations += 1;
        }
        if (first && late >= cfg.escalateAfterWorkingDays + cfg.secondEscalationAfterWorkingDays) {
          const second = await this.org.supervisorOf(first);
          if (second && second !== first && (await this.once(s, 'ESCALATION_2', second))) {
            await this.escalate(s, second, late, 2);
            result.escalations += 1;
          }
        }
      }
    }
    return result;
  }

  private async escalate(s: Subject, to: string, late: number, level: number): Promise<void> {
    await this.notifications.notify({
      recipients: [to],
      kind: 'DEADLINE_ESCALATION',
      params: { label: s.label, days: late, due: readableDate(s.due), person: s.holderName ?? 'Niemand' },
      link: s.link,
      subjectType: s.type === 'ADVICE' ? 'ADVICE' : s.type,
      subjectId: s.id,
    });
    const [target] = await this.dataSource.query(`SELECT p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1`, [to]);
    await this.audit.recordStrict({
      eventType: AuditEventType.DEADLINE_ESCALATED,
      actorAccountId: null,
      actorDescription: 'Scheduler',
      subjectDescription: s.label.slice(0, 260),
      newValue: `level ${level} → ${target?.full_name ?? to}`,
      summary: `${s.label} is ${late} working day(s) overdue and was escalated (level ${level}) to ${target?.full_name ?? 'the supervisor'}.`.slice(0, 600),
    });
  }

  /** True the first time this notice is sent for this subject, due date and person. */
  private async once(s: Subject, kind: string, recipient: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      `INSERT INTO deadline_notice (subject_type, subject_id, notice_kind, due_date, recipient_account_id)
       SELECT $1::varchar, $2::uuid, $3::varchar, $4::date, $5::uuid
        WHERE NOT EXISTS (SELECT 1 FROM deadline_notice WHERE subject_type = $1::varchar AND subject_id = $2::uuid
                            AND notice_kind = $3::varchar AND due_date = $4::date AND recipient_account_id = $5::uuid)
       RETURNING id`,
      [s.type, s.id, kind, s.due, recipient],
    ).catch((error: { code?: string }) => {
      // Two runs racing for the same notice: the other one sent it.
      if (error.code === '23505') return [];
      throw error;
    });
    return rows.length > 0;
  }

  private async subjects(): Promise<Subject[]> {
    const tasks = await this.dataSource.query(
      `SELECT t.id, t.reference || ' — ' || t.title AS label, to_char(t.due_date, 'YYYY-MM-DD') AS due,
              t.assignee_account_id AS holder, ap.full_name AS holder_name, t.owner_account_id AS owner
         FROM task t JOIN account a ON a.id = t.assignee_account_id JOIN person ap ON ap.id = a.person_id
        WHERE t.due_date IS NOT NULL AND t.archived_at IS NULL
          AND t.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW')`,
    );
    const dossiers = await this.dataSource.query(
      `SELECT d.id, d.dossier_identity || ' — ' || d.subject AS label, to_char(d.due_date, 'YYYY-MM-DD') AS due,
              ra.responsible_account_id AS holder, rp.full_name AS holder_name, u.head_account_id AS unit_head
         FROM dossier d
         LEFT JOIN responsibility_assignment ra ON ra.dossier_id = d.id AND ra.superseded_at IS NULL
         LEFT JOIN account a ON a.id = ra.responsible_account_id LEFT JOIN person rp ON rp.id = a.person_id
         LEFT JOIN organisational_unit u ON u.id = d.owning_unit_id
        WHERE d.due_date IS NOT NULL AND d.state <> 'CLOSED' AND d.processing_state NOT IN ('APPROVED','FINALISED')`,
    );
    const advice = await this.dataSource.query(
      `SELECT ar.id, 'Advies ' || d.dossier_identity || ' — ' || left(ar.question, 80) AS label,
              to_char(ar.due_date, 'YYYY-MM-DD') AS due, ar.requested_from_account_id AS holder, fp.full_name AS holder_name,
              ar.requested_by_account_id AS owner, d.id AS dossier_id
         FROM advice_request ar JOIN dossier d ON d.id = ar.dossier_id
         JOIN account a ON a.id = ar.requested_from_account_id JOIN person fp ON fp.id = a.person_id
        WHERE ar.status = 'OPEN' AND ar.due_date IS NOT NULL`,
    );
    return [
      ...tasks.map((t: Record<string, string>) => ({ type: 'TASK' as const, id: t.id, label: t.label, due: t.due, holder: t.holder, holderName: t.holder_name, owner: t.owner, unitHead: null, link: `/taken/${t.id}` })),
      ...dossiers.map((d: Record<string, string>) => ({ type: 'DOSSIER' as const, id: d.id, label: d.label, due: d.due, holder: d.holder, holderName: d.holder_name, owner: null, unitHead: d.unit_head, link: `/zaken/${d.id}` })),
      ...advice.map((a: Record<string, string>) => ({ type: 'ADVICE' as const, id: a.id, label: a.label, due: a.due, holder: a.holder, holderName: a.holder_name, owner: a.owner, unitHead: null, link: `/zaken/${a.dossier_id}` })),
    ];
  }

  /** The daily summary for everyone who chose it instead of one e-mail per notification. */
  async sendDigests(): Promise<{ sent: number }> {
    const n = await this.settings.get('notifications');
    if (!n.emailEnabled) return { sent: 0 };
    const people: { id: string; email: string; full_name: string; last: Date | null; language: string }[] = await this.dataSource.query(
      `SELECT a.id, a.email, p.full_name, c.last_digest_at AS last, c.language
         FROM account_contact c JOIN account a ON a.id = c.account_id JOIN person p ON p.id = a.person_id
        WHERE c.email_mode = 'DIGEST' AND a.is_enabled`,
    );
    const branding = await this.settings.get('branding');
    let sent = 0;
    for (const person of people) {
      const items: { title: string; body: string }[] = await this.dataSource.query(
        `SELECT title, body FROM notification WHERE account_id = $1 AND read_at IS NULL
            AND created_at > coalesce($2, now() - interval '1 day') ORDER BY created_at`,
        [person.id, person.last],
      );
      if (items.length) {
        const en = person.language === 'en';
        const subject = en ? `Daily summary: ${items.length} notification(s)` : `Dagoverzicht: ${items.length} melding(en)`;
        const text = items.map((i) => `• ${i.title}\n  ${i.body}`).join('\n');
        await this.notifications.queueEmail(person.id, person.email, subject, text, emailHtml(branding, subject, items.map((i) => `• ${i.title}`).join(' \n'), '/meldingen'), 'DIGEST');
        sent += 1;
      }
      await this.dataSource.query(`UPDATE account_contact SET last_digest_at = now() WHERE account_id = $1`, [person.id]);
    }
    await this.notifications.flush();
    return { sent };
  }

  /** Monday morning: the week in numbers, for every decision-maker. */
  async sendWeeklyReports(): Promise<{ sent: number }> {
    const [stats] = await this.dataSource.query(`
      SELECT
        (SELECT count(*)::int FROM correspondence_item WHERE registered_at > now() - interval '7 days') AS registered,
        (SELECT count(*)::int FROM dossier WHERE state <> 'CLOSED' AND processing_state <> 'FINALISED') AS open_matters,
        (SELECT count(*)::int FROM dossier WHERE due_date < (now() AT TIME ZONE 'America/Paramaribo')::date
            AND state <> 'CLOSED' AND processing_state NOT IN ('APPROVED','FINALISED')) AS overdue_matters,
        (SELECT count(*)::int FROM task WHERE status = 'COMPLETED' AND completed_at > now() - interval '7 days') AS tasks_done,
        (SELECT count(*)::int FROM task WHERE due_date < (now() AT TIME ZONE 'America/Paramaribo')::date
            AND status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW') AND archived_at IS NULL) AS tasks_overdue,
        (SELECT count(*)::int FROM workflow_event WHERE event_type = 'FINALISED' AND occurred_at > now() - interval '7 days') AS finalised`);
    const summary =
      `Afgelopen week: ${stats.registered} stukken geregistreerd, ${stats.finalised} zaken afgerond, ${stats.tasks_done} taken voltooid. ` +
      `Nu open: ${stats.open_matters} zaken, waarvan ${stats.overdue_matters} over de termijn; ${stats.tasks_overdue} taken over tijd.`;
    const recipients: { id: string }[] = await this.dataSource.query(
      `SELECT DISTINCT a.id FROM account a JOIN role_assignment ra ON ra.account_id = a.id AND ra.revoked_at IS NULL
         JOIN functional_role r ON r.id = ra.functional_role_id
        WHERE r.code IN ('MINISTER','DIRECTEUR','ONDER_DIRECTEUR') AND a.is_enabled`,
    );
    await this.notifications.notify({ recipients: recipients.map((r) => r.id), kind: 'WEEKLY_REPORT', params: { summary }, link: '/dashboard' });
    await this.audit.recordStrict({
      eventType: AuditEventType.WEEKLY_REPORT_SENT,
      actorAccountId: null,
      actorDescription: 'Scheduler',
      summary: `The weekly overview was sent to ${recipients.length} decision-maker(s).`,
    });
    await this.notifications.flush();
    return { sent: recipients.length };
  }
}
