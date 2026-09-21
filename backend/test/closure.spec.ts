import { accountIdFor, expectAuditEvent, Harness, signIn, startHarness } from './harness';

/**
 * Dossier closure and reopening (FR-DOS-006, 007, 008; FR-FIN-004; UC-15).
 *
 * Three properties carry the weight. Closure needs a finalised result behind
 * it. A closed file refuses ordinary change through every route, including
 * direct SQL. And reopening is a new, reasoned event that leaves the closure it
 * follows exactly where it was.
 */
describe('Dossier closure', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function version(dossierId: string): Promise<number> {
    const [row] = await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [dossierId]);
    return row.version;
  }

  async function stateOf(dossierId: string): Promise<{ state: string; processing_state: string }> {
    const [row] = await h.db.query(
      `SELECT state, processing_state FROM dossier WHERE id = $1`,
      [dossierId],
    );
    return row;
  }

  /** A matter taken through review to a finalised result. */
  async function finalisedMatter() {
    const { agent: assistant } = await signIn(h.app, 'assistant1@juspol.test');
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const dossier = (
      await assistant.post('/api/dossiers').send({ subject: `Closure ${Date.now()}` }).expect(201)
    ).body;
    await assistant
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({
        reviewerAccountId: await accountIdFor(h.db, 'directeur@juspol.test'),
        version: await version(dossier.id),
      })
      .expect(200);
    await directeur
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await version(dossier.id) })
      .expect(200);
    await directeur
      .post(`/api/dossiers/${dossier.id}/finalise`)
      .send({ version: await version(dossier.id) })
      .expect(200);
    return { assistant, directeur, dossier };
  }

  async function closedMatter() {
    const parts = await finalisedMatter();
    await parts.directeur
      .post(`/api/dossiers/${parts.dossier.id}/dossier-state/close`)
      .send({ reason: 'Afgehandeld', version: await version(parts.dossier.id) })
      .expect(200);
    return parts;
  }

  it('starts every dossier Open', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (await agent.post('/api/dossiers').send({ subject: 'New' }).expect(201)).body;
    expect(dossier.state).toBe('OPEN');
  });

  it('refuses to close a matter that is not finalised', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const dossier = (await directeur.post('/api/dossiers').send({ subject: 'Unfinished' }).expect(201)).body;
    const response = await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/close`)
      .send({ version: dossier.version })
      .expect(400);
    expect(response.body.message).toContain('finalised');
    expect((await stateOf(dossier.id)).state).toBe('OPEN');
  });

  it('closes a finalised matter and records who, when and why', async () => {
    const { directeur, dossier } = await finalisedMatter();
    const result = (
      await directeur
        .post(`/api/dossiers/${dossier.id}/dossier-state/close`)
        .send({ reason: 'Afgehandeld', version: await version(dossier.id) })
        .expect(200)
    ).body;
    expect(result.state).toBe('CLOSED');
    expect(result.processingState).toBe('FINALISED');

    const history = (await directeur.get(`/api/dossiers/${dossier.id}/dossier-state`).expect(200)).body;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromState: 'OPEN',
      toState: 'CLOSED',
      actorName: 'M. Sardjoe',
      reason: 'Afgehandeld',
    });
    await expectAuditEvent(h.db, 'DOSSIER_CLOSED', dossier.dossierIdentity);
  });

  it('allows a closure without a reason', async () => {
    const { directeur, dossier } = await finalisedMatter();
    await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/close`)
      .send({ version: await version(dossier.id) })
      .expect(200);
    expect((await stateOf(dossier.id)).state).toBe('CLOSED');
  });

  it('keeps closure away from support staff and the administrator', async () => {
    const { assistant, dossier } = await finalisedMatter();
    await assistant
      .post(`/api/dossiers/${dossier.id}/dossier-state/close`)
      .send({ version: await version(dossier.id) })
      .expect(403);
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    await admin
      .post(`/api/dossiers/${dossier.id}/dossier-state/close`)
      .send({ version: await version(dossier.id) })
      .expect(403);
    expect((await stateOf(dossier.id)).state).toBe('OPEN');
  });

  it('refuses a closure made against a stale version', async () => {
    const { directeur, dossier } = await finalisedMatter();
    await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/close`)
      .send({ version: (await version(dossier.id)) - 1 })
      .expect(409);
    expect((await stateOf(dossier.id)).state).toBe('OPEN');
  });

  it('keeps a closed dossier readable', async () => {
    const { assistant, dossier } = await closedMatter();
    const list = (await assistant.get('/api/dossiers').expect(200)).body;
    expect(list.find((d: { id: string }) => d.id === dossier.id).state).toBe('CLOSED');
    await assistant.get(`/api/dossiers/${dossier.id}/timeline`).expect(200);
    await assistant.get(`/api/dossiers/${dossier.id}/workflow`).expect(200);
    await assistant.get(`/api/dossiers/${dossier.id}/history`).expect(200);
  });

  it('refuses every ordinary change to a closed dossier', async () => {
    const { assistant, directeur, dossier } = await closedMatter();
    const v = await version(dossier.id);

    const draft = (
      await assistant
        .post('/api/records/drafts')
        .send({ direction: 'INCOMING', subject: 'Late letter', party: 'PARTY-SYN-A' })
        .expect(201)
    ).body;
    const record = (
      await assistant.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)
    ).body;

    const onderdirecteur = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    const refusals = [
      () => assistant.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: record.id }),
      () =>
        directeur
          .post(`/api/dossiers/${dossier.id}/responsibility`)
          .send({ responsibleAccountId: onderdirecteur, version: v }),
      () => directeur.post(`/api/dossiers/${dossier.id}/due-date`).send({ dueDate: '2026-12-01', version: v }),
      () => directeur.post(`/api/dossiers/${dossier.id}/reopen`).send({ reason: 'Nieuwe stukken', version: v }),
    ];
    for (const attempt of refusals) {
      const response = await attempt();
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('closed');
    }

    expect(await stateOf(dossier.id)).toEqual({ state: 'CLOSED', processing_state: 'FINALISED' });
    expect(await version(dossier.id)).toBe(v);
  });

  it('requires a reason to reopen', async () => {
    const { directeur, dossier } = await closedMatter();
    await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/reopen`)
      .send({ reason: '   ', version: await version(dossier.id) })
      .expect(400);
    await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/reopen`)
      .send({ version: await version(dossier.id) })
      .expect(400);
    expect((await stateOf(dossier.id)).state).toBe('CLOSED');
  });

  it('refuses to reopen a dossier that is not closed', async () => {
    const { directeur, dossier } = await finalisedMatter();
    await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/reopen`)
      .send({ reason: 'Waarom niet', version: await version(dossier.id) })
      .expect(400);
  });

  it('reopens without erasing the closure, and can close again', async () => {
    const { directeur, dossier } = await closedMatter();
    const reopened = (
      await directeur
        .post(`/api/dossiers/${dossier.id}/dossier-state/reopen`)
        .send({ reason: 'Bezwaar ontvangen', version: await version(dossier.id) })
        .expect(200)
    ).body;
    expect(reopened.state).toBe('REOPENED');
    // Reopening the file does not reopen the work: that stays its own decision.
    expect(reopened.processingState).toBe('FINALISED');
    await expectAuditEvent(h.db, 'DOSSIER_REOPENED', 'Bezwaar ontvangen');

    await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/close`)
      .send({ reason: 'Bezwaar afgewezen', version: await version(dossier.id) })
      .expect(200);

    const history = (await directeur.get(`/api/dossiers/${dossier.id}/dossier-state`).expect(200)).body;
    expect(history.map((e: { fromState: string; toState: string }) => `${e.fromState}>${e.toState}`)).toEqual([
      'OPEN>CLOSED',
      'CLOSED>REOPENED',
      'REOPENED>CLOSED',
    ]);
    expect(history[0].reason).toBe('Afgehandeld');
  });

  it('lets work resume on a reopened dossier through the workflow reopening', async () => {
    const { directeur, dossier } = await closedMatter();
    await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/reopen`)
      .send({ reason: 'Aanvulling nodig', version: await version(dossier.id) })
      .expect(200);
    await directeur
      .post(`/api/dossiers/${dossier.id}/reopen`)
      .send({ reason: 'Aanvulling nodig', version: await version(dossier.id) })
      .expect(200);
    expect(await stateOf(dossier.id)).toEqual({ state: 'REOPENED', processing_state: 'ACTIVE' });
  });

  it('puts closing and reopening in the timeline, counted against the source', async () => {
    const { assistant, directeur, dossier } = await closedMatter();
    await directeur
      .post(`/api/dossiers/${dossier.id}/dossier-state/reopen`)
      .send({ reason: 'Bezwaar ontvangen', version: await version(dossier.id) })
      .expect(200);

    const timeline = (await assistant.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    const fileEvents = timeline.filter((e: { source: string }) => e.source === 'dossier_state_event');
    const [{ n }] = await h.db.query(
      `SELECT count(*)::int AS n FROM dossier_state_event WHERE dossier_id = $1`,
      [dossier.id],
    );
    expect(fileEvents).toHaveLength(n);
    expect(fileEvents.map((e: { headline: string }) => e.headline)).toEqual([
      'Dossier closed',
      'Dossier reopened',
    ]);
    expect(fileEvents[1].detail).toBe('Bezwaar ontvangen');
    expect(timeline[timeline.length - 1].kind).toBe('DOSSIER_REOPENED');
  });

  it('refuses an unknown dossier', async () => {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const unknown = '00000000-0000-4000-8000-000000000000';
    await agent.get(`/api/dossiers/${unknown}/dossier-state`).expect(404);
    await agent.post(`/api/dossiers/${unknown}/dossier-state/close`).send({ version: 1 }).expect(404);
  });

  describe('in the database itself', () => {
    it('refuses a state change with no state event behind it', async () => {
      const { dossier } = await finalisedMatter();
      await expect(
        h.db.query(`UPDATE dossier SET state = 'CLOSED' WHERE id = $1`, [dossier.id]),
      ).rejects.toThrow(/recorded as a state event/);
    });

    it('refuses to close an unfinalised matter even with an event', async () => {
      const { agent } = await signIn(h.app, 'directeur@juspol.test');
      const dossier = (await agent.post('/api/dossiers').send({ subject: 'Raw' }).expect(201)).body;
      await expect(
        h.db.query(`UPDATE dossier SET state = 'CLOSED' WHERE id = $1`, [dossier.id]),
      ).rejects.toThrow(/only when its matter is finalised/);
    });

    it('refuses a transition outside the three allowed', async () => {
      const { dossier } = await closedMatter();
      await expect(
        h.db.query(`UPDATE dossier SET state = 'OPEN' WHERE id = $1`, [dossier.id]),
      ).rejects.toThrow(/cannot move from CLOSED to OPEN/);
    });

    it('refuses edits and additions to a closed dossier', async () => {
      const { dossier } = await closedMatter();
      await expect(
        h.db.query(`UPDATE dossier SET subject = 'Rewritten' WHERE id = $1`, [dossier.id]),
      ).rejects.toThrow(/closed/);
      await expect(
        h.db.query(`UPDATE dossier SET due_date = '2027-01-01' WHERE id = $1`, [dossier.id]),
      ).rejects.toThrow(/closed/);
      const actor = await accountIdFor(h.db, 'directeur@juspol.test');
      await expect(
        h.db.query(
          `INSERT INTO workflow_event (dossier_id, event_type, actor_account_id, reason,
             reviewed_version, reviewed_snapshot)
           VALUES ($1, 'REOPENED', $2, 'x', 1, '{}')`,
          [dossier.id, actor],
        ),
      ).rejects.toThrow(/closed/);
    });

    it('keeps the state history append-only', async () => {
      const { dossier } = await closedMatter();
      await h.db.query(`UPDATE dossier_state_event SET reason = 'Rewritten' WHERE dossier_id = $1`, [dossier.id]);
      await h.db.query(`DELETE FROM dossier_state_event WHERE dossier_id = $1`, [dossier.id]);
      const rows = await h.db.query(`SELECT reason FROM dossier_state_event WHERE dossier_id = $1`, [dossier.id]);
      expect(rows).toEqual([{ reason: 'Afgehandeld' }]);
    });

    it('refuses a reopening event without a reason', async () => {
      const { dossier } = await closedMatter();
      const actor = await accountIdFor(h.db, 'directeur@juspol.test');
      await expect(
        h.db.query(
          `INSERT INTO dossier_state_event (dossier_id, from_state, to_state, actor_account_id)
           VALUES ($1, 'CLOSED', 'REOPENED', $2)`,
          [dossier.id, actor],
        ),
      ).rejects.toThrow(/reopen_reason/);
    });
  });
});
