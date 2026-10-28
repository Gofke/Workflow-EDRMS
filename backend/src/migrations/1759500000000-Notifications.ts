import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — notifications, deadlines and the working-day calendar.
 *
 * 1. notification — what a person sees under the bell. Read state is the only
 *    thing that changes on it.
 * 2. Per-person preferences: which kinds arrive by e-mail, SMS or push, and
 *    whether e-mail comes one by one or as a daily summary.
 * 3. Outboxes for e-mail and SMS. A message is queued first and delivered
 *    after, so a mail server that is down delays a message instead of losing
 *    it, and an administrator can see exactly what was sent to whom.
 * 4. deadline_notice — one row per reminder or escalation actually sent. The
 *    unique key is what stops the same reminder being sent twice when the
 *    scheduler runs again.
 * 5. public_holiday — the Suriname holidays that do not count as working days.
 * 6. job_run — a log of every scheduled job, with its outcome.
 */
export class Notifications1759500000000 implements MigrationInterface {
  name = 'Notifications1759500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "notification" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL,
        "kind" character varying(40) NOT NULL,
        "title" character varying(300) NOT NULL,
        "body" character varying(1000) NOT NULL DEFAULT '',
        "link" character varying(300),
        "subject_type" character varying(20),
        "subject_id" uuid,
        "for_absent_account_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "read_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_notification" PRIMARY KEY ("id"),
        CONSTRAINT "fk_notification_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "ix_notification_account" ON "notification" ("account_id", "created_at" DESC)`);
    await q.query(`CREATE INDEX "ix_notification_unread" ON "notification" ("account_id") WHERE "read_at" IS NULL`);
    await q.query(`CREATE RULE "notification_no_delete" AS ON DELETE TO "notification" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "notification_preference" (
        "account_id" uuid NOT NULL,
        "kind" character varying(40) NOT NULL,
        "in_app" boolean NOT NULL DEFAULT true,
        "email" boolean NOT NULL DEFAULT true,
        "sms" boolean NOT NULL DEFAULT false,
        "push" boolean NOT NULL DEFAULT true,
        CONSTRAINT "pk_notification_preference" PRIMARY KEY ("account_id", "kind"),
        CONSTRAINT "fk_notification_preference_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT
      )`);
    await q.query(`
      CREATE TABLE "account_contact" (
        "account_id" uuid NOT NULL,
        "email_mode" character varying(12) NOT NULL DEFAULT 'IMMEDIATE',
        "mobile_number" character varying(30),
        "language" character varying(2) NOT NULL DEFAULT 'nl',
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_account_contact" PRIMARY KEY ("account_id"),
        CONSTRAINT "fk_account_contact_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_account_contact_mode" CHECK ("email_mode" IN ('IMMEDIATE','DIGEST','OFF')),
        CONSTRAINT "ck_account_contact_language" CHECK ("language" IN ('nl','en'))
      )`);

    await q.query(`
      CREATE TABLE "email_outbox" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "account_id" uuid,
        "to_address" character varying(320) NOT NULL,
        "subject" character varying(400) NOT NULL,
        "body_text" text NOT NULL,
        "body_html" text,
        "kind" character varying(40) NOT NULL,
        "status" character varying(12) NOT NULL DEFAULT 'QUEUED',
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" character varying(600),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "sent_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_email_outbox" PRIMARY KEY ("id"),
        CONSTRAINT "ck_email_outbox_status" CHECK ("status" IN ('QUEUED','SENT','FAILED','LOGGED'))
      )`);
    await q.query(`CREATE INDEX "ix_email_outbox_status" ON "email_outbox" ("status", "created_at")`);
    await q.query(`
      CREATE TABLE "sms_outbox" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "account_id" uuid,
        "to_number" character varying(30) NOT NULL,
        "body" character varying(640) NOT NULL,
        "kind" character varying(40) NOT NULL,
        "status" character varying(12) NOT NULL DEFAULT 'QUEUED',
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" character varying(600),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "sent_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_sms_outbox" PRIMARY KEY ("id"),
        CONSTRAINT "ck_sms_outbox_status" CHECK ("status" IN ('QUEUED','SENT','FAILED','LOGGED'))
      )`);
    await q.query(`
      CREATE TABLE "push_subscription" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL,
        "endpoint" character varying(1000) NOT NULL,
        "p256dh" character varying(200) NOT NULL,
        "auth" character varying(100) NOT NULL,
        "user_agent" character varying(400),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "last_sent_at" TIMESTAMP WITH TIME ZONE,
        "last_error" character varying(400),
        CONSTRAINT "pk_push_subscription" PRIMARY KEY ("id"),
        CONSTRAINT "uq_push_subscription_endpoint" UNIQUE ("endpoint"),
        CONSTRAINT "fk_push_subscription_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT
      )`);

    await q.query(`
      CREATE TABLE "deadline_notice" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subject_type" character varying(20) NOT NULL,
        "subject_id" uuid NOT NULL,
        "notice_kind" character varying(30) NOT NULL,
        "due_date" date NOT NULL,
        "recipient_account_id" uuid NOT NULL,
        "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_deadline_notice" PRIMARY KEY ("id"),
        CONSTRAINT "uq_deadline_notice" UNIQUE ("subject_type", "subject_id", "notice_kind", "due_date", "recipient_account_id"),
        CONSTRAINT "ck_deadline_notice_type" CHECK ("subject_type" IN ('TASK','DOSSIER','ADVICE'))
      )`);
    await q.query(`CREATE RULE "deadline_notice_no_update" AS ON UPDATE TO "deadline_notice" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "deadline_notice_no_delete" AS ON DELETE TO "deadline_notice" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "public_holiday" (
        "holiday_date" date NOT NULL,
        "name" character varying(200) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_public_holiday" PRIMARY KEY ("holiday_date")
      )`);
    await q.query(`
      CREATE TABLE "job_run" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "job" character varying(60) NOT NULL,
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "outcome" jsonb,
        CONSTRAINT "pk_job_run" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_job_run_job" ON "job_run" ("job", "started_at" DESC)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of ['job_run', 'public_holiday', 'deadline_notice', 'push_subscription', 'sms_outbox', 'email_outbox', 'account_contact', 'notification_preference', 'notification']) {
      await q.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }
}
