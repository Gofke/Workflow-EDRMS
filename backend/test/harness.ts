import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { closeSessionStore, createApp } from '../src/app-factory';
import { hashPassword } from '../src/auth/password';
import { ROLES, UNITS, USERS } from '../src/seed/seed';

// Environment is loaded by test/env.ts through Jest setupFiles, which runs
// before any application module is imported.

export const SEED_PASSWORD = process.env.SEED_PASSWORD as string;

export interface Harness {
  app: INestApplication;
  db: DataSource;
  close: () => Promise<void>;
}

/** Boots the real application once, runs migrations, and seeds the pilot actors. */
export async function startHarness(): Promise<Harness> {
  const app = await createApp();
  await app.init();

  const db = app.get(DataSource);
  await db.runMigrations();
  await truncateAll(db);
  await seedActors(db);

  return {
    app,
    db,
    close: async () => {
      await app.close();
      closeSessionStore();
    },
  };
}

/**
 * Clears business data and event history between spec files.
 *
 * audit_event cannot be truncated through DELETE — its append-only rule makes
 * that a no-op — so TRUNCATE is used, which bypasses rules by design. That is
 * exactly why production credentials should not carry TRUNCATE rights, and why
 * this belongs to the test harness only.
 */
export async function truncateAll(db: DataSource): Promise<void> {
  await db.query(
    `TRUNCATE document_text, dossier_state_event, workflow_event, delegation, captured_document, responsibility_assignment, due_date_change,
              dossier_link, dossier,
              correspondence_item, audit_event, role_assignment,
              account, person, functional_role, organisational_unit, user_session
       RESTART IDENTITY CASCADE`,
  );
  await db.query(`ALTER SEQUENCE registration_sequence RESTART WITH 1`);
  await db.query(`ALTER SEQUENCE dossier_sequence RESTART WITH 1`);
}

/** Seeds the same actors as the pilot seed, reusing its data rather than copying it. */
export async function seedActors(db: DataSource): Promise<void> {
  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const role of ROLES) {
    await db.query(
      `INSERT INTO functional_role (code, name, description) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [role.code, role.name, role.description],
    );
  }
  for (const unit of UNITS) {
    await db.query(
      `INSERT INTO organisational_unit (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO NOTHING`,
      [unit.code, unit.name],
    );
  }
  for (const user of USERS) {
    const [person] = await db.query(
      `INSERT INTO person (full_name, job_position) VALUES ($1, $2) RETURNING id`,
      [user.fullName, user.jobPosition],
    );
    const [unit] = await db.query(`SELECT id FROM organisational_unit WHERE code = $1`, [user.unit]);
    const [account] = await db.query(
      `INSERT INTO account (email, password_hash, is_enabled, person_id, organisational_unit_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user.email, passwordHash, user.disabled !== true, person.id, unit?.id ?? null],
    );
    for (const roleCode of user.roles) {
      await db.query(
        `INSERT INTO role_assignment (account_id, functional_role_id)
         SELECT $1, id FROM functional_role WHERE code = $2`,
        [account.id, roleCode],
      );
    }
  }
}

/** A signed-in agent that keeps its session cookie across requests. */
export async function signIn(app: INestApplication, email: string) {
  const agent = request.agent(app.getHttpServer());
  const response = await agent
    .post('/api/auth/login')
    .send({ email, password: SEED_PASSWORD })
    .expect(200);
  return { agent, identity: response.body };
}

export async function accountIdFor(db: DataSource, email: string): Promise<string> {
  const [row] = await db.query(`SELECT id FROM account WHERE email = $1`, [email]);
  return row.id;
}

/** Fails the test if the expected event is absent, with the trail in the message. */
export async function expectAuditEvent(
  db: DataSource,
  eventType: string,
  contains?: string,
): Promise<Record<string, unknown>> {
  const rows = await db.query(
    `SELECT event_type, actor_description, represented_authority, subject_description,
            previous_value, new_value, summary, occurred_at
       FROM audit_event WHERE event_type = $1 ORDER BY occurred_at DESC`,
    [eventType],
  );
  const match = contains
    ? rows.find((row: { summary: string }) => row.summary.includes(contains))
    : rows[0];
  if (!match) {
    throw new Error(
      `No ${eventType} event${contains ? ` containing "${contains}"` : ''}. ` +
        `Events present: ${JSON.stringify(rows.map((r: { summary: string }) => r.summary))}`,
    );
  }
  return match;
}
