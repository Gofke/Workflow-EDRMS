import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/** Role administration, its authorisation boundary, and its audit trail. */
describe('Administration', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('lets an administrator list accounts', async () => {
    const { agent } = await signIn(h.app, 'sysadmin@juspol.test');
    const response = await agent.get('/api/admin/accounts').expect(200);
    expect(response.body).toHaveLength(9);
  });

  it.each([
    ['directeur@juspol.test'],
    ['minister@juspol.test'],
    ['onderdirecteur@juspol.test'],
    ['assistant1@juspol.test'],
  ])('refuses %s access to administration — seniority is not administrative authority', async (email) => {
    const { agent } = await signIn(h.app, email);
    await agent.get('/api/admin/accounts').expect(403);
    await agent.get('/api/admin/audit').expect(403);
  });

  it('refuses administration without any session', async () => {
    const { app } = h;
    await require('supertest')(app.getHttpServer()).get('/api/admin/accounts').expect(401);
  });

  it('will not let a non-administrator grant themselves the administrator role', async () => {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const accountId = await accountIdFor(h.db, 'directeur@juspol.test');
    await agent.post('/api/admin/roles/assign').send({ accountId, roleCode: 'SYS_ADMIN' }).expect(403);
  });

  it('assigns a role, reflects it in the holder\u2019s own session, and audits it', async () => {
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    const { agent: holder } = await signIn(h.app, 'directeur@juspol.test');
    const accountId = await accountIdFor(h.db, 'directeur@juspol.test');

    await admin
      .post('/api/admin/roles/assign')
      .send({ accountId, roleCode: 'ONDER_DIRECTEUR' })
      .expect(200);

    const me = await holder.get('/api/auth/me').expect(200);
    expect(me.body.roles.map((r: { code: string }) => r.code).sort()).toEqual([
      'DIRECTEUR',
      'ONDER_DIRECTEUR',
    ]);
    const event = await expectAuditEvent(h.db, 'ROLE_ASSIGNED', 'M. Sardjoe');
    expect(event.actor_description).toContain('V. Ramlal');
  });

  it('revokes a role without deleting its history', async () => {
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    const accountId = await accountIdFor(h.db, 'directeur@juspol.test');

    await admin
      .post('/api/admin/roles/revoke')
      .send({ accountId, roleCode: 'ONDER_DIRECTEUR' })
      .expect(200);

    // The assignment row survives, marked revoked. Deleting it would erase the
    // evidence that the authority was ever held.
    const [assignment] = await h.db.query(
      `SELECT ra.revoked_at FROM role_assignment ra
         JOIN functional_role r ON r.id = ra.functional_role_id
        WHERE ra.account_id = $1 AND r.code = 'ONDER_DIRECTEUR'`,
      [accountId],
    );
    expect(assignment.revoked_at).not.toBeNull();
    await expectAuditEvent(h.db, 'ROLE_REVOKED', 'M. Sardjoe');
  });

  it('refuses to leave the pilot with no active administrator', async () => {
    const { agent } = await signIn(h.app, 'sysadmin@juspol.test');
    const accountId = await accountIdFor(h.db, 'sysadmin@juspol.test');

    const revoke = await agent
      .post('/api/admin/roles/revoke')
      .send({ accountId, roleCode: 'SYS_ADMIN' })
      .expect(400);
    expect(revoke.body.message).toContain('no active administrator');

    const disable = await agent.post('/api/admin/accounts/disable').send({ accountId }).expect(400);
    expect(disable.body.message).toContain('no active administrator');
  });

  it('allows the change once a second administrator exists', async () => {
    const { agent } = await signIn(h.app, 'sysadmin@juspol.test');
    const second = await accountIdFor(h.db, 'assistant2@juspol.test');
    const first = await accountIdFor(h.db, 'sysadmin@juspol.test');

    await agent.post('/api/admin/roles/assign').send({ accountId: second, roleCode: 'SYS_ADMIN' }).expect(200);
    await agent.post('/api/admin/roles/revoke').send({ accountId: first, roleCode: 'SYS_ADMIN' }).expect(200);

    // Restore the starting state for any spec that follows.
    const { agent: newAdmin } = await signIn(h.app, 'assistant2@juspol.test');
    await newAdmin.post('/api/admin/roles/assign').send({ accountId: first, roleCode: 'SYS_ADMIN' }).expect(200);
    await newAdmin.post('/api/admin/roles/revoke').send({ accountId: second, roleCode: 'SYS_ADMIN' }).expect(200);
  });
});
