import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { Mailer, PushSender, SmsSender } from './delivery';
import { DEFAULT_CHANNELS, NotificationKind, render } from './notification-templates';

export interface NotifyInput {
  recipients: (string | null | undefined)[];
  kind: NotificationKind;
  params: Record<string, string | number | null | undefined>;
  link?: string;
  subjectType?: 'TASK' | 'DOSSIER' | 'ITEM' | 'ADVICE' | 'ACCOUNT';
  subjectId?: string;
  /** The person who caused it; they are not notified of their own action. */
  actorAccountId?: string | null;
}

interface Recipient {
  id: string;
  email: string;
  person_name: string;
  language: 'nl' | 'en';
  email_mode: 'IMMEDIATE' | 'DIGEST' | 'OFF';
  mobile_number: string | null;
}

/**
 * Creates notifications and queues their delivery.
 *
 * The in-app notification is always created. E-mail, SMS and push follow the
 * person's preferences and the system switches. When the person is out of
 * office, their stand-in receives a copy marked as such.
 *
 * Delivery happens after the queue is written, so a slow mail server never
 * slows the action that caused the notification, and a failed delivery stays
 * in the outbox with its error for an administrator to see.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notifications');
  private flushing = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly mailer: Mailer,
    private readonly sms: SmsSender,
    private readonly push: PushSender,
  ) {}

  async notify(input: NotifyInput): Promise<number> {
    const ids = [...new Set(input.recipients.filter((id): id is string => !!id))].filter(
      (id) => id !== input.actorAccountId,
    );
    if (ids.length === 0) return 0;
    const standIns: { account_id: string; stand_in_account_id: string }[] = await this.dataSource.query(
      `SELECT account_id, stand_in_account_id FROM out_of_office
        WHERE account_id = ANY($1) AND ended_at IS NULL
          AND starts_on <= (now() AT TIME ZONE 'America/Paramaribo')::date
          AND ends_on >= (now() AT TIME ZONE 'America/Paramaribo')::date`,
      [ids],
    );
    const targets: { id: string; forAbsent: string | null }[] = ids.map((id) => ({ id, forAbsent: null }));
    for (const s of standIns) {
      if (s.stand_in_account_id !== input.actorAccountId && !ids.includes(s.stand_in_account_id)) {
        targets.push({ id: s.stand_in_account_id, forAbsent: s.account_id });
      }
    }
    const recipients: Recipient[] = await this.dataSource.query(
      `SELECT a.id, a.email, p.full_name AS person_name,
              coalesce(c.language, 'nl') AS language, coalesce(c.email_mode, 'IMMEDIATE') AS email_mode,
              c.mobile_number
         FROM account a JOIN person p ON p.id = a.person_id
         LEFT JOIN account_contact c ON c.account_id = a.id
        WHERE a.id = ANY($1) AND a.is_enabled`,
      [targets.map((t) => t.id)],
    );
    const absentNames = new Map<string, string>();
    if (standIns.length) {
      const rows: { id: string; full_name: string }[] = await this.dataSource.query(
        `SELECT a.id, p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = ANY($1)`,
        [standIns.map((s) => s.account_id)],
      );
      rows.forEach((r) => absentNames.set(r.id, r.full_name));
    }
    const switches = await this.settings.get('notifications');
    const prefs: { account_id: string; email: boolean; sms: boolean; push: boolean }[] = await this.dataSource.query(
      `SELECT account_id, email, sms, push FROM notification_preference WHERE account_id = ANY($1) AND kind = $2`,
      [targets.map((t) => t.id), input.kind],
    );
    let created = 0;
    for (const target of targets) {
      const r = recipients.find((x) => x.id === target.id);
      if (!r) continue;
      const pref = prefs.find((p) => p.account_id === r.id) ?? DEFAULT_CHANNELS[input.kind];
      const message = render(input.kind, input.params, r.language);
      const title = target.forAbsent
        ? `${r.language === 'en' ? 'For' : 'Voor'} ${absentNames.get(target.forAbsent) ?? ''}: ${message.title}`.slice(0, 300)
        : message.title;
      await this.dataSource.query(
        `INSERT INTO notification (account_id, kind, title, body, link, subject_type, subject_id, for_absent_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.id, input.kind, title, message.body, input.link ?? null, input.subjectType ?? null, input.subjectId ?? null, target.forAbsent],
      );
      created += 1;
      if (switches.emailEnabled && pref.email && r.email_mode === 'IMMEDIATE') {
        const branding = await this.settings.get('branding');
        await this.queueEmail(r.id, r.email, title, `${message.body}\n\n${linkText(input.link)}`, emailHtml(branding, title, message.body, input.link), input.kind);
      }
      if (switches.smsEnabled && pref.sms && r.mobile_number) {
        await this.dataSource.query(
          `INSERT INTO sms_outbox (account_id, to_number, body, kind) VALUES ($1, $2, $3, $4)`,
          [r.id, r.mobile_number, `${title}`.slice(0, 600), input.kind],
        );
      }
      if (switches.pushEnabled && pref.push && background()) {
        void this.pushTo(r.id, { title, body: message.body, link: input.link ?? '/' });
      }
    }
    if (background()) void this.flush();
    return created;
  }

  async queueEmail(accountId: string | null, to: string, subject: string, text: string, html: string | null, kind: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO email_outbox (account_id, to_address, subject, body_text, body_html, kind)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [accountId, to, subject.slice(0, 400), text, html, kind],
    );
  }

  /** Delivers queued e-mail and SMS. Safe to call repeatedly; one run at a time. */
  async flush(): Promise<{ email: number; sms: number }> {
    if (this.flushing) return { email: 0, sms: 0 };
    this.flushing = true;
    let email = 0;
    let sms = 0;
    try {
      const mails: { id: string; to_address: string; subject: string; body_text: string; body_html: string | null }[] =
        await this.dataSource.query(
          `SELECT id, to_address, subject, body_text, body_html FROM email_outbox
            WHERE status = 'QUEUED' OR (status = 'FAILED' AND attempts < 5)
            ORDER BY created_at LIMIT 50`,
        );
      for (const m of mails) {
        try {
          const status = await this.mailer.send(m.to_address, m.subject, m.body_text, m.body_html);
          await this.dataSource.query(
            `UPDATE email_outbox SET status = $2, attempts = attempts + 1, sent_at = now(), last_error = NULL WHERE id = $1`,
            [m.id, status],
          );
          email += 1;
        } catch (error) {
          await this.dataSource.query(
            `UPDATE email_outbox SET status = 'FAILED', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            [m.id, (error as Error).message.slice(0, 600)],
          );
        }
      }
      const texts: { id: string; to_number: string; body: string }[] = await this.dataSource.query(
        `SELECT id, to_number, body FROM sms_outbox
          WHERE status = 'QUEUED' OR (status = 'FAILED' AND attempts < 5)
          ORDER BY created_at LIMIT 50`,
      );
      for (const t of texts) {
        try {
          const status = await this.sms.send(t.to_number, t.body);
          await this.dataSource.query(
            `UPDATE sms_outbox SET status = $2, attempts = attempts + 1, sent_at = now(), last_error = NULL WHERE id = $1`,
            [t.id, status],
          );
          sms += 1;
        } catch (error) {
          await this.dataSource.query(
            `UPDATE sms_outbox SET status = 'FAILED', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            [t.id, (error as Error).message.slice(0, 600)],
          );
        }
      }
    } catch (error) {
      this.logger.error(`Outbox flush failed: ${(error as Error).message}`);
    } finally {
      this.flushing = false;
    }
    return { email, sms };
  }

  async pushTo(accountId: string, payload: { title: string; body: string; link: string }): Promise<number> {
    const subs: { id: string; endpoint: string; p256dh: string; auth: string }[] = await this.dataSource.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId],
    );
    let sent = 0;
    for (const s of subs) {
      try {
        await this.push.send(s, payload);
        await this.dataSource.query(`UPDATE push_subscription SET last_sent_at = now(), last_error = NULL WHERE id = $1`, [s.id]);
        sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        await this.dataSource.query(
          `UPDATE push_subscription SET last_error = $2, revoked_at = CASE WHEN $3 THEN now() ELSE revoked_at END WHERE id = $1`,
          [s.id, String((error as Error).message).slice(0, 400), status === 404 || status === 410],
        );
      }
    }
    return sent;
  }
}

/**
 * Delivery runs in the background in a server. Under test it is driven
 * explicitly, so no work outlives the test that caused it.
 */
function background(): boolean {
  return process.env.NODE_ENV !== 'test';
}

function linkText(link?: string): string {
  if (!link) return '';
  const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
  return `${base}${link}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function emailHtml(
  branding: { organisationName: string; productName: string; primaryColor: string },
  title: string,
  body: string,
  link?: string,
): string {
  const url = linkText(link);
  return `<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 0"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:${branding.primaryColor};color:#ffffff;padding:16px 24px;font-size:14px">${escapeHtml(branding.organisationName)} · ${escapeHtml(branding.productName)}</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:18px;color:#111827;margin:0 0 12px">${escapeHtml(title)}</h1>
<p style="font-size:15px;line-height:1.5;color:#374151;margin:0 0 20px">${escapeHtml(body)}</p>
${url ? `<a href="${escapeHtml(url)}" style="display:inline-block;background:${branding.primaryColor};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">Openen</a>` : ''}
</td></tr><tr><td style="padding:12px 24px;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb">Dit bericht is automatisch verstuurd. U kunt uw meldingsvoorkeuren wijzigen in uw profiel.</td></tr>
</table></td></tr></table></body></html>`;
}
