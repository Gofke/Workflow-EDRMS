import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/** Dossiers, and the rules governing what may be linked into one. */
describe('Dossiers', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  /** Registers an item and returns it, since only registered records may be linked. */
  async function registeredItem(agent: ReturnType<typeof Object>, subject: string) {
    const a = agent as never as { post: (u: string) => { send: (b: unknown) => Promise<{ body: Record<string, unknown> }> } };
    const created = await a.post('/api/records/drafts').send({ direction: 'INCOMING', subject });
    const registered = await a
      .post(`/api/records/${created.body.id}/register`)
      .send({ version: created.body.version });
    return registered.body;
  }

  it('creates a dossier with a server-assigned identity and an OPEN state', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const response = await agent.post('/api/dossiers').send({ subject: 'Synthetic Matter 011' }).expect(201);

    expect(response.body.dossierIdentity).toBeTruthy();
    expect(response.body.state).toBe('OPEN');
    expect(response.body.linkedItems).toEqual([]);
    await expectAuditEvent(h.db, 'DOSSIER_CREATED', 'Synthetic Matter 011');
  });

  it('requires a subject', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    await agent.post('/api/dossiers').send({ subject: '' }).expect(400);
  });

  it('rejects a client-supplied dossier identity', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const response = await agent
      .post('/api/dossiers')
      .send({ subject: 'Forged', dossierIdentity: 'DOS-2020-0001' })
      .expect(400);
    expect(JSON.stringify(response.body)).toContain('dossierIdentity');
  });

  it('gives every dossier a distinct identity', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const identities: string[] = [];
    for (const subject of ['Matter A', 'Matter B', 'Matter C']) {
      const created = await agent.post('/api/dossiers').send({ subject }).expect(201);
      identities.push(created.body.dossierIdentity);
    }
    expect(new Set(identities).size).toBe(3);
  });

  it('links a registered record and records the link in the trail', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = await agent.post('/api/dossiers').send({ subject: 'Linking matter' }).expect(201);
    const item = await registeredItem(agent, 'Item to link');

    const linked = await agent
      .post(`/api/dossiers/${dossier.body.id}/links`)
      .send({ itemId: item.id })
      .expect(200);

    expect(linked.body.linkedItems).toHaveLength(1);
    expect(linked.body.linkedItems[0].registrationIdentity).toBe(item.registrationIdentity);
    await expectAuditEvent(h.db, 'RECORD_LINKED', String(item.registrationIdentity));
  });

  /**
   * The rule that keeps a matter file trustworthy: preparatory material must
   * not sit in a dossier looking like evidence of that matter.
   */
  it('refuses to link a draft', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = await agent.post('/api/dossiers').send({ subject: 'Draft rejection' }).expect(201);
    const draft = await agent
      .post('/api/records/drafts')
      .send({ direction: 'INCOMING', subject: 'Still a draft' })
      .expect(201);

    const response = await agent
      .post(`/api/dossiers/${dossier.body.id}/links`)
      .send({ itemId: draft.body.id })
      .expect(400);
    expect(response.body.message).toContain('registered');
  });

  it('refuses the same link twice', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = await agent.post('/api/dossiers').send({ subject: 'Double link' }).expect(201);
    const item = await registeredItem(agent, 'Linked once');

    await agent.post(`/api/dossiers/${dossier.body.id}/links`).send({ itemId: item.id }).expect(200);
    await agent.post(`/api/dossiers/${dossier.body.id}/links`).send({ itemId: item.id }).expect(400);
  });

  /** BR-004: a link, not a copy. The same record may serve several matters. */
  it('links one record into two dossiers without duplicating it', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const first = await agent.post('/api/dossiers').send({ subject: 'Matter one' }).expect(201);
    const second = await agent.post('/api/dossiers').send({ subject: 'Matter two' }).expect(201);
    const item = await registeredItem(agent, 'Shared record');

    await agent.post(`/api/dossiers/${first.body.id}/links`).send({ itemId: item.id }).expect(200);
    await agent.post(`/api/dossiers/${second.body.id}/links`).send({ itemId: item.id }).expect(200);

    // One row in the registry, two links to it.
    const [{ n }] = await h.db.query(
      `SELECT count(*)::int AS n FROM correspondence_item WHERE registration_identity = $1`,
      [item.registrationIdentity],
    );
    expect(n).toBe(1);
    const [{ links }] = await h.db.query(
      `SELECT count(*)::int AS links FROM dossier_link WHERE correspondence_item_id = $1`,
      [item.id],
    );
    expect(links).toBe(2);
  });

  it('refuses an unknown dossier or record', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const missing = '00000000-0000-4000-8000-000000000000';
    const dossier = await agent.post('/api/dossiers').send({ subject: 'Not found checks' }).expect(201);

    await agent.post(`/api/dossiers/${missing}/links`).send({ itemId: missing }).expect(404);
    await agent.post(`/api/dossiers/${dossier.body.id}/links`).send({ itemId: missing }).expect(404);
  });

  it('keeps dossiers closed to the system administrator (FR-SEC-010)', async () => {
    const { agent } = await signIn(h.app, 'sysadmin@juspol.test');
    await agent.get('/api/dossiers').expect(403);
    await agent.post('/api/dossiers').send({ subject: 'Admin attempt' }).expect(403);
  });

  it('refuses dossiers without a session', async () => {
    await require('supertest')(h.app.getHttpServer()).get('/api/dossiers').expect(401);
  });

  it('offers no route that removes a link (DEC-10 is open)', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = await agent.post('/api/dossiers').send({ subject: 'Unlink probe' }).expect(201);
    const item = await registeredItem(agent, 'Cannot be unlinked');
    await agent.post(`/api/dossiers/${dossier.body.id}/links`).send({ itemId: item.id }).expect(200);

    // Unlinking is not a Delivery 1 capability. If DEC-10 later enables it,
    // this test should be replaced rather than deleted quietly.
    await agent.delete(`/api/dossiers/${dossier.body.id}/links/${item.id}`).expect(404);
  });

  describe('identity protection in the database', () => {
    it('rejects a change to a dossier identity', async () => {
      const { agent } = await signIn(h.app, 'assistant1@juspol.test');
      const dossier = await agent.post('/api/dossiers').send({ subject: 'Immutable' }).expect(201);

      await expect(
        h.db.query(`UPDATE dossier SET dossier_identity = $1 WHERE id = $2`, [
          'DOS-2020-9999',
          dossier.body.id,
        ]),
      ).rejects.toThrow(/cannot be changed once assigned/);
    });

    it('rejects two dossiers sharing one identity', async () => {
      const { agent } = await signIn(h.app, 'assistant1@juspol.test');
      const dossier = await agent.post('/api/dossiers').send({ subject: 'Unique' }).expect(201);

      await expect(
        h.db.query(
          `INSERT INTO dossier (dossier_identity, subject, created_by_account_id)
           SELECT $1, 'Duplicate', created_by_account_id FROM dossier WHERE id = $2`,
          [dossier.body.dossierIdentity, dossier.body.id],
        ),
      ).rejects.toThrow(/duplicate key value/);
    });

    it('rejects a duplicate link at the database level, not only in the application', async () => {
      const { agent } = await signIn(h.app, 'assistant1@juspol.test');
      const dossier = await agent.post('/api/dossiers').send({ subject: 'Constraint check' }).expect(201);
      const item = await registeredItem(agent, 'Linked for constraint');
      await agent.post(`/api/dossiers/${dossier.body.id}/links`).send({ itemId: item.id }).expect(200);

      // The API refuses this too, but that check lives in application code and
      // could be removed. This asserts the constraint underneath it.
      await expect(
        h.db.query(
          `INSERT INTO dossier_link (dossier_id, correspondence_item_id, linked_by_account_id)
           SELECT dossier_id, correspondence_item_id, linked_by_account_id
             FROM dossier_link WHERE dossier_id = $1 AND correspondence_item_id = $2`,
          [dossier.body.id, item.id],
        ),
      ).rejects.toThrow(/uq_dossier_link|duplicate key value/);
    });

    // V0.1.13: CLOSED became a real state (FR-DOS-006), so the probe is now a
    // value the pilot genuinely does not know. Inserted rather than updated, so
    // the check constraint is what answers, not the V0.1.13 transition trigger.
    it('rejects a state the pilot does not recognise', async () => {
      const creator = await accountIdFor(h.db, 'assistant1@juspol.test');
      await expect(
        h.db.query(
          `INSERT INTO dossier (dossier_identity, subject, state, created_by_account_id)
           VALUES ('DOS-PROBE-1', 'State check', 'ARCHIVED', $1)`,
          [creator],
        ),
      ).rejects.toThrow(/ck_dossier_state/);
    });
  });
});
