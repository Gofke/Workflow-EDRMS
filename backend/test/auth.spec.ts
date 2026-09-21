import request from 'supertest';
import { Harness, SEED_PASSWORD, expectAuditEvent, signIn, startHarness } from './harness';

/**
 * Authentication boundary and account-enumeration resistance.
 *
 * The enumeration tests are the reason this file exists. Three different causes
 * of refusal must be indistinguishable to the caller, and it would be very easy
 * for a later change — a friendlier error message, a short-circuit for unknown
 * emails — to break that without anyone noticing.
 */
describe('Authentication', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const post = (body: Record<string, unknown>) =>
    request(h.app.getHttpServer()).post('/api/auth/login').send(body);

  it('refuses a protected route without a session', async () => {
    await request(h.app.getHttpServer()).get('/api/auth/me').expect(401);
  });

  it('signs in a valid account and returns its identity and roles', async () => {
    const { identity } = await signIn(h.app, 'directeur@juspol.test');
    expect(identity.personName).toBe('M. Sardjoe');
    expect(identity.roles.map((r: { code: string }) => r.code)).toEqual(['DIRECTEUR']);
  });

  it('returns an account holding two roles with both of them', async () => {
    const { identity } = await signIn(h.app, 'dualrole@juspol.test');
    expect(identity.roles.map((r: { code: string }) => r.code).sort()).toEqual([
      'ONDER_DIRECTEUR',
      'SUPPORT_STAFF',
    ]);
  });

  it('gives a byte-identical refusal for wrong password, unknown email and disabled account', async () => {
    const wrongPassword = await post({ email: 'directeur@juspol.test', password: 'wrong' });
    const unknownEmail = await post({ email: 'ghost@juspol.test', password: SEED_PASSWORD });
    const disabled = await post({ email: 'disabled@juspol.test', password: SEED_PASSWORD });

    for (const response of [wrongPassword, unknownEmail, disabled]) {
      expect(response.status).toBe(401);
    }
    // Identical bodies. A difference of any kind reveals which addresses exist.
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(disabled.body).toEqual(wrongPassword.body);
  });

  it('records the real reason for each refusal in the audit trail', async () => {
    await post({ email: 'directeur@juspol.test', password: 'wrong' });
    await post({ email: 'ghost@juspol.test', password: SEED_PASSWORD });
    await post({ email: 'disabled@juspol.test', password: SEED_PASSWORD });

    const reasons = await h.db.query(
      `SELECT DISTINCT new_value FROM audit_event WHERE event_type = 'SIGN_IN_FAILED'`,
    );
    expect(reasons.map((r: { new_value: string }) => r.new_value).sort()).toEqual([
      'account disabled',
      'incorrect password',
      'no such account',
    ]);
  });

  it('sets an HttpOnly session cookie', async () => {
    const response = await post({ email: 'minister@juspol.test', password: SEED_PASSWORD });
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toContain('juspol.sid');
    expect(cookie).toContain('HttpOnly');
  });

  it('rejects an undeclared field rather than ignoring it', async () => {
    const response = await post({
      email: 'directeur@juspol.test',
      password: SEED_PASSWORD,
      isAdmin: true,
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('isAdmin');
  });

  it('invalidates the session on sign-out and records the event', async () => {
    const { agent } = await signIn(h.app, 'minister@juspol.test');
    await agent.get('/api/auth/me').expect(200);
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
    await expectAuditEvent(h.db, 'SIGN_OUT', 'R. Dijkstra');
  });

  it('ends a live session as soon as the account is disabled', async () => {
    const { agent } = await signIn(h.app, 'assistant2@juspol.test');
    await agent.get('/api/auth/me').expect(200);
    await h.db.query(`UPDATE account SET is_enabled = false WHERE email = $1`, [
      'assistant2@juspol.test',
    ]);
    await agent.get('/api/auth/me').expect(401);
    await h.db.query(`UPDATE account SET is_enabled = true WHERE email = $1`, [
      'assistant2@juspol.test',
    ]);
  });
});
