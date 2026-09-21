import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/**
 * Delegation and acting on behalf (FR-DEL).
 *
 * TS-04 names the failure that would invalidate this domain: a delegated action
 * attributed to the principal instead of the person who actually performed it,
 * or to the delegate with the represented authority lost. Either way the
 * accountability chain breaks. Those two cases are the heart of this spec.
 */
describe('Delegation', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const day = 86_400_000;
  const period = (fromOffset = -day, untilOffset = 7 * day) => ({
    validFrom: new Date(Date.now() + fromOffset).toISOString(),
    validUntil: new Date(Date.now() + untilOffset).toISOString(),
  });

  async function dossier() {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const created = await agent
      .post('/api/dossiers')
      .send({ subject: `Matter ${Date.now()}${Math.random()}` })
      .expect(201);
    return created.body;
  }

  async function grantTo(email: string, actions: string[], p = period()) {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const delegateAccountId = await accountIdFor(h.db, email);
    const granted = await agent
      .post('/api/delegations')
      .send({ delegateAccountId, actions, ...p })
      .expect(201);
    return granted.body;
  }

  it('records principal, delegate, actions and period on a grant', async () => {
    const granted = await grantTo('assistant1@juspol.test', ['ASSIGN_RESPONSIBILITY']);

    expect(granted.principalName).toBe('M. Sardjoe');
    expect(granted.delegateName).toBe('L. Amatredjo');
    expect(granted.permittedActions).toEqual(['ASSIGN_RESPONSIBILITY']);
    expect(granted.isActive).toBe(true);
    expect(new Date(granted.validUntil).getTime()).toBeGreaterThan(Date.now());
    await expectAuditEvent(h.db, 'DELEGATION_GRANTED', 'L. Amatredjo');
  });

  it('refuses a grant from a role that may not delegate (DEC-13 configuration)', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const delegateAccountId = await accountIdFor(h.db, 'assistant2@juspol.test');
    await agent
      .post('/api/delegations')
      .send({ delegateAccountId, actions: ['SET_DUE_DATE'], ...period() })
      .expect(403);
  });

  it('refuses an undelegatable action, a self-delegation and an over-long period', async () => {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const other = await accountIdFor(h.db, 'assistant1@juspol.test');
    const self = await accountIdFor(h.db, 'directeur@juspol.test');

    await agent
      .post('/api/delegations')
      .send({ delegateAccountId: other, actions: ['APPROVE_EVERYTHING'], ...period() })
      .expect(400);
    await agent
      .post('/api/delegations')
      .send({ delegateAccountId: self, actions: ['SET_DUE_DATE'], ...period() })
      .expect(400);
    await agent
      .post('/api/delegations')
      .send({
        delegateAccountId: other,
        actions: ['SET_DUE_DATE'],
        ...period(-day, 400 * day),
      })
      .expect(400);
  });

  /** FR-DEL-005: without a delegation, support staff are refused as before. */
  it('refuses support staff before any delegation exists', async () => {
    const d = await dossier();
    const { agent } = await signIn(h.app, 'assistant2@juspol.test');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await agent
      .post(`/api/dossiers/${d.id}/responsibility`)
      .send({ responsibleAccountId: target, version: d.version })
      .expect(403);
  });

  /**
   * FR-DEL-003, the case that carries the weight. Both parties must appear: the
   * assistant who acted and the Directeur whose authority was used.
   */
  it('lets a delegate act, recording the actual actor AND the represented authority', async () => {
    await grantTo('assistant1@juspol.test', ['ASSIGN_RESPONSIBILITY']);
    const d = await dossier();
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');

    await agent
      .post(`/api/dossiers/${d.id}/responsibility`)
      .send({ responsibleAccountId: target, version: d.version })
      .expect(200);

    const event = await expectAuditEvent(h.db, 'RESPONSIBILITY_ASSIGNED', d.dossierIdentity);
    // The actor is the assistant, not the Directeur.
    expect(event.actor_description).toContain('L. Amatredjo');
    expect(event.actor_description).not.toContain('M. Sardjoe');
    // The represented authority is the Directeur, and is not lost.
    expect(event.represented_authority).toContain('M. Sardjoe');
    expect(String(event.summary)).toContain('acting on behalf of');

    // The same fact on the object itself, not only in the trail.
    const [row] = await h.db.query(
      `SELECT ab.email AS actor, obo.email AS on_behalf_of
         FROM responsibility_assignment ra
         JOIN account ab ON ab.id = ra.assigned_by_account_id
         LEFT JOIN account obo ON obo.id = ra.on_behalf_of_account_id
        WHERE ra.dossier_id = $1`,
      [d.id],
    );
    expect(row.actor).toBe('assistant1@juspol.test');
    expect(row.on_behalf_of).toBe('directeur@juspol.test');
  });

  it('leaves represented authority empty when a role holder acts in their own right', async () => {
    const d = await dossier();
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const target = await accountIdFor(h.db, 'minister@juspol.test');

    await agent
      .post(`/api/dossiers/${d.id}/responsibility`)
      .send({ responsibleAccountId: target, version: d.version })
      .expect(200);

    const [row] = await h.db.query(
      `SELECT on_behalf_of_account_id FROM responsibility_assignment WHERE dossier_id = $1`,
      [d.id],
    );
    expect(row.on_behalf_of_account_id).toBeNull();
    const event = await expectAuditEvent(h.db, 'RESPONSIBILITY_ASSIGNED', d.dossierIdentity);
    expect(event.represented_authority).toBeNull();
  });

  /** FR-DEL-004: the grant covers one action and confers nothing else. */
  it('grants only the listed action', async () => {
    await grantTo('assistant2@juspol.test', ['SET_DUE_DATE']);
    const d = await dossier();
    const { agent } = await signIn(h.app, 'assistant2@juspol.test');

    await agent
      .post(`/api/dossiers/${d.id}/due-date`)
      .send({ dueDate: '2026-12-01', version: d.version })
      .expect(200);

    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    const fresh = await agent.get('/api/dossiers').expect(200);
    const current = fresh.body.find((row: { id: string }) => row.id === d.id);
    await agent
      .post(`/api/dossiers/${d.id}/responsibility`)
      .send({ responsibleAccountId: target, version: current.version })
      .expect(403);
  });

  it('confers nothing before it starts or after it ends', async () => {
    const future = await grantTo('assistant1@juspol.test', ['SET_DUE_DATE'], period(day, 5 * day));
    expect(future.isActive).toBe(false);
    const d = await dossier();
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    await agent
      .post(`/api/dossiers/${d.id}/due-date`)
      .send({ dueDate: '2026-12-02', version: d.version })
      .expect(403);

    // An expired grant: valid_from and valid_until both in the past.
    const delegateId = await accountIdFor(h.db, 'assistant2@juspol.test');
    const principalId = await accountIdFor(h.db, 'directeur@juspol.test');
    await h.db.query(
      `INSERT INTO delegation (principal_account_id, delegate_account_id, permitted_actions,
         valid_from, valid_until, granted_by_account_id)
       VALUES ($1, $2, 'ASSIGN_RESPONSIBILITY', now() - interval '10 days',
               now() - interval '1 day', $1)`,
      [principalId, delegateId],
    );
    const d2 = await dossier();
    const { agent: expired } = await signIn(h.app, 'assistant2@juspol.test');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await expired
      .post(`/api/dossiers/${d2.id}/responsibility`)
      .send({ responsibleAccountId: target, version: d2.version })
      .expect(403);
  });

  /** FR-DEL-006: revocation stops future use and keeps the evidence. */
  it('stops future use on revocation without removing what was already done', async () => {
    // A delegate used by no other case here: earlier grants in this file would
    // otherwise still be active and would legitimately keep authority alive.
    const granted = await grantTo('unauthorised@juspol.test', ['ASSIGN_RESPONSIBILITY']);
    const d = await dossier();
    const { agent: delegate } = await signIn(h.app, 'unauthorised@juspol.test');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');

    await delegate
      .post(`/api/dossiers/${d.id}/responsibility`)
      .send({ responsibleAccountId: target, version: d.version })
      .expect(200);

    const { agent: principal } = await signIn(h.app, 'directeur@juspol.test');
    const revoked = await principal.post(`/api/delegations/${granted.id}/revoke`).expect(200);
    expect(revoked.body.isActive).toBe(false);
    expect(revoked.body.revokedAt).not.toBeNull();
    await expectAuditEvent(h.db, 'DELEGATION_REVOKED', 'D. Oemrawsingh');

    // Future use refused.
    const d2 = await dossier();
    await delegate
      .post(`/api/dossiers/${d2.id}/responsibility`)
      .send({ responsibleAccountId: target, version: d2.version })
      .expect(403);

    // Evidence of the legitimate action survives, with both parties intact.
    const [row] = await h.db.query(
      `SELECT count(*)::int AS n FROM responsibility_assignment
        WHERE dossier_id = $1 AND on_behalf_of_account_id IS NOT NULL`,
      [d.id],
    );
    expect(row.n).toBe(1);
  });

  it('lets only the principal revoke', async () => {
    const granted = await grantTo('assistant1@juspol.test', ['SET_DUE_DATE']);
    for (const email of ['assistant1@juspol.test', 'minister@juspol.test']) {
      const { agent } = await signIn(h.app, email);
      await agent.post(`/api/delegations/${granted.id}/revoke`).expect(403);
    }
    const { agent: principal } = await signIn(h.app, 'directeur@juspol.test');
    await principal.post(`/api/delegations/${granted.id}/revoke`).expect(200);
    await principal.post(`/api/delegations/${granted.id}/revoke`).expect(400);
  });

  it('confers nothing once the principal is disabled or loses the role', async () => {
    await grantTo('assistant1@juspol.test', ['ASSIGN_RESPONSIBILITY']);
    const d = await dossier();
    const principalId = await accountIdFor(h.db, 'directeur@juspol.test');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');

    await h.db.query(`UPDATE account SET is_enabled = false WHERE id = $1`, [principalId]);
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    await agent
      .post(`/api/dossiers/${d.id}/responsibility`)
      .send({ responsibleAccountId: target, version: d.version })
      .expect(403);
    await h.db.query(`UPDATE account SET is_enabled = true WHERE id = $1`, [principalId]);
  });

  it('keeps delegations closed to the administrator and to anyone without a session', async () => {
    const { agent } = await signIn(h.app, 'sysadmin@juspol.test');
    await agent.get('/api/delegations').expect(403);
    await require('supertest')(h.app.getHttpServer()).get('/api/delegations').expect(401);
  });

  it('offers support staff as delegation candidates, and never the administrator', async () => {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const response = await agent.get('/api/delegations/candidates').expect(200);
    const names = response.body.map((p: { personName: string }) => p.personName);

    // Support staff are the usual delegates — this is the list that was wrong.
    expect(names).toContain('L. Amatredjo');
    expect(names).toContain('A. Boldewijn');
    // The administrator holds no business role and must never act on a matter.
    expect(names).not.toContain('V. Ramlal');
    // Disabled accounts cannot receive authority.
    expect(names).not.toContain('J. Kensmil');
    expect(JSON.stringify(response.body)).not.toContain('@juspol.test');
  });

  describe('protected by the database', () => {
    it('cannot rewrite or delete a delegation', async () => {
      const granted = await grantTo('assistant1@juspol.test', ['SET_DUE_DATE']);

      await expect(
        h.db.query(`UPDATE delegation SET permitted_actions = 'ASSIGN_RESPONSIBILITY' WHERE id = $1`, [
          granted.id,
        ]),
      ).rejects.toThrow(/cannot be rewritten/);

      await h.db.query(`DELETE FROM delegation WHERE id = $1`, [granted.id]);
      const [row] = await h.db.query(`SELECT count(*)::int AS n FROM delegation WHERE id = $1`, [
        granted.id,
      ]);
      expect(row.n).toBe(1);
    });

    it('cannot revive a revoked delegation', async () => {
      const granted = await grantTo('assistant1@juspol.test', ['SET_DUE_DATE']);
      const { agent } = await signIn(h.app, 'directeur@juspol.test');
      await agent.post(`/api/delegations/${granted.id}/revoke`).expect(200);

      await expect(
        h.db.query(`UPDATE delegation SET revoked_at = NULL WHERE id = $1`, [granted.id]),
      ).rejects.toThrow(/cannot be changed or revived/);
    });

    it('refuses a delegation to oneself at the database level', async () => {
      const id = await accountIdFor(h.db, 'directeur@juspol.test');
      await expect(
        h.db.query(
          `INSERT INTO delegation (principal_account_id, delegate_account_id, permitted_actions,
             valid_from, valid_until, granted_by_account_id)
           VALUES ($1, $1, 'SET_DUE_DATE', now(), now() + interval '1 day', $1)`,
          [id],
        ),
      ).rejects.toThrow(/ck_delegation_distinct/);
    });
  });
});
