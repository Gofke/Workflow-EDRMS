import { Harness, accountIdFor, signIn, startHarness } from './harness';

/**
 * The dossier timeline (BR-009).
 *
 * The property worth testing is not that the timeline looks right but that it
 * is derived: every authoritative event appears exactly once, and no entry
 * exists that no row produced. A stored narrative would pass a spot check and
 * still drift; these tests count.
 */
describe('Dossier timeline', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const pdf = Buffer.from('%PDF-1.4\n% TIMELINE-MARKER\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');

  async function currentVersion(dossierId: string): Promise<number> {
    const [row] = await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [dossierId]);
    return row.version;
  }

  /** A matter that has been through everything the build can do to one. */
  async function fullLifeMatter() {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (
      await agent.post('/api/dossiers').send({ subject: `Full life ${Date.now()}` }).expect(201)
    ).body;

    const draft = (
      await agent
        .post('/api/records/drafts')
        .send({ direction: 'INCOMING', subject: 'Inzageverzoek', party: 'PARTY-SYN-A' })
        .expect(201)
    ).body;
    await agent
      .post(`/api/records/${draft.id}/documents`)
      .attach('file', pdf, { filename: 'scan.pdf', contentType: 'application/pdf' })
      .expect(201);
    const registered = (
      await agent.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)
    ).body;
    await agent.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: registered.id }).expect(200);

    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    await directeur
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({
        responsibleAccountId: await accountIdFor(h.db, 'onderdirecteur@juspol.test'),
        version: await currentVersion(dossier.id),
      })
      .expect(200);
    await directeur
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({ dueDate: '2026-10-15', version: await currentVersion(dossier.id) })
      .expect(200);
    await directeur
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({
        dueDate: '2026-11-30',
        reason: 'Uitstel toegekend in afwachting van juridisch advies',
        version: await currentVersion(dossier.id),
      })
      .expect(200);

    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({
        reviewerAccountId: await accountIdFor(h.db, 'directeur@juspol.test'),
        version: await currentVersion(dossier.id),
      })
      .expect(200);
    await directeur
      .post(`/api/dossiers/${dossier.id}/return`)
      .send({ reason: 'De juridische grondslag ontbreekt', version: await currentVersion(dossier.id) })
      .expect(200);
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({
        reviewerAccountId: await accountIdFor(h.db, 'directeur@juspol.test'),
        version: await currentVersion(dossier.id),
      })
      .expect(200);
    await directeur
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(200);
    await directeur
      .post(`/api/dossiers/${dossier.id}/finalise`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(200);

    return { agent, directeur, dossier, registered };
  }

  it('accounts for every authoritative event exactly once', async () => {
    const { agent, dossier } = await fullLifeMatter();
    const timeline = (await agent.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;

    // Counted against the source tables rather than against a fixed number, so
    // the test still holds when a slice adds another kind of event.
    const counts = async (sql: string) => Number((await h.db.query(sql, [dossier.id]))[0].n);
    const expected =
      1 + // the dossier itself
      (await counts(`SELECT count(*)::int AS n FROM responsibility_assignment WHERE dossier_id = $1`)) +
      (await counts(`SELECT count(*)::int AS n FROM due_date_change WHERE dossier_id = $1`)) +
      (await counts(`SELECT count(*)::int AS n FROM dossier_link WHERE dossier_id = $1`)) +
      (await counts(
        `SELECT count(*)::int AS n FROM correspondence_item ci
           JOIN dossier_link dl ON dl.correspondence_item_id = ci.id
          WHERE dl.dossier_id = $1 AND ci.registered_at IS NOT NULL`,
      )) +
      (await counts(
        `SELECT count(*)::int AS n FROM captured_document cd
           JOIN dossier_link dl ON dl.correspondence_item_id = cd.correspondence_item_id
          WHERE dl.dossier_id = $1`,
      )) +
      (await counts(`SELECT count(*)::int AS n FROM workflow_event WHERE dossier_id = $1`)) +
      (await counts(`SELECT count(*)::int AS n FROM dossier_state_event WHERE dossier_id = $1`));

    expect(timeline).toHaveLength(expected);
  });

  it('draws on every kind of source', async () => {
    const { agent, dossier } = await fullLifeMatter();
    const timeline = (await agent.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;

    const sources = new Set(timeline.map((e: { source: string }) => e.source));
    expect(sources).toEqual(
      new Set([
        'dossier',
        'responsibility_assignment',
        'due_date_change',
        'dossier_link',
        'correspondence_item',
        'captured_document',
        'workflow_event',
      ]),
    );
  });

  it('reads in order, opening first and finalisation last', async () => {
    const { agent, dossier } = await fullLifeMatter();
    const timeline = (await agent.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;

    const times = timeline.map((e: { occurredAt: string }) => new Date(e.occurredAt).getTime());
    expect([...times]).toEqual([...times].sort((a, b) => a - b));
    expect(timeline[0].kind).toBe('DOSSIER_OPENED');
    expect(timeline[timeline.length - 1].kind).toBe('FINALISED');

    const kinds = timeline.map((e: { kind: string }) => e.kind);
    expect(kinds.filter((k: string) => k === 'SUBMITTED')).toHaveLength(2);
    expect(kinds).toContain('RETURNED');
    expect(kinds).toContain('APPROVED');
  });

  it('carries the actor, the reason and the represented authority', async () => {
    const { agent, dossier } = await fullLifeMatter();
    const timeline = (await agent.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;

    const returned = timeline.find((e: { kind: string }) => e.kind === 'RETURNED');
    expect(returned.actorName).toBe('M. Sardjoe');
    expect(returned.detail).toContain('De juridische grondslag ontbreekt');

    const dueChange = timeline.filter((e: { kind: string }) => e.kind === 'DUE_DATE_CHANGED');
    expect(dueChange[0].headline).toContain('set to 2026-10-15');
    expect(dueChange[1].detail).toContain('Uitstel toegekend');

    const capture = timeline.find((e: { kind: string }) => e.kind === 'DOCUMENT_CAPTURED');
    expect(capture.headline).toContain('scan.pdf');
    expect(capture.detail).toContain('sha256');
  });

  it('shows an action taken under delegated authority with both names', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const delegate = await accountIdFor(h.db, 'assistant2@juspol.test');
    await directeur
      .post('/api/delegations')
      .send({
        delegateAccountId: delegate,
        actions: ['ASSIGN_RESPONSIBILITY'],
        validFrom: new Date(Date.now() - 86_400_000).toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);

    const dossier = (
      await directeur.post('/api/dossiers').send({ subject: `Delegated life ${Date.now()}` }).expect(201)
    ).body;
    const { agent: assistant } = await signIn(h.app, 'assistant2@juspol.test');
    await assistant
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({
        responsibleAccountId: await accountIdFor(h.db, 'onderdirecteur@juspol.test'),
        version: await currentVersion(dossier.id),
      })
      .expect(200);

    const timeline = (await assistant.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    const entry = timeline.find((e: { kind: string }) => e.kind === 'RESPONSIBILITY_ASSIGNED');
    expect(entry.actorName).toBe('K. Pawironadi');
    expect(entry.onBehalfOfName).toBe('M. Sardjoe');
  });

  it('is empty of events but not of the opening, for a new matter', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (
      await agent.post('/api/dossiers').send({ subject: `Fresh ${Date.now()}` }).expect(201)
    ).body;
    const timeline = (await agent.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe('DOSSIER_OPENED');
  });

  /** Reading a timeline must not write one. It is a view, not a record. */
  it('writes nothing when it is read', async () => {
    const { agent, dossier } = await fullLifeMatter();
    const [{ n: auditBefore }] = await h.db.query(`SELECT count(*)::int AS n FROM audit_event`);
    const [{ n: eventsBefore }] = await h.db.query(`SELECT count(*)::int AS n FROM workflow_event`);

    await agent.get(`/api/dossiers/${dossier.id}/timeline`).expect(200);
    await agent.get(`/api/dossiers/${dossier.id}/timeline`).expect(200);

    const [{ n: auditAfter }] = await h.db.query(`SELECT count(*)::int AS n FROM audit_event`);
    const [{ n: eventsAfter }] = await h.db.query(`SELECT count(*)::int AS n FROM workflow_event`);
    expect(auditAfter).toBe(auditBefore);
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('cannot disagree with the workflow history it derives from', async () => {
    const { agent, dossier } = await fullLifeMatter();
    const timeline = (await agent.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    const workflow = (await agent.get(`/api/dossiers/${dossier.id}/workflow`).expect(200)).body;

    const fromTimeline = timeline
      .filter((e: { source: string }) => e.source === 'workflow_event')
      .map((e: { kind: string }) => e.kind);
    expect(fromTimeline).toEqual(workflow.map((e: { eventType: string }) => e.eventType));
  });

  it('keeps the timeline closed to the administrator and to anyone without a session', async () => {
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    const { dossier } = await fullLifeMatter();
    await admin.get(`/api/dossiers/${dossier.id}/timeline`).expect(403);
    await require('supertest')(h.app.getHttpServer())
      .get(`/api/dossiers/${dossier.id}/timeline`)
      .expect(401);
  });

  it('refuses an unknown dossier', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    await agent
      .get('/api/dossiers/00000000-0000-4000-8000-000000000000/timeline')
      .expect(404);
  });
});
