/**
 * Demonstration and training data.
 *
 *   npm run seed:demo -- --reset
 *
 * Builds a realistic ministry: departments and people, a file plan, approval
 * routes, about seventy letters over fifteen months with their documents, the
 * matters they belong to with their decisions, tasks, advice, replies with
 * seals, WijSamen reports, an exchange with another ministry, and the
 * assistant switched on.
 *
 * Everything is created through the application's own API, as the people
 * concerned, so every rule and every audit event applies. To give the history
 * its real shape, each day's work is created and then moved back to its day;
 * the audit hash chain is recomputed over the moved history at the end, and
 * the integrity check is run on the result.
 *
 * TRAINING DATA ONLY. All people, letters and matters are invented. --reset
 * erases the database it points at: never run it against a live system.
 */
import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();
process.env.SCHEDULER_ENABLED = 'false';
process.env.INTEGRITY_SCHEDULE = 'off';

import { generateKeyPairSync, sign } from 'crypto';
import JSZip from 'jszip';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { closeSessionStore, createApp } from '../app-factory';
import { hashPassword } from '../auth/password';
import { canonicalJson } from '../core/seal.service';
import { dateDaysAgo, fillerLetters, imagePdf, LetterSpec, letterPdf, LETTERS, scanOf } from './demo-content';
import { ROLES, UNITS, USERS } from './seed';

type Agent = ReturnType<typeof request.agent>;

const PASSWORD = process.env.SEED_PASSWORD as string;

const EXTRA_UNITS = [
  { code: 'JZ', name: 'Juridische Zaken en Wetgeving', kind: 'DEPARTMENT', parent: 'HO-DIR' },
  { code: 'JI', name: 'Justitiële Inrichtingen', kind: 'DEPARTMENT', parent: 'HO-DIR' },
  { code: 'VZ', name: 'Vreemdelingenzaken en Naturalisatie', kind: 'DEPARTMENT', parent: 'HO-DIR' },
  { code: 'PZ', name: 'Personeelszaken', kind: 'DEPARTMENT', parent: 'HO-DIR' },
  { code: 'FZ', name: 'Financiële Zaken', kind: 'DEPARTMENT', parent: 'HO-DIR' },
  { code: 'PO', name: 'Politiezaken en Openbare Orde', kind: 'DEPARTMENT', parent: 'HO-DIR' },
  { code: 'REG', name: 'Centrale Registratie en Archief', kind: 'OFFICE', parent: 'HO-KAB' },
  { code: 'IA', name: 'Interne Audit', kind: 'OFFICE', parent: 'HO-KAB' },
];

const EXTRA_PEOPLE = [
  { email: 'kartodikromo@juspol.test', fullName: 'N. Kartodikromo', job: 'Hoofd Juridische Zaken', unit: 'JZ', roles: ['SUPPORT_STAFF'], head: true },
  { email: 'wongsodikromo@juspol.test', fullName: 'P. Wongsodikromo', job: 'Beleidsmedewerker Juridische Zaken', unit: 'JZ', roles: ['SUPPORT_STAFF'] },
  { email: 'sabajo@juspol.test', fullName: 'R. Sabajo', job: 'Hoofd Justitiële Inrichtingen', unit: 'JI', roles: ['SUPPORT_STAFF'], head: true },
  { email: 'doekhie@juspol.test', fullName: 'M. Doekhie', job: 'Medewerker Justitiële Inrichtingen', unit: 'JI', roles: ['SUPPORT_STAFF'] },
  { email: 'chin@juspol.test', fullName: 'A. Chin-A-Kwie', job: 'Hoofd Vreemdelingenzaken', unit: 'VZ', roles: ['SUPPORT_STAFF'], head: true },
  { email: 'vlijter@juspol.test', fullName: 'G. Vlijter', job: 'Hoofd Personeelszaken', unit: 'PZ', roles: ['SUPPORT_STAFF'], head: true },
  { email: 'ramdin@juspol.test', fullName: 'S. Ramdin', job: 'Hoofd Financiële Zaken', unit: 'FZ', roles: ['SUPPORT_STAFF'], head: true },
  { email: 'pengel@juspol.test', fullName: 'K. Pengel', job: 'Hoofd Politiezaken en Openbare Orde', unit: 'PO', roles: ['SUPPORT_STAFF'], head: true },
  { email: 'linger@juspol.test', fullName: 'J. Linger', job: 'Archiefbeheerder', unit: 'REG', roles: ['RECORDS_MANAGER'], head: true },
  { email: 'auditor@juspol.test', fullName: 'T. Kromodimedjo', job: 'Interne auditor', unit: 'IA', roles: ['AUDITOR'], head: true },
];

// ---------------------------------------------------------------- the clock

/**
 * Each day of the story is created now and then moved back to its day: every
 * timestamp written during the batch, and the dates the batch set relative to
 * "today", are moved by the same number of days.
 */
class Clock {
  private columns: { table: string; columns: string[] }[] = [];
  private dates: { table: string; column: string; id: string; timestamp?: boolean }[] = [];

  constructor(private readonly db: DataSource) {}

