import request from 'supertest';
import { codeForStep, currentStep } from '../src/security/totp';
import { Harness, SEED_PASSWORD, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/**
 * Phase 3 foundation: settings, classification and need-to-know, the view log,
 * two-step verification, lockout, sign-in history, the ministry structure, and
 * the hash chain over the audit history.
 */
describe('Phase 3 foundation', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  describe('settings', () => {
    it('lets the administrator change a setting, audited, and refuses anyone else', async () => {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      const before = (await admin.get('/api/settings').expect(200)).body;
      expect(before.branding.organisationName).toBe('Ministerie van Justitie en Politie');
      const changed = await admin
        .put('/api/settings/deadlines')
        .send({ value: { reminderDaysBefore: [3, 1] } })
        .expect(200);
      expect(changed.body.reminderDaysBefore).toEqual([3, 1]);
      // Other fields keep their defaults.
      expect(changed.body.escalateAfterWorkingDays).toBe(1);
      await expectAuditEvent(h.db, 'SETTING_CHANGED', 'deadlines');
      const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
      await minister.put('/api/settings/deadlines').send({ value: { reminderDaysBefore: [9] } }).expect(403);
    });

    it('validates values before storing them', async () => {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      await admin.put('/api/settings/branding').send({ value: { primaryColor: 'blue' } }).expect(400);
      await admin.put('/api/settings/numbering').send({ value: { taskPattern: 'NO-SEQ' } }).expect(400);
      await admin.put('/api/settings/classification').send({ value: { confidentialRoles: ['SYS_ADMIN'] } }).expect(400);
      await admin.put('/api/settings/nonsense').send({ value: {} }).expect(400);
    });

    it('refuses an AI address outside the network unless data leaving is confirmed', async () => {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      await admin
        .put('/api/settings/ai')
        .send({ value: { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1' } })
        .expect(400);
      await admin
        .put('/api/settings/ai')
        .send({ value: { provider: 'ollama', baseUrl: 'http://localhost:11434/v1' } })
        .expect(200);
      await admin.put('/api/settings/ai').send({ value: { provider: 'builtin' } }).expect(200);
    });

    it('serves branding to signed-out visitors but nothing else', async () => {
      const response = await request(h.app.getHttpServer()).get('/api/settings/public').expect(200);
      expect(response.body.branding.productName).toBe('JusPol EDRMS');
      expect(response.body.security).toBeUndefined();
      expect(response.body.ai).toBeUndefined();
    });
  });

  describe('classification and need-to-know', () => {
    async function dossierBy(email: string, subject: string, classification?: string) {
      const { agent } = await signIn(h.app, email);
      return (await agent.post('/api/dossiers').send({ subject, ...(classification ? { classification } : {}) }).expect(201)).body;
    }

    it('records the owning unit and defaults to Internal', async () => {
      const d = await dossierBy('assistant2@juspol.test', 'Unit check');
      expect(d.classification).toBe('INTERNAL');
      expect(d.owningUnit).toBe('Head Office — Directoraat');
    });

    it('hides a Confidential dossier from support staff outside the unit, and shows it to the unit', async () => {
      const d = await dossierBy('assistant2@juspol.test', 'Vertrouwelijk personeelsdossier', 'CONFIDENTIAL');
      // assistant1 is in the Kabinet, not the Directoraat.
      const { agent: outsider } = await signIn(h.app, 'assistant1@juspol.test');
      const list = (await outsider.get('/api/dossiers').expect(200)).body;
      expect(list.map((x: { id: string }) => x.id)).not.toContain(d.id);
      // A direct request is answered as if the dossier did not exist.
      await outsider.get(`/api/dossiers/${d.id}/timeline`).expect(404);
      await outsider.get(`/api/dossiers/${d.id}/dossier-state`).expect(404);
      // Same unit: visible.
      const { agent: colleague } = await signIn(h.app, 'unauthorised@juspol.test');
      const colleagueList = (await colleague.get('/api/dossiers').expect(200)).body;
      expect(colleagueList.map((x: { id: string }) => x.id)).toContain(d.id);
      // Cleared role: visible.
      const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
      await directeur.get(`/api/dossiers/${d.id}/timeline`).expect(200);
    });

    it('lets a decision-maker raise the classification with a reason, and refuses support staff', async () => {
      const d = await dossierBy('assistant1@juspol.test', 'Wordt geheim');
      const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
      await clerk.post(`/api/access/dossiers/${d.id}/classification`).send({ level: 'SECRET', reason: 'x' }).expect(403);
      const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
      await minister.post(`/api/access/dossiers/${d.id}/classification`).send({ level: 'SECRET' }).expect(400);
      await minister
        .post(`/api/access/dossiers/${d.id}/classification`)
        .send({ level: 'SECRET', reason: 'Staatsveiligheid' })
        .expect(200);
      await expectAuditEvent(h.db, 'CLASSIFICATION_CHANGED', 'Staatsveiligheid');
      const [change] = await h.db.query(`SELECT * FROM classification_change WHERE subject_id = $1`, [d.id]);
      expect(change.previous_level).toBe('INTERNAL');
      expect(change.new_level).toBe('SECRET');
      // The creator keeps access by relationship; the Directeur is not cleared for Secret.
      await clerk.get(`/api/dossiers/${d.id}/timeline`).expect(200);
      const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
      await directeur.get(`/api/dossiers/${d.id}/timeline`).expect(404);
    });

    it('grants and revokes need-to-know access, keeping the grant on record', async () => {
      const d = await dossierBy('minister@juspol.test', 'Geheim dossier', 'SECRET');
      const directeurId = await accountIdFor(h.db, 'directeur@juspol.test');
      const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
      const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
      await directeur.get(`/api/dossiers/${d.id}/timeline`).expect(404);
      await minister.post(`/api/access/dossiers/${d.id}/grants`).send({ accountId: directeurId, reason: 'Beleidsadvies' }).expect(201);
      await directeur.get(`/api/dossiers/${d.id}/timeline`).expect(200);
      const grants = (await minister.get(`/api/access/dossiers/${d.id}/grants`).expect(200)).body;
      expect(grants).toHaveLength(1);
      await minister.post(`/api/access/grants/${grants[0].id}/revoke`).expect(200);
      await directeur.get(`/api/dossiers/${d.id}/timeline`).expect(404);
      const [row] = await h.db.query(`SELECT revoked_at FROM record_access_grant WHERE id = $1`, [grants[0].id]);
      expect(row.revoked_at).not.toBeNull();
      await expectAuditEvent(h.db, 'ACCESS_REVOKED');
    });

    it('gives the system administrator no record content', async () => {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      await admin.get('/api/dossiers').expect(403);
      await admin.get('/api/records').expect(403);
    });

    it('refuses a Secret record from someone not cleared for it', async () => {
      const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
      await clerk.post('/api/dossiers').send({ subject: 'x', classification: 'SECRET' }).expect(400);
      await clerk.post('/api/records/drafts').send({ direction: 'INCOMING', subject: 'x', classification: 'SECRET' }).expect(400);
    });
  });

  describe('two-step verification', () => {
    it('sets up, signs in with a code, refuses a reused code, and accepts a recovery code once', async () => {
      const { agent } = await signIn(h.app, 'onderdirecteur@juspol.test');
      const setup = (await agent.post('/api/security/mfa/setup').expect(200)).body;
      expect(setup.otpauthUrl).toContain('otpauth://totp/');
      expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      await agent.post('/api/security/mfa/enable').send({ code: '000000' }).expect(400);
      const enableStep = currentStep();
      const enableCode = codeForStep(setup.secret, enableStep);
      const enabled = (await agent.post('/api/security/mfa/enable').send({ code: enableCode }).expect(200)).body;
      expect(enabled.recoveryCodes).toHaveLength(8);
      await expectAuditEvent(h.db, 'MFA_ENABLED');

      // Password alone no longer signs in.
      const server = h.app.getHttpServer();
      const two = request.agent(server);
      const first = await two.post('/api/auth/login').send({ email: 'onderdirecteur@juspol.test', password: SEED_PASSWORD }).expect(200);
      expect(first.body).toEqual({ mfaRequired: true });
      await two.get('/api/auth/me').expect(401);
      // The step used at enabling cannot be reused; the next one works.
      await two.post('/api/auth/mfa').send({ code: enableCode }).expect(401);
      const next = codeForStep(setup.secret, enableStep + 1);
      await two.post('/api/auth/mfa').send({ code: next }).expect(200);
      await two.get('/api/auth/me').expect(200);

      // A recovery code works once.
      const three = request.agent(server);
      await three.post('/api/auth/login').send({ email: 'onderdirecteur@juspol.test', password: SEED_PASSWORD }).expect(200);
      await three.post('/api/auth/mfa').send({ code: enabled.recoveryCodes[0] }).expect(200);
      const four = request.agent(server);
      await four.post('/api/auth/login').send({ email: 'onderdirecteur@juspol.test', password: SEED_PASSWORD }).expect(200);
      await four.post('/api/auth/mfa').send({ code: enabled.recoveryCodes[0] }).expect(401);
      await expectAuditEvent(h.db, 'MFA_FAILED');
    });

    it('stores the secret encrypted, never in clear', async () => {
      const id = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
      const [row] = await h.db.query(`SELECT secret_encrypted FROM account_mfa WHERE account_id = $1`, [id]);
      expect(row.secret_encrypted.split(':')).toHaveLength(3);
      expect(row.secret_encrypted).not.toMatch(/^[A-Z2-7]{32}$/);
    });

    it('confines a role that must use it to the set-up screens until it is on', async () => {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      await admin.put('/api/settings/security').send({ value: { mfaRequiredForRoles: ['MINISTER'] } }).expect(200);
      const minister = request.agent(h.app.getHttpServer());
      const login = await minister.post('/api/auth/login').send({ email: 'minister@juspol.test', password: SEED_PASSWORD }).expect(200);
      expect(login.body.mfaSetupRequired).toBe(true);
      await minister.get('/api/dossiers').expect(403);
      await minister.get('/api/security/mfa').expect(200);
      const setup = (await minister.post('/api/security/mfa/setup').expect(200)).body;
      await minister.post('/api/security/mfa/enable').send({ code: codeForStep(setup.secret, currentStep()) }).expect(200);
      await minister.get('/api/dossiers').expect(200);
      await admin.put('/api/settings/security').send({ value: { mfaRequiredForRoles: [] } }).expect(200);
      // Switch it off again so the Minister signs in normally in later specs.
      await minister.post('/api/security/mfa/disable').send({ code: codeForStep(setup.secret, currentStep() + 1) }).expect(200);
    });
  });

  describe('lockout and sign-in history', () => {
    it('locks an address after repeated failures with the same refusal, then alerts', async () => {
      const server = h.app.getHttpServer();
      const attempt = (password: string) =>
        request(server).post('/api/auth/login').set('User-Agent', 'lockout-test').send({ email: 'assistant2@juspol.test', password });
      const wrong = await attempt('wrong-1');
      expect(wrong.body.message).toBe('Invalid email or password.');
      expect(wrong.body.attemptsLeft).toBe(4);
      for (let i = 0; i < 4; i += 1) await attempt(`wrong-${i + 2}`).expect(401);
      // Locked: even the right password is refused, with the identical message;
      // the person is told until when, which says nothing about the account.
      const locked = await attempt(SEED_PASSWORD).expect(401);
      expect(locked.body.message).toEqual(wrong.body.message);
      expect(locked.body.locked).toBe(true);
      expect(new Date(locked.body.lockedUntil).getTime()).toBeGreaterThan(Date.now());
      const ghost = await request(server).post('/api/auth/login').send({ email: 'nobody-here@juspol.test', password: 'x' }).expect(401);
      expect(ghost.body.attemptsLeft).toBe(4);
      await expectAuditEvent(h.db, 'ACCOUNT_LOCKED', 'assistant2@juspol.test');
      const id = await accountIdFor(h.db, 'assistant2@juspol.test');
      const alerts = await h.db.query(`SELECT * FROM notification WHERE account_id = $1 AND kind = 'SECURITY_ALERT'`, [id]);
      expect(alerts.length).toBeGreaterThan(0);
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      const report = (await admin.get('/api/security/alerts').expect(200)).body;
      expect(report.locks.length).toBeGreaterThan(0);
      expect(report.failures.find((f: { email: string }) => f.email === 'assistant2@juspol.test').failures).toBeGreaterThanOrEqual(5);
      // Unlock for the rest of the suite by clearing the window.
      await h.db.query(`TRUNCATE login_attempt`);
    });

    it('shows a person their own sign-in history with address and browser', async () => {
      const server = h.app.getHttpServer();
      const agent = request.agent(server);
      await agent.post('/api/auth/login').set('User-Agent', 'Mozilla/5.0 History').send({ email: 'assistant1@juspol.test', password: SEED_PASSWORD }).expect(200);
      const history = (await agent.get('/api/security/login-history').expect(200)).body;
      expect(history[0].succeeded).toBe(true);
      expect(history[0].userAgent).toBe('Mozilla/5.0 History');
    });

    it('changes a password only with the current one and a strong new one', async () => {
      const { agent } = await signIn(h.app, 'dualrole@juspol.test');
      await agent.post('/api/security/password').send({ currentPassword: 'nope', newPassword: 'Sterk-Wachtwoord-2026' }).expect(400);
      await agent.post('/api/security/password').send({ currentPassword: SEED_PASSWORD, newPassword: 'weakweakweak' }).expect(400);
      await agent.post('/api/security/password').send({ currentPassword: SEED_PASSWORD, newPassword: 'Sterk-Wachtwoord-2026' }).expect(200);
      await expectAuditEvent(h.db, 'PASSWORD_CHANGED');
      await request(h.app.getHttpServer()).post('/api/auth/login').send({ email: 'dualrole@juspol.test', password: 'Sterk-Wachtwoord-2026' }).expect(200);
    });
  });

  describe('ministry structure', () => {
    it('builds a hierarchy with heads and finds a person’s supervisor', async () => {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      const units = (await admin.get('/api/org/units').expect(200)).body;
      const dir = units.find((u: { code: string }) => u.code === 'HO-DIR');
      const kab = units.find((u: { code: string }) => u.code === 'HO-KAB');
      const legal = (await admin.post('/api/org/units').send({ code: 'JZ', name: 'Juridische Zaken', kind: 'DEPARTMENT', parentUnitId: dir.id }).expect(201)).body;
      await admin.post('/api/org/units').send({ code: 'JZ', name: 'Dubbel' }).expect(409);
      // A loop is refused.
      await admin.put(`/api/org/units/${dir.id}`).send({ parentUnitId: legal.id }).expect(400);
      const directeur = await accountIdFor(h.db, 'directeur@juspol.test');
      const minister = await accountIdFor(h.db, 'minister@juspol.test');
      await admin.put(`/api/org/units/${dir.id}`).send({ headAccountId: directeur, parentUnitId: kab.id }).expect(200);
      await admin.put(`/api/org/units/${kab.id}`).send({ headAccountId: minister }).expect(200);
      await expectAuditEvent(h.db, 'UNIT_UPDATED');

      const created = (
        await admin
          .post('/api/admin/accounts')
          .send({ fullName: 'T. Jurist', email: 'jurist@juspol.test', unitId: legal.id, roles: ['SUPPORT_STAFF'], initialPassword: 'Jurist-Start-2026' })
          .expect(201)
      ).body;
      await expectAuditEvent(h.db, 'ACCOUNT_CREATED', 'jurist@juspol.test');
      const org = h.app.get(require('../src/org/org.service').OrgService);
      // The jurist's unit has no head: the escalation goes up to the Directeur.
      expect(await org.supervisorOf(created.accountId)).toBe(directeur);
      // The Directeur heads his own unit: his supervisor is the head above.
      expect(await org.supervisorOf(directeur)).toBe(minister);
      const people = (await admin.get('/api/org/people?q=jurist').expect(200)).body;
      expect(people[0].unit).toBe('Juridische Zaken');
      await admin.post(`/api/admin/accounts/${created.accountId}/reset-password`).send({ newPassword: 'short' }).expect(400);
      await admin.post(`/api/admin/accounts/${created.accountId}/reset-password`).send({ newPassword: 'Nieuw-Wachtwoord-99' }).expect(200);
      await expectAuditEvent(h.db, 'PASSWORD_RESET');
    });
  });

  describe('audit hash chain', () => {
    it('chains every event to the one before it', async () => {
      const broken = await h.db.query(`
        WITH c AS (SELECT seq, chain_hash, audit_event_payload(a) AS p,
                          lag(chain_hash) OVER (ORDER BY seq) AS prev FROM audit_event a)
        SELECT seq FROM c
         WHERE chain_hash IS DISTINCT FROM encode(sha256(convert_to(coalesce(prev, '') || '#' || p, 'UTF8')), 'hex')`);
      expect(broken).toEqual([]);
      const [{ count }] = await h.db.query(`SELECT count(*)::int AS count FROM audit_event`);
      expect(count).toBeGreaterThan(10);
    });

    it('detects an event removed from the middle of the history', async () => {
      // Simulate someone with the power to bypass the append-only rule.
      await h.db.query(`ALTER TABLE audit_event DISABLE RULE audit_event_no_delete`);
      await h.db.query(`DROP RULE audit_event_no_delete ON audit_event`);
      const [victim] = await h.db.query(`SELECT id, seq FROM audit_event ORDER BY seq OFFSET 3 LIMIT 1`);
      await h.db.query(`DELETE FROM audit_event WHERE id = $1`, [victim.id]);
      const broken = await h.db.query(`
        WITH c AS (SELECT seq, chain_hash, audit_event_payload(a) AS p,
                          lag(chain_hash) OVER (ORDER BY seq) AS prev FROM audit_event a)
        SELECT seq FROM c
         WHERE chain_hash IS DISTINCT FROM encode(sha256(convert_to(coalesce(prev, '') || '#' || p, 'UTF8')), 'hex')`);
      expect(broken.length).toBe(1);
      await h.db.query(`CREATE RULE "audit_event_no_delete" AS ON DELETE TO "audit_event" DO INSTEAD NOTHING`);
    });
  });
});
