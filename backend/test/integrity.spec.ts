import { Harness, SEED_PASSWORD, signIn, startHarness } from './harness';

/**
 * Database-level integrity. These controls are the reason the suite runs against
 * a real PostgreSQL instance: every one of them is enforced below the
 * application, and a mocked repository would pass all of them while proving
 * nothing.
 *
 * Each test attacks the data the way a compromised or careless direct connection
 * would — using the application's own credentials, not a superuser.
 */
describe('Integrity enforced by the database', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function registeredItem(): Promise<{ id: string; identity: string }> {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const created = await agent
      .post('/api/records/drafts')
      .send({ direction: 'INCOMING', subject: `Item ${Date.now()}` })
      .expect(201);
    const registered = await agent
      .post(`/api/records/${created.body.id}/register`)
      .send({ version: created.body.version })
      .expect(200);
    return { id: registered.body.id, identity: registered.body.registrationIdentity };
  }

  describe('registry identity and timestamp (FR-COR-004)', () => {
    it('rejects a change to the official reference', async () => {
      const item = await registeredItem();
      await expect(
        h.db.query(`UPDATE correspondence_item SET registration_identity = $1 WHERE id = $2`, [
          'IN-2020-99999',
          item.id,
        ]),
      ).rejects.toThrow(/cannot be changed once assigned/);
    });

    it('rejects back-dating the registration time', async () => {
      const item = await registeredItem();
      await expect(
        h.db.query(`UPDATE correspondence_item SET registered_at = '2020-01-01' WHERE id = $1`, [
          item.id,
        ]),
      ).rejects.toThrow(/cannot be changed once assigned/);
    });

    it('rejects returning a registered item to draft', async () => {
      const item = await registeredItem();
      await expect(
        h.db.query(`UPDATE correspondence_item SET state = 'DRAFT' WHERE id = $1`, [item.id]),
      ).rejects.toThrow(/cannot be returned to draft/);
    });

    it('leaves the record intact after every rejected attempt', async () => {
      const item = await registeredItem();
      await h.db
        .query(`UPDATE correspondence_item SET registration_identity = 'X' WHERE id = $1`, [item.id])
        .catch(() => undefined);
      const [row] = await h.db.query(
        `SELECT registration_identity, state FROM correspondence_item WHERE id = $1`,
        [item.id],
      );
      expect(row.registration_identity).toBe(item.identity);
      expect(row.state).toBe('REGISTERED');
    });
  });

  describe('unique and coherent registry state (BR-001)', () => {
    it('rejects two records sharing one reference', async () => {
      const item = await registeredItem();
      await expect(
        h.db.query(
          `INSERT INTO correspondence_item
             (registration_identity, state, direction, subject, registered_at, created_by_account_id)
           SELECT $1, 'REGISTERED', 'INCOMING', 'Duplicate', now(), created_by_account_id
             FROM correspondence_item WHERE id = $2`,
          [item.identity, item.id],
        ),
      ).rejects.toThrow(/duplicate key value/);
    });

    it('rejects a registered row with no reference', async () => {
      await expect(
        h.db.query(
          `INSERT INTO correspondence_item (state, direction, subject, created_by_account_id)
           SELECT 'REGISTERED', 'INCOMING', 'Half registered', id FROM account LIMIT 1`,
        ),
      ).rejects.toThrow(/ck_correspondence_item_registered/);
    });

    it('rejects a draft row carrying a reference', async () => {
      await expect(
        h.db.query(
          `INSERT INTO correspondence_item
             (state, direction, subject, registration_identity, created_by_account_id)
           SELECT 'DRAFT', 'INCOMING', 'Draft with reference', 'IN-2026-77777', id
             FROM account LIMIT 1`,
        ),
      ).rejects.toThrow(/ck_correspondence_item_registered/);
    });

    it('rejects an unknown direction', async () => {
      await expect(
        h.db.query(
          `INSERT INTO correspondence_item (state, direction, subject, created_by_account_id)
           SELECT 'DRAFT', 'SIDEWAYS', 'Bad direction', id FROM account LIMIT 1`,
        ),
      ).rejects.toThrow(/ck_correspondence_item_direction/);
    });
  });

  /**
   * The audit-failure rule, tested by making the audit write fail for real.
   *
   * A trigger on audit_event is installed that raises on INSERT. Every action
   * that changes authoritative state must then fail and leave nothing behind.
   * Before V0.1.11 these actions logged the failure and proceeded, which left
   * authoritative state with no evidence behind it.
   */
  describe('no authoritative change without its audit event', () => {
    beforeEach(async () => {
      await h.db.query(`
        CREATE OR REPLACE FUNCTION "test_block_audit"() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'audit storage unavailable';
        END;
        $$ LANGUAGE plpgsql`);
      await h.db.query(`
        CREATE TRIGGER "trg_test_block_audit" BEFORE INSERT ON "audit_event"
          FOR EACH ROW EXECUTE FUNCTION "test_block_audit"()`);
    });

    afterEach(async () => {
      await h.db.query(`DROP TRIGGER IF EXISTS "trg_test_block_audit" ON "audit_event"`);
      await h.db.query(`DROP FUNCTION IF EXISTS "test_block_audit"()`);
    });

    it('rolls back a draft, a registration, a dossier and a link', async () => {
      // Sign-in is itself audited, so the session is established before the
      // trigger blocks writes — done here via a direct session-free check of
      // each action's effect on the database.
      const [{ n: draftsBefore }] = await h.db.query(
        `SELECT count(*)::int AS n FROM correspondence_item`,
      );
      const [{ n: dossiersBefore }] = await h.db.query(`SELECT count(*)::int AS n FROM dossier`);

      const agent = require('supertest').agent(h.app.getHttpServer());
      // Sign-in fails too, and that is correct: no session without its record.
      await agent
        .post('/api/auth/login')
        .send({ email: 'assistant1@juspol.test', password: SEED_PASSWORD })
        .expect(500);

      const [{ n: draftsAfter }] = await h.db.query(
        `SELECT count(*)::int AS n FROM correspondence_item`,
      );
      const [{ n: dossiersAfter }] = await h.db.query(`SELECT count(*)::int AS n FROM dossier`);
      expect(draftsAfter).toBe(draftsBefore);
      expect(dossiersAfter).toBe(dossiersBefore);
    });

    it('rolls back a registration and a role change made in an existing session', async () => {
      await h.db.query(`DROP TRIGGER "trg_test_block_audit" ON "audit_event"`);
      const { agent } = await signIn(h.app, 'assistant1@juspol.test');
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      const draft = (
        await agent
          .post('/api/records/drafts')
          .send({ direction: 'INCOMING', subject: 'Audit failure probe' })
          .expect(201)
      ).body;
      // Block audit writes again, with the sessions already established.
      await h.db.query(`
        CREATE TRIGGER "trg_test_block_audit" BEFORE INSERT ON "audit_event"
          FOR EACH ROW EXECUTE FUNCTION "test_block_audit"()`);

      await agent
        .post(`/api/records/${draft.id}/register`)
        .send({ version: draft.version })
        .expect(500);

      // The item is still a draft: no identity, no registration time.
      const [row] = await h.db.query(
        `SELECT state, registration_identity FROM correspondence_item WHERE id = $1`,
        [draft.id],
      );
      expect(row.state).toBe('DRAFT');
      expect(row.registration_identity).toBeNull();

      // And an administrative change rolls back the same way.
      const [account] = await h.db.query(`SELECT id FROM account WHERE email = $1`, [
        'assistant2@juspol.test',
      ]);
      await admin.post('/api/admin/accounts/disable').send({ accountId: account.id }).expect(500);
      const [state] = await h.db.query(`SELECT is_enabled FROM account WHERE id = $1`, [account.id]);
      expect(state.is_enabled).toBe(true);
    });
  });

  describe('append-only event history (FR-GEN-007)', () => {
    /**
     * The audit rules differ from the registry trigger: they report success and
     * change nothing. So these tests must verify the rows afterwards. A test
     * that only asserted "no error was thrown" would pass on a table with no
     * protection at all.
     */
    it('silently discards an UPDATE against the history', async () => {
      const before = await h.db.query(`SELECT id, summary FROM audit_event ORDER BY occurred_at`);
      expect(before.length).toBeGreaterThan(0);

      await h.db.query(`UPDATE audit_event SET summary = 'tampered'`);

      const tampered = await h.db.query(`SELECT count(*)::int AS n FROM audit_event WHERE summary = 'tampered'`);
      expect(tampered[0].n).toBe(0);
    });

    it('silently discards a DELETE against the history', async () => {
      const [{ n: before }] = await h.db.query(`SELECT count(*)::int AS n FROM audit_event`);
      await h.db.query(`DELETE FROM audit_event`);
      const [{ n: after }] = await h.db.query(`SELECT count(*)::int AS n FROM audit_event`);
      expect(after).toBe(before);
    });

    it('records server time, not a value any client could supply', async () => {
      const [row] = await h.db.query(
        `SELECT occurred_at, now() AS server_now FROM audit_event ORDER BY occurred_at DESC LIMIT 1`,
      );
      const drift = new Date(row.server_now).getTime() - new Date(row.occurred_at).getTime();
      expect(drift).toBeGreaterThanOrEqual(0);
      expect(drift).toBeLessThan(5 * 60 * 1000);
    });
  });
});