  async init() {
    const rows: { table_name: string; column_name: string }[] = await this.db.query(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type = 'timestamp with time zone'
          AND c.table_name NOT IN ('migrations', 'user_session')`,
    );
    const byTable = new Map<string, string[]>();
    for (const r of rows) byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), r.column_name]);
    this.columns = [...byTable.entries()].map(([table, columns]) => ({ table, columns }));
  }

  /** A date the batch set as "today + n", to be moved back with the batch. */
  later(table: string, column: string, id: string, timestamp = false) {
    this.dates.push({ table, column, id, timestamp });
  }

  async day(daysAgo: number, work: () => Promise<void>) {
    const [{ t0 }] = await this.db.query(`SELECT clock_timestamp() - interval '1 second' AS t0`);
    this.dates = [];
    await work();
    const [{ t1 }] = await this.db.query(`SELECT clock_timestamp() + interval '1 second' AS t1`);
    const days = Math.round(daysAgo);
    // The batch ran in a few seconds; its moments are spread over that day's
    // office hours (from 08:10 Suriname time), in the order they happened, so
    // the history reads like a working day. Today's batch only up to now.
    const [{ span }] = await this.db.query(
      `SELECT CASE WHEN $1::int > 0 THEN 25200
                   ELSE least(25200, extract(epoch FROM (now() AT TIME ZONE 'America/Paramaribo') - (date_trunc('day', now() AT TIME ZONE 'America/Paramaribo') + interval '8 hours 10 minutes')) - 900) END AS span`,
      [days],
    );
    if (days === 0 && Number(span) <= 600) return;
    // The first and last moment actually written in the batch bound the spread.
    let first: Date | null = null;
    let last: Date | null = null;
    for (const { table, columns } of this.columns) {
      for (const c of columns) {
        const [r] = await this.db.query(`SELECT min("${c}") AS a, max("${c}") AS b FROM "${table}" WHERE "${c}" >= $1 AND "${c}" <= $2`, [t0, t1]);
        if (r?.a && (!first || r.a < first)) first = r.a;
        if (r?.b && (!last || r.b > last)) last = r.b;
      }
    }
    if (!first || !last) return;
    const lo = first.toISOString();
    const width = Math.max((last.getTime() - first.getTime()) / 1000, 0.001);
    const moved = (c: string) =>
      `((date_trunc('day', ('${lo}'::timestamptz - make_interval(days => ${days})) AT TIME ZONE 'America/Paramaribo') + interval '8 hours 10 minutes'
         + (extract(epoch FROM ("${c}" - '${lo}'::timestamptz)) / ${width}) * make_interval(secs => ${Number(span)}))
        AT TIME ZONE 'America/Paramaribo')`;
    // Only what was written during the batch: a value set in the future (an
    // end date) is moved explicitly, through later(), never by this sweep.
    for (const { table, columns } of this.columns) {
      const where = columns.map((c) => `("${c}" >= $1 AND "${c}" <= $2)`).join(' OR ');
      const [hit] = await this.db.query(`SELECT 1 FROM "${table}" WHERE ${where} LIMIT 1`, [t0, t1]);
      if (!hit) continue;
      await this.unguarded(table, () =>
        this.db.query(
          `UPDATE "${table}" SET ${columns.map((c) => `"${c}" = CASE WHEN "${c}" >= $1 AND "${c}" <= $2 THEN ${moved(c)} ELSE "${c}" END`).join(', ')} WHERE ${where}`,
          [t0, t1],
        ),
      );
    }
    if (days === 0) return;
    const shift = `make_interval(days => ${days})`;
    for (const d of this.dates) {
      const by = d.timestamp ? shift : String(days);
      await this.unguarded(d.table, () => this.db.query(`UPDATE "${d.table}" SET "${d.column}" = "${d.column}" - ${by} WHERE id = $1`, [d.id]));
    }
  }

  /** The table's own rules and triggers are lifted for the move only. */
  async unguarded(table: string, fn: () => Promise<unknown>) {
    const rules: { rulename: string }[] = await this.db.query(`SELECT rulename FROM pg_rules WHERE schemaname = 'public' AND tablename = $1`, [table]);
    await this.db.query(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
    for (const r of rules) await this.db.query(`ALTER TABLE "${table}" DISABLE RULE "${r.rulename}"`);
    try {
      await fn();
    } finally {
      for (const r of rules) await this.db.query(`ALTER TABLE "${table}" ENABLE RULE "${r.rulename}"`);
      await this.db.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
    }
  }

  /** The history was moved; its hash chain is computed again, in order. */
  async rechain() {
    await this.unguarded('audit_event', () =>
      this.db.query(`
        DO $$
        DECLARE r audit_event; prev text := '';
        BEGIN
          FOR r IN SELECT * FROM audit_event ORDER BY seq LOOP
            prev := encode(sha256(convert_to(prev || '#' || audit_event_payload(r), 'UTF8')), 'hex');
            UPDATE audit_event SET chain_hash = prev WHERE id = r.id;
          END LOOP;
        END $$`),
    );
  }
}

// ---------------------------------------------------------------- helpers

class Demo {
  agents = new Map<string, Agent>();
  ids = new Map<string, string>();
  items = new Map<string, { id: string; identity: string | null; version: number }>();
  dossiers = new Map<string, string>();
  units = new Map<string, string>();
  categories = new Map<string, string>();
  routes = new Map<string, string>();

  constructor(
    readonly http: ReturnType<typeof request>,
    readonly server: unknown,
    readonly db: DataSource,
    readonly clock: Clock,
  ) {}

  async as(email: string): Promise<Agent> {
    let agent = this.agents.get(email);
    if (!agent) {
      agent = request.agent(this.server as never);
      await ok(agent.post('/api/auth/login').send({ email, password: PASSWORD }), 200);
      this.agents.set(email, agent);
    }
    return agent;
  }

  id(email: string): string {
    const v = this.ids.get(email);
    if (!v) throw new Error(`Unknown account ${email}`);
    return v;
  }

  async dossierVersion(id: string): Promise<number> {
    return (await this.db.query(`SELECT version FROM dossier WHERE id = $1`, [id]))[0].version;
  }

  async taskVersion(id: string): Promise<number> {
    return (await this.db.query(`SELECT version FROM task WHERE id = $1`, [id]))[0].version;
  }

  /** "today + n" as the batch sees it. */
  due(n: number): string {
    return dateDaysAgo(-n);
  }

  async letter(spec: LetterSpec): Promise<{ id: string; identity: string | null }> {
    const agent = await this.as(spec.clerk);
    const pdf = await letterPdf(spec);
    const fields = spec.bare
      ? { direction: 'INCOMING', subject: 'Nieuw poststuk' }
      : {
          direction: 'INCOMING',
          subject: spec.subject,
          party: spec.from,
          documentDate: dateDaysAgo(spec.daysAgo + 2),
          senderReference: spec.kenmerk,
          ...(spec.classification ? { classification: spec.classification } : {}),
        };
    const draft = await ok(agent.post('/api/records/drafts').send(fields), 201);
    if (spec.scanned) {
      const scanned = await imagePdf(scanOf(pdf, 'pdf'));
      await ok(agent.post(`/api/records/${draft.id}/documents`).attach('file', scanned, { filename: 'scan-brief.pdf', contentType: 'application/pdf' }), 201);
    } else if (spec.photo) {
      await ok(agent.post(`/api/records/${draft.id}/documents`).attach('file', scanOf(pdf, 'jpeg'), { filename: 'foto-brief.jpg', contentType: 'image/jpeg' }), 201);
    } else {
      await ok(agent.post(`/api/records/${draft.id}/documents`).attach('file', pdf, { filename: `${spec.key}.pdf`, contentType: 'application/pdf' }), 201);
    }
    let result = { id: draft.id as string, identity: null as string | null, version: draft.version as number };
    if (!spec.draft) {
      const reg = await ok(agent.post(`/api/records/${draft.id}/register`).send({ version: draft.version }), 200);
      result = { id: reg.id, identity: reg.registrationIdentity, version: reg.version };
    }
    this.items.set(spec.key, result);
    return result;
  }

  async dossier(key: string, email: string, subject: string, category: string | null, letters: string[], classification?: string) {
    const agent = await this.as(email);
    const d = await ok(agent.post('/api/dossiers').send({ subject, ...(category ? { categoryId: this.categories.get(category) } : {}), ...(classification ? { classification } : {}) }), 201);
    for (const l of letters) await ok(agent.post(`/api/dossiers/${d.id}/links`).send({ itemId: this.items.get(l)!.id }), 200);
    this.dossiers.set(key, d.id);
    return d.id as string;
  }

  async assign(dossier: string, assigner: string, responsible: string) {
    const agent = await this.as(assigner);
    const id = this.dossiers.get(dossier)!;
    await ok(agent.post(`/api/dossiers/${id}/responsibility`).send({ responsibleAccountId: this.id(responsible), version: await this.dossierVersion(id) }), 200);
  }

  async dueDate(dossier: string, assigner: string, inDays: number) {
    const agent = await this.as(assigner);
    const id = this.dossiers.get(dossier)!;
    await ok(agent.post(`/api/dossiers/${id}/due-date`).send({ dueDate: this.due(inDays), version: await this.dossierVersion(id), reason: 'Termijn volgens categorie' }), 200);
    this.clock.later('dossier', 'due_date', id);
    const [change] = await this.db.query(`SELECT id FROM due_date_change WHERE dossier_id = $1 ORDER BY changed_at DESC LIMIT 1`, [id]);
    if (change) {
      this.clock.later('due_date_change', 'new_due_date', change.id);
      const [prev] = await this.db.query(`SELECT previous_due_date FROM due_date_change WHERE id = $1`, [change.id]);
      if (prev.previous_due_date) this.clock.later('due_date_change', 'previous_due_date', change.id);
    }
  }

  async task(email: string, input: Record<string, unknown> & { dueIn?: number }) {
    const agent = await this.as(email);
    const { dueIn, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    if (dueIn !== undefined) body.dueDate = this.due(dueIn);
    const t = await ok(agent.post('/api/tasks').send(body), 201);
    if (dueIn !== undefined) this.clock.later('task', 'due_date', t.id);
    return t.id as string;
  }

  async taskStatus(email: string, id: string, status: string, note?: string) {
    const agent = await this.as(email);
    await ok(agent.post(`/api/tasks/${id}/status`).send({ status, version: await this.taskVersion(id), ...(note ? { note } : {}) }), 200);
  }

  async complete(email: string, id: string) {
    const agent = await this.as(email);
    await ok(agent.post(`/api/tasks/${id}/complete`).send({ version: await this.taskVersion(id) }), 200);
  }

  async comment(email: string, id: string, body: string) {
    const agent = await this.as(email);
    await ok(agent.post(`/api/tasks/${id}/comments`).send({ body }), 201);
  }

  async submit(dossier: string, email: string, reviewer: string) {
    const agent = await this.as(email);
    const id = this.dossiers.get(dossier)!;
    await ok(agent.post(`/api/dossiers/${id}/submit`).send({ reviewerAccountId: this.id(reviewer), version: await this.dossierVersion(id) }), 200);
  }

  async decide(dossier: string, email: string, action: 'approve' | 'finalise' | 'return', reason?: string) {
    const agent = await this.as(email);
    const id = this.dossiers.get(dossier)!;
    await ok(agent.post(`/api/dossiers/${id}/${action}`).send({ version: await this.dossierVersion(id), ...(reason ? { reason } : {}) }), 200);
  }
}

async function ok(req: request.Test, status: number) {
  const res = await req;
  if (res.status !== status) {
    const r = (res as unknown as { req?: { method?: string; path?: string } }).req;
    throw new Error(`${r?.method} ${r?.path} → ${res.status}: ${JSON.stringify(res.body).slice(0, 600)}`);
  }
  return res.body;
}

// ---------------------------------------------------------------- the story

async function main() {
  if (!PASSWORD) throw new Error('SEED_PASSWORD is not set.');
  const reset = process.argv.includes('--reset');
  const app = await createApp();
  await app.init();
  const db = app.get(DataSource);
  await db.runMigrations();
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM correspondence_item`);
  if (n > 0 && !reset) throw new Error('This database already holds letters. Run with --reset to replace everything with the demonstration data.');
  const tables: { tablename: string }[] = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('migrations')`);
  await db.query(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  for (const s of ['registration_sequence', 'dossier_sequence', 'task_sequence']) await db.query(`ALTER SEQUENCE ${s} RESTART WITH 1`);

  const clock = new Clock(db);
  await clock.init();
  const server = app.getHttpServer();
  const demo = new Demo(request(server), server, db, clock);
  const passwordHash = await hashPassword(PASSWORD);

  // ------------------------------------------------ day -440: the system is set up
  await clock.day(299, async () => {
    for (const role of ROLES) {
      await db.query(`INSERT INTO functional_role (code, name, description) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`, [role.code, role.name, role.description]);
    }
    const kinds: Record<string, string> = { 'HO-KAB': 'CABINET', 'HO-DIR': 'DIRECTORATE', 'HO-ICT': 'SERVICE' };
    const names: Record<string, string> = { 'HO-KAB': 'Kabinet van de Minister', 'HO-DIR': 'Directoraat Justitie', 'HO-ICT': 'ICT en Beheer' };
    for (const unit of UNITS) {
      const [u] = await db.query(`INSERT INTO organisational_unit (code, name, kind) VALUES ($1, $2, $3) RETURNING id`, [unit.code, names[unit.code] ?? unit.name, kinds[unit.code] ?? 'DEPARTMENT']);
      demo.units.set(unit.code, u.id);
    }
    const people = [
      ...USERS.map((u) => ({ email: u.email, fullName: u.fullName, job: u.jobPosition, unit: u.unit, roles: u.roles, disabled: u.disabled, head: false })),
    ];
    for (const p of people) {
      const [person] = await db.query(`INSERT INTO person (full_name, job_position) VALUES ($1, $2) RETURNING id`, [p.fullName, p.job]);
      const [account] = await db.query(
        `INSERT INTO account (email, password_hash, is_enabled, person_id, organisational_unit_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [p.email, passwordHash, p.disabled !== true, person.id, demo.units.get(p.unit)],
      );
      demo.ids.set(p.email, account.id);
      for (const r of p.roles) await db.query(`INSERT INTO role_assignment (account_id, functional_role_id) SELECT $1, id FROM functional_role WHERE code = $2`, [account.id, r]);
    }
    const admin = await demo.as('sysadmin@juspol.test');
    for (const u of EXTRA_UNITS) {
      const created = await ok(admin.post('/api/org/units').send({ code: u.code, name: u.name, kind: u.kind, parentUnitId: demo.units.get(u.parent) }), 201);
      demo.units.set(u.code, created.id);
    }
    for (const p of EXTRA_PEOPLE) {
      const created = await ok(admin.post('/api/admin/accounts').send({ fullName: p.fullName, jobPosition: p.job, email: p.email, unitId: demo.units.get(p.unit), roles: p.roles, initialPassword: PASSWORD }), 201);
      demo.ids.set(p.email, created.id ?? created.accountId);
      if (p.head) await ok(admin.put(`/api/org/units/${demo.units.get(p.unit)}`).send({ headAccountId: demo.ids.get(p.email) }), 200);
    }
    // Account creation may require a password change at first sign-in; demo accounts are ready to use.
    await db.query(`UPDATE account SET password_hash = $1`, [passwordHash]).catch(() => undefined);
    await ok(admin.put(`/api/org/units/${demo.units.get('HO-KAB')}`).send({ headAccountId: demo.id('minister@juspol.test') }), 200);
    await ok(admin.put(`/api/org/units/${demo.units.get('HO-DIR')}`).send({ headAccountId: demo.id('directeur@juspol.test'), parentUnitId: demo.units.get('HO-KAB') }), 200);
    await ok(admin.put(`/api/org/units/${demo.units.get('HO-ICT')}`).send({ headAccountId: demo.id('sysadmin@juspol.test'), parentUnitId: demo.units.get('HO-DIR') }), 200);

