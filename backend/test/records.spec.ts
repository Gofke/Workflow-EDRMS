import { Harness, expectAuditEvent, signIn, startHarness } from './harness';

/** Registration behaviour: draft versus official record, and who may register. */
describe('Registration', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const draft = (subject: string, extra: Record<string, unknown> = {}) => ({
    direction: 'INCOMING',
    subject,
    ...extra,
  });

  it('creates a draft with no reference and no registration time', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const response = await agent.post('/api/records/drafts').send(draft('Draft one')).expect(201);

    expect(response.body.state).toBe('DRAFT');
    expect(response.body.registrationIdentity).toBeNull();
    expect(response.body.registeredAt).toBeNull();
    await expectAuditEvent(h.db, 'DRAFT_CREATED', 'Draft one');
  });

  it('enforces the configured mandatory set', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject: '' }).expect(400);
  });

  it('rejects a client-supplied reference or registration time outright', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const response = await agent
      .post('/api/records/drafts')
      .send(draft('Forged', {
        registrationIdentity: 'IN-2020-00001',
        registeredAt: '2020-01-01T00:00:00Z',
      }))
      .expect(400);

    const message = JSON.stringify(response.body);
    expect(message).toContain('registrationIdentity');
    expect(message).toContain('registeredAt');
  });

  it('assigns an identity and a server timestamp at registration, keeping the document date separate', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const created = await agent
      .post('/api/records/drafts')
      .send(draft('Registered item', { documentDate: '2026-09-03' }))
      .expect(201);

    const before = new Date();
    const registered = await agent
      .post(`/api/records/${created.body.id}/register`)
      .send({ version: created.body.version })
      .expect(200);
    const after = new Date();

    expect(registered.body.state).toBe('REGISTERED');
    expect(registered.body.registrationIdentity).toBeTruthy();
    // The document date is what the paper says; the registration time is the
    // server's. They must not be the same value (BR-002).
    expect(registered.body.documentDate).toBe('2026-09-03');
    const registeredAt = new Date(registered.body.registeredAt);
    expect(registeredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2000);
    expect(registeredAt.getTime()).toBeLessThanOrEqual(after.getTime() + 2000);

    const event = await expectAuditEvent(h.db, 'ITEM_REGISTERED', 'Registered item');
    expect(String(event.subject_description)).toContain(registered.body.registrationIdentity);
  });

  it('gives every registered item a distinct identity', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const identities: string[] = [];
    for (const subject of ['Unique A', 'Unique B', 'Unique C']) {
      const created = await agent.post('/api/records/drafts').send(draft(subject)).expect(201);
      const registered = await agent
        .post(`/api/records/${created.body.id}/register`)
        .send({ version: created.body.version })
        .expect(200);
      identities.push(registered.body.registrationIdentity);
    }
    expect(new Set(identities).size).toBe(3);
  });

  it('refuses to register the same item twice, and refuses to edit it afterwards', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const created = await agent.post('/api/records/drafts').send(draft('Once only')).expect(201);
    const registered = await agent
      .post(`/api/records/${created.body.id}/register`)
      .send({ version: created.body.version })
      .expect(200);

    await agent
      .post(`/api/records/${created.body.id}/register`)
      .send({ version: registered.body.version })
      .expect(400);

    await agent
      .put(`/api/records/drafts/${created.body.id}`)
      .send(draft('Changed after registration', { version: registered.body.version }))
      .expect(400);
  });

  /**
   * DEC-05, the decision that blocked seven test cases. Two sessions read the
   * same version; the second write must be refused, not applied.
   */
  it('refuses a stale write rather than silently overwriting (DEC-05)', async () => {
    const { agent: first } = await signIn(h.app, 'assistant1@juspol.test');
    const { agent: second } = await signIn(h.app, 'dualrole@juspol.test');
    const created = await first.post('/api/records/drafts').send(draft('Contended')).expect(201);
    const version = created.body.version;

    await first
      .put(`/api/records/drafts/${created.body.id}`)
      .send(draft('Edited by the first writer', { version }))
      .expect(200);

    const conflict = await second
      .put(`/api/records/drafts/${created.body.id}`)
      .send(draft('Edited by the second writer', { version }))
      .expect(409);
    expect(conflict.body.message).toContain('changed this item');

    const list = await first.get('/api/records').expect(200);
    const survivor = list.body.find((i: { id: string }) => i.id === created.body.id);
    expect(survivor.subject).toBe('Edited by the first writer');
  });

  it('refuses registration with a stale version', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const created = await agent.post('/api/records/drafts').send(draft('Stale register')).expect(201);
    await agent
      .put(`/api/records/drafts/${created.body.id}`)
      .send(draft('Stale register edited', { version: created.body.version }))
      .expect(200);

    await agent
      .post(`/api/records/${created.body.id}/register`)
      .send({ version: created.body.version })
      .expect(409);
  });

  it('keeps the registry closed to the system administrator (FR-SEC-010)', async () => {
    const { agent } = await signIn(h.app, 'sysadmin@juspol.test');
    await agent.get('/api/records').expect(403);
    await agent.post('/api/records/drafts').send(draft('Admin attempt')).expect(403);
  });

  it('refuses the registry without a session', async () => {
    await require('supertest')(h.app.getHttpServer()).get('/api/records').expect(401);
  });
});
