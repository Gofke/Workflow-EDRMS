import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/**
 * The review decision flow (FR-WFL).
 *
 * TS-05 puts the P0 weight on three things: that approval authority is
 * evaluated independently of who prepared the work, that return and correction
 * preserve the complete prior evidence, and that what is approved is what was
 * actually reviewed (FR-WFL-014).
 */
describe('Review and approval', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  /** A matter prepared by support staff, with one registered record in it. */
  async function preparedMatter(subject = `Matter ${Date.now()}${Math.random()}`) {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (await agent.post('/api/dossiers').send({ subject }).expect(201)).body;
    const draft = (
      await agent
        .post('/api/records/drafts')
        .send({ direction: 'INCOMING', subject: `Record for ${subject}` })
        .expect(201)
    ).body;
    const registered = (
      await agent.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)
    ).body;
    const linked = (
      await agent.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: registered.id }).expect(200)
    ).body;
    return { agent, dossier: linked, record: registered };
  }

  async function currentVersion(dossierId: string): Promise<number> {
    const [row] = await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [dossierId]);
    return row.version;
  }

  it('lets support staff route a package to a reviewer without gaining authority', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewer = await accountIdFor(h.db, 'directeur@juspol.test');

    const result = await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewer, version: await currentVersion(dossier.id) })
      .expect(200);
    expect(result.body.processingState).toBe('UNDER_REVIEW');
    await expectAuditEvent(h.db, 'WORKFLOW_SUBMITTED', dossier.dossierIdentity);

    // Routing conferred nothing: the submitter cannot decide on it.
    await agent
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(403);
  });

  it('shows the matter in the designated reviewer’s queue and nobody else’s', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewer = await accountIdFor(h.db, 'directeur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewer, version: await currentVersion(dossier.id) })
      .expect(200);

    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const queue = await directeur.get('/api/dossiers/review-queue').expect(200);
    expect(queue.body.map((r: { dossierIdentity: string }) => r.dossierIdentity)).toContain(
      dossier.dossierIdentity,
    );
    expect(queue.body[0].submittedByName).toBeTruthy();

    const { agent: other } = await signIn(h.app, 'onderdirecteur@juspol.test');
    const otherQueue = await other.get('/api/dossiers/review-queue').expect(200);
    expect(otherQueue.body.map((r: { dossierIdentity: string }) => r.dossierIdentity)).not.toContain(
      dossier.dossierIdentity,
    );
  });

  /** FR-WFL-004: authority is per submission, not per seniority. */
  it('refuses a decision from anyone who is not the designated reviewer', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewer = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewer, version: await currentVersion(dossier.id) })
      .expect(200);

    // The Minister outranks the designated reviewer and is still refused.
    for (const email of ['minister@juspol.test', 'directeur@juspol.test', 'assistant2@juspol.test']) {
      const { agent: outsider } = await signIn(h.app, email);
      await outsider
        .post(`/api/dossiers/${dossier.id}/approve`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(403);
      await outsider
        .post(`/api/dossiers/${dossier.id}/return`)
        .send({ reason: 'Not mine to judge.', version: await currentVersion(dossier.id) })
        .expect(403);
    }
  });

  it('refuses submission to someone with no review authority, or to oneself', async () => {
    const { agent, dossier } = await preparedMatter();
    const support = await accountIdFor(h.db, 'assistant2@juspol.test');
    const admin = await accountIdFor(h.db, 'sysadmin@juspol.test');
    const self = await accountIdFor(h.db, 'assistant1@juspol.test');

    for (const target of [support, admin, self]) {
      await agent
        .post(`/api/dossiers/${dossier.id}/submit`)
        .send({ reviewerAccountId: target, version: await currentVersion(dossier.id) })
        .expect(400);
    }
    // And the state did not move.
    const [row] = await h.db.query(`SELECT processing_state FROM dossier WHERE id = $1`, [
      dossier.id,
    ]);
    expect(row.processing_state).toBe('ACTIVE');
  });

  it('requires a reason to return, and preserves the return event through corrections', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
      .expect(200);

    const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
    // Empty is rejected by the request validator.
    await reviewer
      .post(`/api/dossiers/${dossier.id}/return`)
      .send({ reason: '', version: await currentVersion(dossier.id) })
      .expect(400);
    // Whitespace only passes the validator and the database check — the length
    // constraint counts spaces — so the service must reject it. A blank reason
    // is not a reviewed decision.
    await reviewer
      .post(`/api/dossiers/${dossier.id}/return`)
      .send({ reason: '     ', version: await currentVersion(dossier.id) })
      .expect(400);

    const reason = 'The legal basis is not stated and the annex is missing.';
    const returned = await reviewer
      .post(`/api/dossiers/${dossier.id}/return`)
      .send({ reason, version: await currentVersion(dossier.id) })
      .expect(200);
    expect(returned.body.processingState).toBe('RETURNED');

    const before = await agent.get(`/api/dossiers/${dossier.id}/workflow`).expect(200);
    const returnEvent = before.body.find((e: { eventType: string }) => e.eventType === 'RETURNED');
    expect(returnEvent.reason).toBe(reason);
    expect(returnEvent.actorName).toBe('M. Sardjoe');

    // Correct the work — FR-WFL-008: the return event must not change.
    await agent
      .post(`/api/records/drafts`)
      .send({ direction: 'INCOMING', subject: 'Missing annex' })
      .expect(201);
    const after = await agent.get(`/api/dossiers/${dossier.id}/workflow`).expect(200);
    expect(after.body.find((e: { eventType: string }) => e.eventType === 'RETURNED')).toEqual(
      returnEvent,
    );
  });

  /** FR-WFL-009: the whole chain survives and a resubmission is distinguishable. */
  it('allows resubmission with the full prior chain intact', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
      .expect(200);
    const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
    await reviewer
      .post(`/api/dossiers/${dossier.id}/return`)
      .send({ reason: 'Needs the annex.', version: await currentVersion(dossier.id) })
      .expect(200);
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
      .expect(200);

    const history = await agent.get(`/api/dossiers/${dossier.id}/workflow`).expect(200);
    expect(history.body.map((e: { eventType: string }) => e.eventType)).toEqual([
      'SUBMITTED',
      'RETURNED',
      'SUBMITTED',
    ]);
    // The two submissions are distinguishable by time and by version.
    expect(history.body[2].occurredAt).not.toBe(history.body[0].occurredAt);
    expect(history.body[2].reviewedVersion).toBeGreaterThan(history.body[0].reviewedVersion);
    expect(history.body[1].reason).toBe('Needs the annex.');
  });

  it('records an approval with the version that was reviewed', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
      .expect(200);

    const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
    const approved = await reviewer
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(200);
    expect(approved.body.processingState).toBe('APPROVED');

    const event = await expectAuditEvent(h.db, 'WORKFLOW_APPROVED', dossier.dossierIdentity);
    expect(event.actor_description).toContain('M. Sardjoe');
    expect(String(event.new_value)).toContain('version');
    expect(event.represented_authority).toBeNull();
  });

  /**
   * FR-WFL-014, the heaviest-covered requirement in TS-05. If the matter moved
   * after submission, approving it would approve something nobody reviewed.
   */
  it('refuses to approve a matter that changed after it was submitted', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
      .expect(200);

    // A second record is filed into the matter while it sits under review.
    const draft = (
      await agent
        .post('/api/records/drafts')
        .send({ direction: 'INTERNAL', subject: 'Added after submission' })
        .expect(201)
    ).body;
    const registered = (
      await agent.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)
    ).body;
    await agent
      .post(`/api/dossiers/${dossier.id}/links`)
      .send({ itemId: registered.id })
      .expect(200);

    const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
    const refused = await reviewer
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(409);
    expect(refused.body.message).toContain('resubmitted');

    const [row] = await h.db.query(`SELECT processing_state FROM dossier WHERE id = $1`, [
      dossier.id,
    ]);
    expect(row.processing_state).toBe('UNDER_REVIEW');
  });

  /**
   * The version check on its own, without any change to the linked records.
   *
   * Found by the cumulative re-audit: the case above changes the records AND
   * the version, so the snapshot comparison alone caught it and the version
   * check was never exercised by itself. A due-date change moves the version
   * while leaving the record set identical — exactly the case only the version
   * check can catch.
   */
  it('refuses to approve when the matter moved without its records changing', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
      .expect(200);

    const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
    // A due date is set while the matter is under review: the version moves,
    // the linked records do not.
    await reviewer
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({ dueDate: '2026-12-15', version: await currentVersion(dossier.id) })
      .expect(200);

    const refused = await reviewer
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(409);
    expect(refused.body.message).toContain('resubmitted');
  });

  it('refuses a decision on a matter that is not under review', async () => {
    const { agent, dossier } = await preparedMatter();
    const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
    await reviewer
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(400);

    const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
      .expect(200);
    await reviewer
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(200);
    // Already approved: no second decision.
    await reviewer
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: await currentVersion(dossier.id) })
      .expect(400);
  });

  it('applies the version check to every workflow action (DEC-05)', async () => {
    const { agent, dossier } = await preparedMatter();
    const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
    const stale = await currentVersion(dossier.id);
    await agent
      .post(`/api/dossiers/${dossier.id}/submit`)
      .send({ reviewerAccountId: reviewerId, version: stale })
      .expect(200);

    const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
    await reviewer
      .post(`/api/dossiers/${dossier.id}/approve`)
      .send({ version: stale })
      .expect(409);
  });

  it('keeps approval delegation off unless configuration enables it', async () => {
    // APPROVE_ON_BEHALF is absent from the default DELEGATABLE_ACTIONS, so the
    // grant itself is refused — the capability cannot spread by accident.
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const delegate = await accountIdFor(h.db, 'assistant1@juspol.test');
    await agent
      .post('/api/delegations')
      .send({
        delegateAccountId: delegate,
        actions: ['APPROVE_ON_BEHALF'],
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(400);
  });

  it('keeps workflow closed to the administrator and to anyone without a session', async () => {
    const { dossier } = await preparedMatter();
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    await admin.get('/api/dossiers/review-queue').expect(403);
    await admin.get(`/api/dossiers/${dossier.id}/workflow`).expect(403);
    await require('supertest')(h.app.getHttpServer())
      .get('/api/dossiers/review-queue')
      .expect(401);
  });

  describe('finalisation and reopening', () => {
    async function approvedMatter() {
      const { agent, dossier } = await preparedMatter();
      const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
      await agent
        .post(`/api/dossiers/${dossier.id}/submit`)
        .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
        .expect(200);
      const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
      await reviewer
        .post(`/api/dossiers/${dossier.id}/approve`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);
      return { agent, reviewer, dossier };
    }

    /** FR-WFL-012: no finalisation without the approval evidence. */
    it('refuses to finalise a matter that has not been approved', async () => {
      const { dossier } = await preparedMatter();
      const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
      const refused = await reviewer
        .post(`/api/dossiers/${dossier.id}/finalise`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(400);
      expect(refused.body.message).toContain('approved');
    });

    it('finalises an approved matter and names the approval it rests on', async () => {
      const { reviewer, dossier } = await approvedMatter();
      const finalised = await reviewer
        .post(`/api/dossiers/${dossier.id}/finalise`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);
      expect(finalised.body.processingState).toBe('FINALISED');

      const event = await expectAuditEvent(h.db, 'WORKFLOW_FINALISED', dossier.dossierIdentity);
      expect(String(event.new_value)).toContain('M. Sardjoe');
      expect(String(event.new_value)).toContain('version');
    });

    it('refuses finalisation and reopening to support staff', async () => {
      const { agent, reviewer, dossier } = await approvedMatter();
      await agent
        .post(`/api/dossiers/${dossier.id}/finalise`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(403);
      await reviewer
        .post(`/api/dossiers/${dossier.id}/finalise`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);
      await agent
        .post(`/api/dossiers/${dossier.id}/reopen`)
        .send({ reason: 'Let me in.', version: await currentVersion(dossier.id) })
        .expect(403);
    });

    /** FR-FIN-003: a closed result is not ordinary working data. */
    it('protects a finalised matter from ordinary change', async () => {
      const { agent, reviewer, dossier } = await approvedMatter();
      await reviewer
        .post(`/api/dossiers/${dossier.id}/finalise`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);

      const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
      await reviewer
        .post(`/api/dossiers/${dossier.id}/responsibility`)
        .send({ responsibleAccountId: target, version: await currentVersion(dossier.id) })
        .expect(400);
      await reviewer
        .post(`/api/dossiers/${dossier.id}/due-date`)
        .send({ dueDate: '2027-01-01', version: await currentVersion(dossier.id) })
        .expect(400);

      const draft = (
        await agent
          .post('/api/records/drafts')
          .send({ direction: 'INTERNAL', subject: 'After finalisation' })
          .expect(201)
      ).body;
      const registered = (
        await agent
          .post(`/api/records/${draft.id}/register`)
          .send({ version: draft.version })
          .expect(200)
      ).body;
      const refused = await agent
        .post(`/api/dossiers/${dossier.id}/links`)
        .send({ itemId: registered.id })
        .expect(400);
      expect(refused.body.message).toContain('finalised');
    });

    /** FR-FIN-004: reopening supersedes, it does not erase. */
    it('reopens with a reason and leaves the finalisation in the history', async () => {
      const { reviewer, dossier } = await approvedMatter();
      await reviewer
        .post(`/api/dossiers/${dossier.id}/finalise`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);

      await reviewer
        .post(`/api/dossiers/${dossier.id}/reopen`)
        .send({ reason: '   ', version: await currentVersion(dossier.id) })
        .expect(400);

      const reopened = await reviewer
        .post(`/api/dossiers/${dossier.id}/reopen`)
        .send({
          reason: 'New evidence received from the applicant.',
          version: await currentVersion(dossier.id),
        })
        .expect(200);
      expect(reopened.body.processingState).toBe('ACTIVE');

      const history = await reviewer.get(`/api/dossiers/${dossier.id}/workflow`).expect(200);
      expect(history.body.map((e: { eventType: string }) => e.eventType)).toEqual([
        'SUBMITTED',
        'APPROVED',
        'FINALISED',
        'REOPENED',
      ]);
      expect(history.body[3].reason).toContain('New evidence');
      await expectAuditEvent(h.db, 'WORKFLOW_REOPENED', dossier.dossierIdentity);
    });

    it('allows the reopened matter to go round again, keeping the whole chain', async () => {
      const { agent, reviewer, dossier } = await approvedMatter();
      await reviewer
        .post(`/api/dossiers/${dossier.id}/finalise`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);
      await reviewer
        .post(`/api/dossiers/${dossier.id}/reopen`)
        .send({ reason: 'Further handling required.', version: await currentVersion(dossier.id) })
        .expect(200);

      const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
      await agent
        .post(`/api/dossiers/${dossier.id}/submit`)
        .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
        .expect(200);
      await reviewer
        .post(`/api/dossiers/${dossier.id}/approve`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);
      await reviewer
        .post(`/api/dossiers/${dossier.id}/finalise`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);

      const history = await reviewer.get(`/api/dossiers/${dossier.id}/workflow`).expect(200);
      expect(history.body.map((e: { eventType: string }) => e.eventType)).toEqual([
        'SUBMITTED',
        'APPROVED',
        'FINALISED',
        'REOPENED',
        'SUBMITTED',
        'APPROVED',
        'FINALISED',
      ]);
    });

    it('refuses to reopen a matter that is not finalised', async () => {
      const { reviewer, dossier } = await approvedMatter();
      await reviewer
        .post(`/api/dossiers/${dossier.id}/reopen`)
        .send({ reason: 'Not finalised yet.', version: await currentVersion(dossier.id) })
        .expect(400);
    });
  });

  describe('protected by the database', () => {
    it('refuses a state jump that FS-05 does not permit', async () => {
      const { dossier } = await preparedMatter();
      await expect(
        h.db.query(`UPDATE dossier SET processing_state = 'APPROVED' WHERE id = $1`, [dossier.id]),
      ).rejects.toThrow(/cannot move from ACTIVE to APPROVED/);
    });

    it('refuses a state change with no workflow event behind it', async () => {
      const { dossier } = await preparedMatter();
      await expect(
        h.db.query(`UPDATE dossier SET processing_state = 'UNDER_REVIEW' WHERE id = $1`, [
          dossier.id,
        ]),
      ).rejects.toThrow(/must be recorded as a workflow event first/);
    });

    it('discards edits and deletes against decision events', async () => {
      const { agent, dossier } = await preparedMatter();
      const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
      await agent
        .post(`/api/dossiers/${dossier.id}/submit`)
        .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
        .expect(200);
      const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
      await reviewer
        .post(`/api/dossiers/${dossier.id}/return`)
        .send({ reason: 'Original reason.', version: await currentVersion(dossier.id) })
        .expect(200);

      await h.db.query(`UPDATE workflow_event SET reason = 'Reworded reason.'`);
      await h.db.query(`DELETE FROM workflow_event WHERE dossier_id = $1`, [dossier.id]);

      const [row] = await h.db.query(
        `SELECT reason FROM workflow_event WHERE dossier_id = $1 AND event_type = 'RETURNED'`,
        [dossier.id],
      );
      expect(row.reason).toBe('Original reason.');
    });

    it('refuses a return with no reason at the database level', async () => {
      const { dossier } = await preparedMatter();
      const actor = await accountIdFor(h.db, 'directeur@juspol.test');
      await expect(
        h.db.query(
          `INSERT INTO workflow_event (dossier_id, event_type, actor_account_id,
             reviewed_version, reviewed_snapshot)
           VALUES ($1, 'RETURNED', $2, 1, '{}'::jsonb)`,
          [dossier.id, actor],
        ),
      ).rejects.toThrow(/ck_workflow_event_return_reason/);
    });

    /**
     * The decision and its audit event are one transaction, so the count of
     * decisions and the count of their audit events move together.
     */
    it('writes each decision and its audit event together', async () => {
      const { agent, dossier } = await preparedMatter();
      const reviewerId = await accountIdFor(h.db, 'directeur@juspol.test');
      await agent
        .post(`/api/dossiers/${dossier.id}/submit`)
        .send({ reviewerAccountId: reviewerId, version: await currentVersion(dossier.id) })
        .expect(200);
      const { agent: reviewer } = await signIn(h.app, 'directeur@juspol.test');
      await reviewer
        .post(`/api/dossiers/${dossier.id}/approve`)
        .send({ version: await currentVersion(dossier.id) })
        .expect(200);

      const [events] = await h.db.query(
        `SELECT count(*)::int AS n FROM workflow_event WHERE dossier_id = $1`,
        [dossier.id],
      );
      const [audits] = await h.db.query(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE subject_description LIKE $1 AND event_type LIKE 'WORKFLOW_%'`,
        [`${dossier.dossierIdentity}%`],
      );
      expect(events.n).toBe(2);
      expect(audits.n).toBe(2);
    });

    it('refuses a state jump to FINALISED without an approval behind it', async () => {
      const { dossier } = await preparedMatter();
      await expect(
        h.db.query(`UPDATE dossier SET processing_state = 'FINALISED' WHERE id = $1`, [dossier.id]),
      ).rejects.toThrow(/cannot move from ACTIVE to FINALISED/);
    });

    it('refuses a reopening with no reason at the database level', async () => {
      const { dossier } = await preparedMatter();
      const actor = await accountIdFor(h.db, 'directeur@juspol.test');
      await expect(
        h.db.query(
          `INSERT INTO workflow_event (dossier_id, event_type, actor_account_id,
             reviewed_version, reviewed_snapshot)
           VALUES ($1, 'REOPENED', $2, 1, '{}'::jsonb)`,
          [dossier.id, actor],
        ),
      ).rejects.toThrow(/ck_workflow_event_reopen_reason/);
    });

    it('refuses a submission that names no reviewer at the database level', async () => {
      const { dossier } = await preparedMatter();
      const actor = await accountIdFor(h.db, 'assistant1@juspol.test');
      await expect(
        h.db.query(
          `INSERT INTO workflow_event (dossier_id, event_type, actor_account_id,
             reviewed_version, reviewed_snapshot)
           VALUES ($1, 'SUBMITTED', $2, 1, '{}'::jsonb)`,
          [dossier.id, actor],
        ),
      ).rejects.toThrow(/ck_workflow_event_submit_reviewer/);
    });
  });
});