    await ok(admin.post('/api/calendar/holidays/load-suriname'), 200);
    const settings = (await ok(admin.get('/api/settings'), 200)) as Record<string, Record<string, unknown>>;
    await ok(admin.put('/api/settings/ai').send({ value: { ...settings.ai, features: Object.fromEntries(Object.keys(settings.ai.features as object).map((k) => [k, true])) } }), 200);

    const routes = [
      { key: 'standard', name: 'Standaard: Onder-Directeur, Directeur', steps: [{ role: 'ONDER_DIRECTEUR', label: 'Paraaf Onder-Directeur' }, { role: 'DIRECTEUR', label: 'Besluit Directeur' }] },
      { key: 'minister', name: 'Ministeriële beslissing', description: 'Voor gratie, benoemingen en antwoorden aan De Nationale Assemblée.', steps: [{ role: 'ONDER_DIRECTEUR', label: 'Paraaf Onder-Directeur' }, { role: 'DIRECTEUR', label: 'Advies Directeur' }, { role: 'MINISTER', label: 'Besluit Minister' }] },
    ];
    const dir = await demo.as('directeur@juspol.test');
    for (const r of routes) {
      const created = await ok(dir.post('/api/approval-routes').send({ name: r.name, description: r.description, steps: r.steps }), 201);
      demo.routes.set(r.key, created.id);
    }
    const rm = await demo.as('linger@juspol.test');
    const cats = [
      { code: 'GR', name: 'Gratieverzoeken', description: 'Verzoeken om gratie of strafvermindering van gedetineerden en hun advocaten.', retentionYears: 20, retentionAction: 'TRANSFER', handlingWorkingDays: 30, route: 'minister' },
      { code: 'JI-PL', name: 'Plaatsing en overplaatsing gedetineerden', description: 'Overplaatsing van gedetineerden tussen inrichtingen, bezoekregelingen, verlof.', retentionYears: 10, retentionAction: 'DESTROY', handlingWorkingDays: 10 },
      { code: 'JI-TZ', name: 'Toezicht en inspectie inrichtingen', description: 'Inspectierapporten, toezicht op penitentiaire inrichtingen, medische zorg.', retentionYears: 20, retentionAction: 'TRANSFER', handlingWorkingDays: 20, classification: 'CONFIDENTIAL' },
      { code: 'WG', name: 'Wetgeving en regelgeving', description: 'Wetsontwerpen, wetswijzigingen, staatsbesluiten en commentaar van De Nationale Assemblée.', retentionYears: 0, retentionAction: 'TRANSFER', handlingWorkingDays: 15, route: 'minister' },
      { code: 'DNA', name: 'Vragen van De Nationale Assemblée', description: 'Schriftelijke en mondelinge vragen van leden van De Nationale Assemblée.', retentionYears: 20, retentionAction: 'TRANSFER', handlingWorkingDays: 10, route: 'minister' },
      { code: 'VZ', name: 'Verblijfsvergunningen en naturalisatie', description: 'Aanvragen voor verblijf, naturalisatie en nationaliteit.', retentionYears: 15, retentionAction: 'DESTROY', handlingWorkingDays: 20 },
      { code: 'IRH', name: 'Internationale rechtshulp en uitlevering', description: 'Rechtshulpverzoeken en uitleveringsverzoeken van andere staten.', retentionYears: 20, retentionAction: 'TRANSFER', handlingWorkingDays: 30, classification: 'CONFIDENTIAL' },
      { code: 'PROC', name: 'Procedures en rechtszaken', description: 'Rechtszaken waarin de Staat partij is, dagvaardingen, verweer.', retentionYears: 10, retentionAction: 'REVIEW', handlingWorkingDays: 20 },
      { code: 'FIN', name: 'Begroting en financiën', description: 'Begroting, subsidies, aanschaf en financiële verantwoording.', retentionYears: 10, retentionAction: 'DESTROY', handlingWorkingDays: 15 },
      { code: 'PZ', name: 'Personeel en benoemingen', description: 'Sollicitaties, benoemingen, personeelsgegevens.', retentionYears: 10, retentionAction: 'DESTROY', handlingWorkingDays: 20 },
      { code: 'KAB', name: 'Uitnodigingen en representatie', description: 'Uitnodigingen voor de Minister, ceremonies, bezoeken. Bewaren tot afhandeling.', retentionYears: 0, retentionAction: 'DESTROY', handlingWorkingDays: 10 },
    ];
    for (const c of cats) {
      const created = await ok(
        rm.post('/api/casefiles/categories').send({
          code: c.code,
          name: c.name,
          description: c.description,
          retentionYears: c.retentionYears,
          retentionAction: c.retentionAction,
          handlingWorkingDays: c.handlingWorkingDays,
          ...(c.classification ? { defaultClassification: c.classification } : {}),
          ...(c.route ? { defaultRouteId: demo.routes.get(c.route) } : {}),
        }),
        201,
      );
      demo.categories.set(c.code, created.id ?? created[created.length - 1]?.id);
    }
    if ([...demo.categories.values()].some((v) => !v)) {
      const rows: { id: string; code: string }[] = await db.query(`SELECT id, code FROM dossier_category`);
      for (const r of rows) demo.categories.set(r.code, r.id);
    }
    await ok(
      dir.post('/api/task-templates').send({
        name: 'Sollicitatieprocedure',
        description: 'Van vacature tot benoeming.',
        titleTemplate: 'Sollicitatieprocedure: {subject}',
        defaultPriority: 'MEDIUM',
        defaultDueWorkingDays: 30,
        checklist: ['Brieven van sollicitanten registreren', 'Selectiecommissie samenstellen', 'Gesprekken plannen', 'Voordracht opstellen'],
        subtasks: [{ title: 'Ontvangstbevestigingen versturen', dueOffsetWorkingDays: 9 }, { title: 'Referenties nagaan', dueOffsetWorkingDays: 15 }],
      }),
      201,
    );
    await ok(
      dir.post('/api/task-templates').send({
        name: 'Beantwoording vragen DNA',
        titleTemplate: 'Antwoord op vragen: {subject}',
        defaultPriority: 'HIGH',
        defaultDueWorkingDays: 8,
        checklist: ['Informatie opvragen bij de afdeling', 'Concept-antwoord opstellen', 'Paraaf Directeur', 'Ondertekening Minister'],
      }),
      201,
    );
  });

  const specs = [...LETTERS, ...fillerLetters()].sort((a, b) => b.daysAgo - a.daysAgo);
  const byKey = new Map(specs.map((s) => [s.key, s]));
  const L = (key: string) => byKey.get(key)!;

  // The story: what happened on which day, besides letters arriving.
  const events = new Map<number, (() => Promise<void>)[]>();
  const on = (day: number, fn: () => Promise<void>) => events.set(day, [...(events.get(day) ?? []), fn]);
  for (const s of specs) on(s.daysAgo, async () => void (await demo.letter(s)));

  const A1 = 'assistant1@juspol.test';
  const A2 = 'assistant2@juspol.test';
  const DIR = 'directeur@juspol.test';
  const OD = 'onderdirecteur@juspol.test';
  const MIN = 'minister@juspol.test';
  const JZH = 'kartodikromo@juspol.test';
  const JZ = 'wongsodikromo@juspol.test';
  const JIH = 'sabajo@juspol.test';
  const JI = 'doekhie@juspol.test';
  const VZH = 'chin@juspol.test';
  const PZH = 'vlijter@juspol.test';
  const FZH = 'ramdin@juspol.test';

  // An invitation, answered, finished and closed: kept only until handled, so due for a retention decision.
  on(295, async () => {
    await demo.dossier('invite', A1, 'Uitnodiging opening politiepost Lelydorp', 'KAB', ['invite-old']);
    await demo.assign('invite', DIR, DIR);
    await demo.dueDate('invite', DIR, 10);
  });
  on(293, async () => {
    await demo.submit('invite', A1, DIR);
    await demo.decide('invite', DIR, 'approve');
    await demo.decide('invite', DIR, 'finalise');
  });
  on(291, async () => {
    const agent = await demo.as(DIR);
    const id = demo.dossiers.get('invite')!;
    await ok(agent.post(`/api/dossiers/${id}/dossier-state/close`).send({ version: await demo.dossierVersion(id), reason: 'Uitnodiging beantwoord; de Minister was aanwezig.' }), 200);
    clockRetention(demo, id);
  });

  // An appointment, decided by the Minister along the ministerial route.
  on(268, async () => {
    await demo.dossier('appointment', A2, 'Benoeming lid Commissie van Toezicht', 'PZ', ['appointment']);
    await demo.assign('appointment', DIR, OD);
    await demo.dueDate('appointment', DIR, 20);
  });
  on(262, async () => {
    const agent = await demo.as(PZH);
    const id = demo.dossiers.get('appointment')!;
    await ok(agent.post(`/api/dossiers/${id}/route/submit`).send({ routeId: demo.routes.get('minister'), reviewerAccountId: demo.id(OD), version: await demo.dossierVersion(id) }), 200);
  });
  on(260, async () => routeApprove(demo, 'appointment', OD, DIR, 'Akkoord, voordracht is volledig.'));
  on(258, async () => routeApprove(demo, 'appointment', DIR, MIN, 'Ter beslissing aan de Minister.'));
  on(255, async () => {
    await routeApprove(demo, 'appointment', MIN, undefined, 'Akkoord met de benoeming.');
    await demo.decide('appointment', MIN, 'finalise');
  });

  // A lawsuit, on legal hold.
  on(188, async () => {
    await demo.dossier('lawsuit', JZ, 'Civiele procedure Bouwbedrijf Santo N.V. tegen de Staat', 'PROC', ['lawsuit']);
    await demo.assign('lawsuit', DIR, 'dualrole@juspol.test');
    await demo.dueDate('lawsuit', DIR, 230);
    const agent = await demo.as(DIR);
    await ok(agent.post(`/api/dossiers/${demo.dossiers.get('lawsuit')}/legal-hold`).send({ action: 'SET', reason: 'Lopende procedure bij het Hof van Justitie; niets mag worden vernietigd.' }), 200);
    const t = await demo.task(JZH, { title: 'Verweerschrift opstellen', assigneeAccountId: demo.id(JZ), dossierId: demo.dossiers.get('lawsuit'), dueIn: 25, priority: 'HIGH', checklist: ['Aanbestedingsstukken verzamelen', 'Advies Landsadvocaat vragen', 'Concept verweer'] });
    demo.ids.set('task-verweer', t);
  });
  on(170, async () => {
    const t = demo.ids.get('task-verweer')!;
    await demo.taskStatus(JZ, t, 'IN_PROGRESS');
    await demo.comment(JZ, t, `Aanbestedingsstukken ontvangen van Financiële Zaken. @[N. Kartodikromo](${demo.id(JZH)}) kunt u het concept beoordelen?`);
  });
  on(166, async () => demo.complete(JZ, demo.ids.get('task-verweer')!).catch(async () => {
    const agent = await demo.as(JZ);
    const t = demo.ids.get('task-verweer')!;
    const detail = await ok(agent.get(`/api/tasks/${t}`), 200);
    for (const c of detail.checklist ?? []) await ok(agent.patch(`/api/tasks/${t}/checklist/${c.id}`).send({ done: true }), 200);
    await demo.complete(JZ, t);
  }));

  // A weekly routine of the registry.
  on(1, async () => {
    await demo.task(A1, { title: 'Weekoverzicht binnengekomen post naar het Kabinet', assigneeAccountId: demo.id(A1), dueIn: 2, recurrence: 'WEEKLY', priority: 'MEDIUM' });
  });

  // The reply on personnel data, sent to Home Affairs as a signed exchange package.
  on(148, async () => {
    await demo.dossier('census', A1, 'Personeelstelling 2025 voor Binnenlandse Zaken', 'PZ', ['gen-2']);
    await demo.assign('census', DIR, OD);
    await demo.dueDate('census', DIR, 25);
    const t = await demo.task(PZH, { title: 'Personeelsgegevens per afdeling verzamelen', assigneeAccountId: demo.id(PZH), dossierId: demo.dossiers.get('census'), dueIn: 14 });
    demo.ids.set('task-census', t);
  });
  on(136, async () => {
    await demo.complete(PZH, demo.ids.get('task-census')!);
    await demo.submit('census', PZH, DIR);
    await demo.decide('census', DIR, 'approve');
    await demo.decide('census', DIR, 'finalise');
  });

  // A pardon request: the ministerial route, now with the Minister.
  on(65, async () => {
    await demo.dossier('pardon', JZ, 'Gratieverzoek J. Pinas', 'GR', ['pardon']);
    await demo.assign('pardon', DIR, 'dualrole@juspol.test');
    await demo.dueDate('pardon', DIR, 42);
    const t1 = await demo.task(JZH, { title: 'Vonnis en strafdossier opvragen bij het Openbaar Ministerie', assigneeAccountId: demo.id(JZ), dossierId: demo.dossiers.get('pardon'), dueIn: 7 });
    demo.ids.set('task-pardon-1', t1);
    const agent = await demo.as(JZH);
    await ok(agent.post(`/api/dossiers/${demo.dossiers.get('pardon')}/advice`).send({ requestedFromAccountId: demo.id(JIH), question: 'Graag uw gedragsrapport over de heer J. Pinas en uw advies over het gratieverzoek.', dueDate: demo.due(10) }), 201);
  });
  on(58, async () => {
    await demo.complete(JZ, demo.ids.get('task-pardon-1')!);
    const agent = await demo.as(JIH);
    const [advice] = await db.query(`SELECT id FROM advice_request WHERE dossier_id = $1`, [demo.dossiers.get('pardon')]);
    await ok(agent.post(`/api/advice/${advice.id}/answer`).send({ answer: 'De heer Pinas gedraagt zich voorbeeldig, volgt de vakopleiding en heeft geen disciplinaire straffen gehad. Wij adviseren positief over het gratieverzoek.' }), 200);
  });
  on(20, async () => {
    const agent = await demo.as(JZH);
    const id = demo.dossiers.get('pardon')!;
    await ok(agent.post(`/api/dossiers/${id}/route/submit`).send({ routeId: demo.routes.get('minister'), reviewerAccountId: demo.id(OD), version: await demo.dossierVersion(id) }), 200);
  });
  on(15, async () => routeApprove(demo, 'pardon', OD, DIR, 'Dossier volledig, positief advies Justitiële Inrichtingen.'));
  on(6, async () => routeApprove(demo, 'pardon', DIR, MIN, 'Ik adviseer de Minister gratie te verlenen voor het resterende deel van de straf.'));

  // A request for mutual legal assistance, confidential, in English.
  on(57, async () => {
    await demo.dossier('mla', JZH, 'Rechtshulpverzoek Nederland, fraudeonderzoek', 'IRH', ['mla'], 'CONFIDENTIAL');
    await demo.assign('mla', DIR, DIR);
    await demo.dueDate('mla', DIR, 60);
    const t = await demo.task(JZH, { title: 'Bankgegevens opvragen via het Openbaar Ministerie', assigneeAccountId: demo.id(JZH), dossierId: demo.dossiers.get('mla'), dueIn: 30, priority: 'HIGH' });
    await demo.taskStatus(JZH, t, 'IN_PROGRESS');
  });

  // The Victim Support bill: comments from the Assembly, an overdue draft, now with the Directeur.
  on(51, async () => {
    await demo.dossier('bill', JZ, 'Wet Slachtofferhulp: reactie op commentaar Vaste Commissie', 'WG', ['bill']);
    await demo.assign('bill', OD, 'dualrole@juspol.test');
    await demo.dueDate('bill', OD, 59);
  });
  on(40, async () => {
    const t = await demo.task(JZH, { title: 'Concept-reactie op de vragen van de Vaste Commissie', assigneeAccountId: demo.id(JZ), dossierId: demo.dossiers.get('bill'), dueIn: 45, priority: 'HIGH', checklist: ['Vragen inventariseren', 'Antwoorden per vraag', 'Afstemming met het OM'] });
    demo.ids.set('task-bill', t);
    await demo.comment(JZH, t, `@[P. Wongsodikromo](${demo.id(JZ)}) graag de vragen 3 tot en met 7 eerst, die zijn voor de Minister het belangrijkst.`);
  });
  on(30, async () => {
    const t = demo.ids.get('task-bill')!;
    await demo.taskStatus(JZ, t, 'IN_PROGRESS');
  });
  on(3, async () => demo.submit('bill', JZH, DIR));

  // The 2027 budget: tasks for every department, meeting notes turned into actions.
  on(44, async () => {
    await demo.dossier('budget', FZH, 'Ontwerpbegroting 2027 Justitie en Politie', 'FIN', ['budget']);
    await demo.assign('budget', DIR, DIR);
    const agent = await demo.as(DIR);
    const id = demo.dossiers.get('budget')!;
    await ok(agent.post(`/api/dossiers/${id}/due-date`).send({ dueDate: '2026-11-30', version: await demo.dossierVersion(id), reason: 'Indiening bij Financiën en Planning' }), 200);
    const parent = await demo.task(FZH, { title: 'Begrotingsbijdragen van de afdelingen verzamelen', assigneeAccountId: demo.id(FZH), dossierId: id, dueIn: 50, priority: 'HIGH', checklist: ['Instructie doorsturen', 'Bijdragen ontvangen', 'Consolideren'] });
    demo.ids.set('task-budget', parent);
    for (const [email, unit] of [[JZH, 'Juridische Zaken'], [JIH, 'Justitiële Inrichtingen'], [VZH, 'Vreemdelingenzaken'], [PZH, 'Personeelszaken']]) {
      const sub = await demo.task(FZH, { title: `Begrotingsbijdrage ${unit}`, assigneeAccountId: demo.id(email), dossierId: id, parentTaskId: parent, dueIn: 21 });
      demo.ids.set(`budget-${email}`, sub);
    }
  });
  on(30, async () => {
    await demo.complete(JZH, demo.ids.get(`budget-${JZH}`)!);
    await demo.complete(PZH, demo.ids.get(`budget-${PZH}`)!);
    await demo.taskStatus(JIH, demo.ids.get(`budget-${JIH}`)!, 'IN_PROGRESS');
  });
  on(14, async () => {
    const agent = await demo.as(DIR);
    const notes = [
      'Notulen begrotingsoverleg',
      'Aanwezig: Sardjoe, Ramdin, Sabajo, Chin-A-Kwie',
      '- Ramdin stuurt de geconsolideerde begroting uiterlijk 20 november naar de Directeur',
      '- Actie Sabajo: kosten medische zorg Santo Boma onderbouwen, spoed',
      '- Chin-A-Kwie levert de raming voor de vreemdelingenbewaring volgende week aan',
      'Rondvraag: geen',
    ].join('\n');
    const r = await ok(agent.post('/api/ai/meeting-notes').send({ text: notes, dossierId: demo.dossiers.get('budget') }), 200);
    const tasks = r.proposals.filter((p: { assignee: unknown }) => p.assignee).map((p: { title: string; assignee: { accountId: string }; dueDate: string | null; priority: string }) => ({
      title: p.title,
      assigneeAccountId: p.assignee.accountId,
      dueDate: p.dueDate,
      priority: p.priority,
      dossierId: demo.dossiers.get('budget'),
    }));
    const applied = await ok(agent.post(`/api/ai/interactions/${r.interactionId}/feedback`).send({ outcome: 'ACCEPTED', apply: { tasks } }), 200);
    for (const t of applied.applied.tasks) clock.later('task', 'due_date', t.id);
  });

  // A residence permit: returned by the Directeur for a missing document.
  on(39, async () => {
    await demo.dossier('residence', VZH, 'Verblijfsvergunning familie Mohan', 'VZ', ['residence']);
    await demo.assign('residence', DIR, OD);
    await demo.dueDate('residence', DIR, 45);
  });
  on(27, async () => demo.submit('residence', VZH, DIR));
  on(25, async () => demo.decide('residence', DIR, 'return', 'De arbeidsovereenkomst is niet gelegaliseerd. Graag een gelegaliseerd afschrift opvragen voordat ik beslis.'));
  on(24, async () => {
    await demo.task(VZH, { title: 'Gelegaliseerde arbeidsovereenkomst opvragen bij de advocaat', assigneeAccountId: demo.id(VZH), dossierId: demo.dossiers.get('residence'), dueIn: 28 });
  });

  // The inspection report: confidential, deadline in two days, advice overdue.
  on(33, async () => {
    await demo.dossier('inspection', JIH, 'Inspectierapport Santo Boma, derde kwartaal', 'JI-TZ', ['inspection'], 'CONFIDENTIAL');
    await demo.assign('inspection', DIR, OD);
    await demo.dueDate('inspection', DIR, 35);
    const agent = await demo.as(JIH);
    await ok(agent.post(`/api/dossiers/${demo.dossiers.get('inspection')}/advice`).send({ requestedFromAccountId: demo.id(FZH), question: 'Welk budget is beschikbaar voor uitbreiding van de medische zorg in Santo Boma in 2026 en 2027?', dueDate: demo.due(14) }), 201);
    const [a] = await db.query(`SELECT id FROM advice_request WHERE dossier_id = $1`, [demo.dossiers.get('inspection')]);
    clock.later('advice_request', 'due_date', a.id);
    const t = await demo.task(JIH, { title: 'Plan van aanpak overbevolking afdelingen B en C', assigneeAccountId: demo.id(JI), dossierId: demo.dossiers.get('inspection'), dueIn: 38, priority: 'URGENT' });
    demo.ids.set('task-inspection', t);
  });

  // Parliamentary questions about overcrowding: past their deadline.
  on(20, async () => {
    await demo.dossier('questions', A1, 'Schriftelijke vragen DNA over overbevolking justitiële inrichtingen', 'DNA', ['questions']);
    await demo.assign('questions', DIR, DIR);
    await demo.dueDate('questions', DIR, 14);
    const agent = await demo.as(A1);
    await ok(agent.post(`/api/dossiers/${demo.dossiers.get('questions')}/relations`).send({ relatedDossierId: demo.dossiers.get('inspection'), relation: 'SAME_SUBJECT', note: 'Beide gaan over de overbevolking in Santo Boma.' }), 201).catch(() => undefined);
    const tpl = (await ok(agent.get('/api/task-templates'), 200)).find((t: { name: string }) => t.name === 'Beantwoording vragen DNA');
    const dirAgent = await demo.as(DIR);
    const applied = await ok(dirAgent.post(`/api/task-templates/${tpl.id}/apply`).send({ assigneeAccountId: demo.id(JIH), dossierId: demo.dossiers.get('questions') }), 201);
    clock.later('task', 'due_date', applied.id ?? applied.task?.id);
  });

  // A transfer request, a criminal file request, a vacancy, an urgent scanned letter.
  on(15, async () => {
    await demo.dossier('transfer', JI, 'Overplaatsing gedetineerde R. Pinas naar Santo Boma', 'JI-PL', ['transfer']);
    await demo.assign('transfer', OD, OD);
    await demo.dueDate('transfer', OD, 19);
    await demo.task(JIH, { title: 'Plaatsingsmogelijkheden in Santo Boma nagaan', assigneeAccountId: demo.id(JI), dossierId: demo.dossiers.get('transfer'), dueIn: 19 });
  });
  on(11, async () => {
    await demo.dossier('inzage', JZ, 'Verzoek inzage strafdossier R. Pinas (KPS)', 'PROC', ['inzage']);
    await demo.assign('inzage', OD, 'dualrole@juspol.test');
    await demo.dueDate('inzage', OD, 14);
  });
  on(9, async () => {
    await demo.dossier('vacancy', PZH, 'Vacature beleidsmedewerker Juridische Zaken', 'PZ', ['staff']);
    const agent = await demo.as(PZH);
    const tpl = (await ok(agent.get('/api/task-templates'), 200)).find((t: { name: string }) => t.name === 'Sollicitatieprocedure');
    const applied = await ok(agent.post(`/api/task-templates/${tpl.id}/apply`).send({ assigneeAccountId: demo.id(PZH), dossierId: demo.dossiers.get('vacancy') }), 201);
    const taskId = applied.id ?? applied.task?.id;
    if (taskId) clock.later('task', 'due_date', taskId);
    const subs: { id: string }[] = await db.query(`SELECT id FROM task WHERE parent_task_id = $1`, [taskId]);
    for (const s of subs) clock.later('task', 'due_date', s.id);
  });
  on(7, async () => {
    await demo.task(A1, { title: 'Melding medicijntekort doorzetten naar Justitiële Inrichtingen', assigneeAccountId: demo.id(JIH), itemId: demo.items.get('scan')!.id, dueIn: 9, priority: 'URGENT' });
  });

  // Routine matters of the last three months, handled and decided — most on time, one late.
  const routine = fillerLetters().filter((f) => f.daysAgo <= 92 && f.daysAgo >= 20).slice(0, 10);
  const owners = [JZ, JI, VZH, PZH, FZH, JZ, JI, A2, FZH, VZH];
  const cats = ['PROC', 'JI-PL', 'VZ', 'PZ', 'FIN', 'WG', 'JI-TZ', 'KAB', 'FIN', 'VZ'];
  routine.forEach((f, i) => {
    const key = `routine-${i}`;
    const owner = owners[i % owners.length];
    on(f.daysAgo - 1, async () => {
      await demo.dossier(key, owner, f.subject, cats[i % cats.length], [f.key]);
      await demo.assign(key, OD, OD);
      await demo.dueDate(key, OD, 12);
    });
    const done = f.daysAgo - 1 - (i === 3 ? 17 : 4 + (i % 5));
    on(done, async () => {
      await demo.submit(key, owner, DIR);
      await demo.decide(key, DIR, 'approve');
      await demo.decide(key, DIR, 'finalise');
      if (i % 3 === 0) {
        const clerk = await demo.as(A1);
        const reply = await ok(clerk.post(`/api/records/${demo.items.get(f.key)!.id}/reply`).send({}), 201);
        await ok(clerk.post(`/api/records/${reply.id}/draft-versions`).send({ body: `Geachte heer/mevrouw,\n\nWij bevestigen de ontvangst van uw stuk inzake "${f.subject}" en hebben dit ter kennisneming aangenomen.\n\nHoogachtend,\n\nDe Minister van Justitie en Politie` }), 201);
        const [v] = await db.query(`SELECT version FROM correspondence_item WHERE id = $1`, [reply.id]);
        await ok(clerk.post(`/api/records/${reply.id}/register`).send({ version: v.version }), 200);
      }
    });
  });
  on(8, async () => {
    const t = demo.ids.get(`budget-${VZH}`);
    if (t) await demo.complete(VZH, t);
  });

  // Delegation, out of office, an exchange with Home Affairs, WijSamen reports.
  on(10, async () => {
    const agent = await demo.as(DIR);
    await ok(agent.post('/api/delegations').send({ delegateAccountId: demo.id(OD), actions: ['ASSIGN_RESPONSIBILITY', 'SET_DUE_DATE'], validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 30 * 86400_000).toISOString() }), 201);
    const [dl] = await db.query(`SELECT id FROM delegation ORDER BY granted_at DESC LIMIT 1`);
    clock.later('delegation', 'valid_from', dl.id, true);
    clock.later('delegation', 'valid_until', dl.id, true);
  });
  on(3, async () => {
    const agent = await demo.as(PZH);
    await ok(agent.post('/api/out-of-office').send({ startsOn: demo.due(0), endsOn: demo.due(10), standInAccountId: demo.id('dualrole@juspol.test'), message: 'Met verlof. Voor personeelszaken kunt u terecht bij S. Hiwat.' }), 201);
    const [o] = await db.query(`SELECT id FROM out_of_office ORDER BY created_at DESC LIMIT 1`);
    if (o) {
      clock.later('out_of_office', 'starts_on', o.id);
      clock.later('out_of_office', 'ends_on', o.id);
    }
  });

  const biza = generateKeyPairSync('ed25519');
  let wijsamenKey = '';
  on(12, async () => {
    const admin = await demo.as('sysadmin@juspol.test');
    const key = await ok(admin.post('/api/admin/integrations').send({ name: 'WijSamen app', kind: 'WIJSAMEN', actAsAccountId: demo.id(A1) }), 201);
    wijsamenKey = key.key;
    await ok(admin.post('/api/admin/integrations').send({ name: 'Mailserver ministerie', kind: 'MAIL_GATEWAY', actAsAccountId: demo.id(A2) }), 201);
    await ok(admin.post('/api/exchange/partners').send({ code: 'BIZA', name: 'Ministerie van Binnenlandse Zaken', publicKeyPem: biza.publicKey.export({ type: 'spki', format: 'pem' }) }), 200);
    await ok(admin.post('/api/exchange/partners').send({ code: 'OM', name: 'Openbaar Ministerie', publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) }), 200);
  });
  on(8, async () => {
    const dir = await demo.as(DIR);
    await ok(dir.post(`/api/exchange/dossiers/${demo.dossiers.get('census')}/export`).send({ partnerCode: 'BIZA' }), 200);
    // And a package from Home Affairs, signed with their key.
    const me = await ok(dir.get('/api/exchange/identity'), 200);
    const zip = new JSZip();
    const letter = await letterPdf({ key: 'biza', daysAgo: 8, clerk: A1, from: 'Ministerie van Binnenlandse Zaken', kenmerk: 'BZ/CBB/26-311', subject: 'Verzoek verificatie verblijfsstatus ten behoeve van het bevolkingsregister', body: ['Ten behoeve van de bijhouding van het bevolkingsregister verzoeken wij u de verblijfsstatus van de familie Mohan te bevestigen.'], signer: 'drs. M. Ooft' });
    const { createHash } = await import('crypto');
    zip.file('files/001-brief.pdf', letter);
    const manifest = {
      format: 'juspol-exchange/1',
      id: 'biza-2026-311',
      from: { code: 'BIZA', name: 'Ministerie van Binnenlandse Zaken', keyId: 'biza' },
      to: { code: me.code, name: me.name },
      createdAt: new Date().toISOString(),
      createdBy: 'drs. M. Ooft',
      dossier: { identity: 'BZ-2026-0311', subject: 'Verificatie verblijfsstatus', classification: 'INTERNAL' },
      items: [{ registrationIdentity: 'BZ/CBB/26-311', direction: 'OUTGOING', subject: 'Verzoek verificatie verblijfsstatus familie Mohan', party: null, documentDate: dateDaysAgo(9), senderReference: null, classification: 'INTERNAL', documents: [{ path: 'files/001-brief.pdf', filename: 'Verzoek BIZA.pdf', mediaType: 'application/pdf', sha256: createHash('sha256').update(letter).digest('hex'), byteSize: letter.length }] }],
    };
    const bytes = Buffer.from(canonicalJson(manifest));
    zip.file('manifest.json', bytes);
    zip.file('manifest.sig', sign(null, bytes, biza.privateKey).toString('base64'));
    const clerk = await demo.as(A2);
    await ok(clerk.post('/api/exchange/import').attach('package', await zip.generateAsync({ type: 'nodebuffer' }), 'pakket-biza.zip'), 201);
  });
  const wijsamen = async (reference: string, subject: string, description: string, name: string) => {
    const { qrPng } = await import('../core/pdf');
    return ok(
      demo.http.post('/api/integrations/wijsamen/reports').set('X-Api-Key', wijsamenKey).send({
        reference,
        category: 'Klacht politieoptreden',
        subject,
        description,
        reporter: { name, email: 'melder@example.sr' },
        location: 'Paramaribo-Noord',
        occurredOn: dateDaysAgo(6),
        attachments: [{ filename: 'foto-situatie.png', contentType: 'image/png', base64: (await qrPng(`WijSamen ${reference}`)).toString('base64') }],
      }),
      201,
    );
  };
  on(6, async () => {
    const r = await wijsamen('WS-2026-004812', 'Onheus behandeld bij aangifte op politiepost Flora', 'Bij het doen van aangifte van een inbraak werd ik onheus behandeld en werd mijn aangifte eerst geweigerd.', 'R. Jong A Lim');
    const agent = await demo.as(A1);
    const [v] = await db.query(`SELECT version FROM correspondence_item WHERE id = $1`, [r.itemId]);
    await ok(agent.post(`/api/records/${r.itemId}/register`).send({ version: v.version }), 200);
    demo.items.set('ws-1', { id: r.itemId, identity: null, version: 0 });
    await demo.dossier('complaint', A1, 'Klacht over bejegening op politiepost Flora (WijSamen)', null, ['ws-1']);
    await demo.assign('complaint', OD, OD);
    await demo.dueDate('complaint', OD, 12);
  });
  on(1, async () => {
    await wijsamen('WS-2026-005077', 'Geen reactie op klacht over geluidsoverlast', 'Ik heb drie weken geleden een klacht ingediend over geluidsoverlast naast de politiepost Latour, maar nooit een reactie gekregen.', 'mevr. A. Tjin');
  });

  // Replies: the census answer and the invitation reply, registered and sealed.
  on(2, async () => {
    const clerk = await demo.as(A1);
    const reply = await ok(clerk.post(`/api/records/${demo.items.get('gen-6')!.id}/reply`).send({}), 201);
    const tpl = (await ok(clerk.get('/api/letters/templates'), 200)).find((t: { code: string }) => t.code === 'ANTWOORD');
    const filled = await ok(clerk.post(`/api/letters/templates/${tpl.id}/fill`).send({ itemId: demo.items.get('gen-6')!.id }), 200);
    const body = (filled.body ?? filled.text ?? '').replace(/\[[^\]]*\]/g, 'Het ministerie zal deelnemen met een delegatie van drie personen onder leiding van de Directeur.');
    await ok(clerk.post(`/api/records/${reply.id}/draft-versions`).send({ body: body || 'Geachte heer Morrison,\n\nHet ministerie zal deelnemen met een delegatie van drie personen.\n\nHoogachtend,', note: 'Eerste versie', templateId: tpl.id }), 201);
    const [v] = await db.query(`SELECT version FROM correspondence_item WHERE id = $1`, [reply.id]);
    await ok(clerk.post(`/api/records/${reply.id}/register`).send({ version: v.version }), 200);
    const dir = await demo.as(DIR);
    await ok(dir.post(`/api/records/${reply.id}/compose`).send({ seal: true }), 201).catch(async () => ok(dir.post(`/api/records/${reply.id}/compose`).send({ seal: true }), 200));
  });

  // The assistant at work: a summary for the Minister, a proposal judged.
  on(1, async () => {
    const minister = await demo.as(MIN);
    await ok(minister.post(`/api/ai/dossiers/${demo.dossiers.get('pardon')}/summary`).send({}), 200);
    const clerk = await demo.as(A1);
    const intake = await ok(clerk.post(`/api/ai/items/${demo.items.get('photo')!.id}/intake`), 200);
    await ok(clerk.post(`/api/ai/interactions/${intake.interactionId}/feedback`).send({ outcome: 'ACCEPTED', note: 'Velden klopten.' }), 200);
    const dup = await ok(clerk.post(`/api/ai/items/${demo.items.get('pardon')!.id}/duplicates`), 200);
    void dup;
  });

  // The day-to-day work around the matters.
  on(5, async () => {
    const t1 = await demo.task(JIH, { title: 'Medicijnvoorraad aanvullen in overleg met Volksgezondheid', assigneeAccountId: demo.id(JI), itemId: demo.items.get('scan')!.id, dueIn: 6, priority: 'HIGH', checklist: ['Lijst tekorten opstellen', 'Contact Ministerie van Volksgezondheid', 'Levering bevestigen'] });
    await demo.taskStatus(JI, t1, 'WAITING', 'Wacht op reactie van het Ministerie van Volksgezondheid.');
    const agent = await demo.as(JI);
    const detail = await ok(agent.get(`/api/tasks/${t1}`), 200);
    if (detail.checklist?.[0]) await ok(agent.patch(`/api/tasks/${t1}/checklist/${detail.checklist[0].id}`).send({ done: true }), 200);
    await demo.comment(JI, t1, `Lijst is opgesteld. @[R. Sabajo](${demo.id(JIH)}) belt u morgen met Volksgezondheid?`);
    const t2 = await demo.task(OD, { title: 'Juridisch advies vergunning schietwedstrijd', assigneeAccountId: demo.id(JZ), itemId: demo.items.get('firearms')!.id, dueIn: 7, priority: 'MEDIUM' });
    await demo.taskStatus(JZ, t2, 'IN_REVIEW', 'Concept-advies ter beoordeling bij het hoofd.');
    const t3 = await demo.task(A2, { title: 'Archiefdozen 2025 overdragen aan Centrale Registratie', assigneeAccountId: demo.id(A2), dueIn: 9, priority: 'LOW' });
    await demo.taskStatus(A2, t3, 'ACCEPTED');
    const t4 = await demo.task(DIR, { title: 'Personeelsdossiers 2010–2015 digitaliseren', assigneeAccountId: demo.id(PZH), dueIn: 20, priority: 'LOW' });
    const pz = await demo.as(PZH);
    await ok(pz.post(`/api/tasks/${t4}/reject`).send({ version: await demo.taskVersion(t4), reason: 'Hiervoor is geen capaciteit tot na de begroting; graag opnieuw inplannen in januari.' }), 200);
  });
  on(2, async () => {
    await demo.task(DIR, { title: 'Ontvangstbevestiging sturen aan de familie Pinas', assigneeAccountId: demo.id(A1), itemId: demo.items.get('transfer')!.id, dueIn: 2, priority: 'MEDIUM' });
    await demo.task(DIR, { title: 'Agenda staf-overleg maandag voorbereiden', assigneeAccountId: demo.id(A1), dueIn: 3, priority: 'MEDIUM', checklist: ['Stand begroting', 'Vragen DNA', 'Inspectierapport Santo Boma'] });
    await demo.task(MIN, { title: 'Toespraak opening justitiecomplex Nickerie', assigneeAccountId: demo.id(DIR), dueIn: 12, priority: 'HIGH' });
  });

  const days = [...events.keys()].sort((a, b) => b - a);
  for (const day of days) {
    process.stdout.write(`  day -${day}\r`);
    await clock.day(day, async () => {
      for (const fn of events.get(day)!) await fn();
    });
  }
  console.log('');

  // The weekly task's repeats were made at "today"; leave them, they are the current week's.
  await clock.rechain();

  // The integrity check, on the finished history.
  const auditor = await demo.as('auditor@juspol.test');
  const check = await ok(auditor.post('/api/integrity/run'), 200);
  console.log(`Integrity check: ${check.ok ? 'intact' : 'PROBLEMS'} — ${check.audit.events} audit events, ${check.documents.checked} files, ${check.seals.checked} seals.`);

  const counts = await db.query(`SELECT (SELECT count(*) FROM correspondence_item)::int AS letters, (SELECT count(*) FROM dossier)::int AS matters, (SELECT count(*) FROM task)::int AS tasks, (SELECT count(*) FROM account)::int AS people`);
  console.log('Demonstration data ready:', counts[0]);
  console.log(`Sign in with any of the @juspol.test accounts and the SEED_PASSWORD, e.g. minister@juspol.test, directeur@juspol.test, assistant1@juspol.test, auditor@juspol.test, linger@juspol.test, sysadmin@juspol.test.`);
  await app.close();
  closeSessionStore();
}

function clockRetention(demo: Demo, dossierId: string) {
  demo.clock.later('dossier', 'retention_due_date', dossierId);
}

async function routeApprove(demo: Demo, dossier: string, email: string, next: string | undefined, note: string) {
  const agent = await demo.as(email);
  const id = demo.dossiers.get(dossier)!;
  await ok(agent.post(`/api/dossiers/${id}/route/approve`).send({ version: await demo.dossierVersion(id), ...(next ? { nextReviewerAccountId: demo.id(next) } : {}), note }), 200);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
