import request from 'supertest';
import { sessionCookieSecure } from '../src/config/environment-guard';
import { Harness, SEED_PASSWORD, startHarness } from './harness';

/**
 * V0.4.1 — the session cookie on a deployed server. Production only issues it
 * over HTTPS; staging follows the connection, so a staging site still works
 * while its certificate cannot be obtained.
 */
describe('V0.4.1 session cookie per environment', () => {
  it.each([
    ['development', 'development', false],
    ['test', 'test', false],
    ['production', 'staging', 'auto'],
    ['production', 'production', true],
    ['production', '', true],
  ])('NODE_ENV=%s APP_ENV=%s → %s', (nodeEnv, appEnv, expected) => {
    expect(sessionCookieSecure({ NODE_ENV: nodeEnv, APP_ENV: appEnv })).toBe(expected);
  });

  describe.each([
    ['staging', { http: 'plain', https: 'secure' }],
    ['production', { http: 'none', https: 'secure' }],
  ])('a server with APP_ENV=%s behind nginx', (appEnv, expected) => {
    let h: Harness;
    const keys = ['NODE_ENV', 'APP_ENV', 'TRUST_PROXY', 'SCHEDULER_ENABLED', 'INTEGRITY_SCHEDULE'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

    beforeAll(async () => {
      // Production mode, without the background timers (they are not under test).
      Object.assign(process.env, { NODE_ENV: 'production', APP_ENV: appEnv, TRUST_PROXY: '1', SCHEDULER_ENABLED: 'false', INTEGRITY_SCHEDULE: 'off' });
      h = await startHarness();
    });
    afterAll(async () => {
      await h.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const cookieKind = (res: request.Response): 'none' | 'plain' | 'secure' => {
      const cookie = ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith('juspol.sid='));
      if (!cookie) return 'none';
      return /;\s*Secure/i.test(cookie) ? 'secure' : 'plain';
    };
    const login = (proto: 'http' | 'https') =>
      request(h.app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-Proto', proto)
        .send({ email: 'assistant1@juspol.test', password: SEED_PASSWORD });

    it(`over http: ${expected.http}`, async () => {
      const res = await login('http');
      expect(res.status).toBe(200);
      expect(cookieKind(res)).toBe(expected.http);
    });

    it(`over https: ${expected.https}`, async () => {
      const res = await login('https');
      expect(res.status).toBe(200);
      expect(cookieKind(res)).toBe(expected.https);
    });
  });
});
