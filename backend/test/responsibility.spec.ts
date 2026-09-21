import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/**
 * Responsibility and official due dates (FR-OWN).
 *
 * The three failures this guards against are the ones TS-04 names as
 * invalidating: ambiguous or dual responsibility, a change that loses the
 * previous owner, and a deadline that can move without a trace.
 */
describe('Responsibility and due dates', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function newDossier(subject: string) {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const created = await agent.post('/api/dossiers').send({ subject }).expect(201);
    return { agent, dossier: created.body };
  }

  it('assigns responsibility and shows the current owner', async () => {
    const { agent, dossier } = await newDossier('Assignment matter');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');

    const updated = await agent
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({ responsibleAccountId: target, version: dossier.version })
      .expect(200);

    expect(updated.body.responsibleName).toBe('A. Boldewijn');
    await expectAuditEvent(h.db, 'RESPONSIBILITY_ASSIGNED', 'A. Boldewijn');
  });

  /** FR-OWN-001: one unambiguous current owner, enforced by a partial index. */
  it('keeps exactly one live assignment after reassignment', async () => {
    const { agent, dossier } = await newDossier('Reassignment matter');
    const first = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    const second = await accountIdFor(h.db, 'minister@juspol.test');

    const afterFirst = await agent
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({ responsibleAccountId: first, version: dossier.version })
      .expect(200);
    const afterSecond = await agent
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({ responsibleAccountId: second, version: afterFirst.body.version })
      .expect(200);

    expect(afterSecond.body.responsibleName).toBe('R. Dijkstra');

    const [{ live }] = await h.db.query(
      `SELECT count(*)::int AS live FROM responsibility_assignment
        WHERE dossier_id = $1 AND superseded_at IS NULL`,
      [dossier.id],
    );
    expect(live).toBe(1);

    // FR-OWN-003: the previous assignment survives, with its own actor and time.
    const history = await agent.get(`/api/dossiers/${dossier.id}/history`).expect(200);
    expect(history.body.responsibility).toHaveLength(2);
    expect(history.body.responsibility[0].responsibleName).toBe('A. Boldewijn');
    expect(history.body.responsibility[0].isCurrent).toBe(false);
    expect(history.body.responsibility[0].assignedByName).toBe('M. Sardjoe');
    expect(history.body.responsibility[1].isCurrent).toBe(true);
    await expectAuditEvent(h.db, 'RESPONSIBILITY_REASSIGNED', 'A. Boldewijn');
  });

  it('refuses a second live assignment inserted directly (FR-OWN-001)', async () => {
    const { agent, dossier } = await newDossier('Dual owner attempt');
    const first = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({ responsibleAccountId: first, version: dossier.version })
      .expect(200);

    await expect(
      h.db.query(
        `INSERT INTO responsibility_assignment (dossier_id, responsible_account_id, assigned_by_account_id)
         VALUES ($1, $2, $2)`,
        [dossier.id, first],
      ),
    ).rejects.toThrow(/ix_responsibility_one_current|duplicate key value/);
  });

  it('refuses responsibility for someone whose role cannot carry it', async () => {
    const { agent, dossier } = await newDossier('Ineligible target');
    for (const email of ['assistant1@juspol.test', 'sysadmin@juspol.test']) {
      const target = await accountIdFor(h.db, email);
      const response = await agent
        .post(`/api/dossiers/${dossier.id}/responsibility`)
        .send({ responsibleAccountId: target, version: dossier.version })
        .expect(400);
      expect(response.body.message).toContain('role');
    }
  });

  it('refuses responsibility for a disabled account', async () => {
    const { agent, dossier } = await newDossier('Disabled target');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await h.db.query(`UPDATE account SET is_enabled = false WHERE id = $1`, [target]);

    const response = await agent
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({ responsibleAccountId: target, version: dossier.version })
      .expect(400);
    expect(response.body.message).toContain('disabled');
    await h.db.query(`UPDATE account SET is_enabled = true WHERE id = $1`, [target]);
  });

  it('refuses support staff and the administrator as assigners (FR-SEC-008, FR-DEL-005)', async () => {
    const { dossier } = await newDossier('Assigner authority');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');

    for (const email of ['assistant1@juspol.test', 'sysadmin@juspol.test']) {
      const { agent } = await signIn(h.app, email);
      await agent
        .post(`/api/dossiers/${dossier.id}/responsibility`)
        .send({ responsibleAccountId: target, version: dossier.version })
        .expect(403);
    }
  });

  it('sets a first due date without a reason, then requires one to change it (DEC-12)', async () => {
    const { agent, dossier } = await newDossier('Deadline matter');

    const set = await agent
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({ dueDate: '2026-10-15', version: dossier.version })
      .expect(200);
    expect(set.body.dueDate).toBe('2026-10-15');
    await expectAuditEvent(h.db, 'DUE_DATE_SET', dossier.dossierIdentity);

    const refused = await agent
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({ dueDate: '2026-11-30', version: set.body.version })
      .expect(400);
    expect(refused.body.message).toContain('reason');

    const changed = await agent
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({
        dueDate: '2026-11-30',
        reason: 'Extension granted by the Directeur pending legal advice.',
        version: set.body.version,
      })
      .expect(200);
    expect(changed.body.dueDate).toBe('2026-11-30');

    // FR-OWN-006: old value, new value, actor, time and reason all preserved.
    const history = await agent.get(`/api/dossiers/${dossier.id}/history`).expect(200);
    expect(history.body.dueDates).toHaveLength(2);
    expect(history.body.dueDates[1]).toMatchObject({
      previousDueDate: '2026-10-15',
      newDueDate: '2026-11-30',
      changedByName: 'M. Sardjoe',
    });
    expect(history.body.dueDates[1].reason).toContain('Extension granted');
  });

  it('records removal of a due date as an event, not an erasure', async () => {
    const { agent, dossier } = await newDossier('Deadline removal');
    const set = await agent
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({ dueDate: '2026-10-15', version: dossier.version })
      .expect(200);

    const removed = await agent
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({ dueDate: null, reason: 'No statutory deadline applies.', version: set.body.version })
      .expect(200);
    expect(removed.body.dueDate).toBeNull();

    const history = await agent.get(`/api/dossiers/${dossier.id}/history`).expect(200);
    expect(history.body.dueDates[1]).toMatchObject({
      previousDueDate: '2026-10-15',
      newDueDate: null,
    });
  });

  it('applies the DEC-05 version check to both actions', async () => {
    const { agent, dossier } = await newDossier('Stale writes');
    const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await agent
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({ responsibleAccountId: target, version: dossier.version })
      .expect(200);

    // Both now present a version that has moved on.
    await agent
      .post(`/api/dossiers/${dossier.id}/responsibility`)
      .send({ responsibleAccountId: await accountIdFor(h.db, 'minister@juspol.test'), version: dossier.version })
      .expect(409);
    await agent
      .post(`/api/dossiers/${dossier.id}/due-date`)
      .send({ dueDate: '2026-12-01', version: dossier.version })
      .expect(409);
  });

  it('offers the assignment picker only to assigners, with names and no email addresses', async () => {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const response = await agent.get('/api/dossiers/assignable-officials').expect(200);

    const names = response.body.map((p: { personName: string }) => p.personName);
    expect(names).toContain('A. Boldewijn');
    expect(names).toContain('R. Dijkstra');
    // Support staff and the administrator cannot carry responsibility, so they
    // are not offered.
    expect(names).not.toContain('L. Amatredjo');
    expect(names).not.toContain('V. Ramlal');
    // An assigner needs a name to pick, not the account register.
    expect(JSON.stringify(response.body)).not.toContain('@juspol.test');

    const { agent: support } = await signIn(h.app, 'assistant1@juspol.test');
    await support.get('/api/dossiers/assignable-officials').expect(403);
  });

  describe('history protected by the database', () => {
    it('cannot rewrite an assignment record', async () => {
      const { agent, dossier } = await newDossier('Rewrite attempt');
      const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
      await agent
        .post(`/api/dossiers/${dossier.id}/responsibility`)
        .send({ responsibleAccountId: target, version: dossier.version })
        .expect(200);

      await expect(
        h.db.query(
          `UPDATE responsibility_assignment SET responsible_account_id = $1 WHERE dossier_id = $2`,
          [await accountIdFor(h.db, 'minister@juspol.test'), dossier.id],
        ),
      ).rejects.toThrow(/cannot be rewritten/);
    });

    it('cannot delete an assignment record', async () => {
      const { agent, dossier } = await newDossier('Delete attempt');
      const target = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
      await agent
        .post(`/api/dossiers/${dossier.id}/responsibility`)
        .send({ responsibleAccountId: target, version: dossier.version })
        .expect(200);

      await h.db.query(`DELETE FROM responsibility_assignment WHERE dossier_id = $1`, [dossier.id]);
      const [{ n }] = await h.db.query(
        `SELECT count(*)::int AS n FROM responsibility_assignment WHERE dossier_id = $1`,
        [dossier.id],
      );
      expect(n).toBe(1);
    });

    it('discards edits and deletes against due-date history', async () => {
      const { agent, dossier } = await newDossier('Due date history');
      await agent
        .post(`/api/dossiers/${dossier.id}/due-date`)
        .send({ dueDate: '2026-10-15', version: dossier.version })
        .expect(200);

      await h.db.query(`UPDATE due_date_change SET new_due_date = '2030-01-01'`);
      await h.db.query(`DELETE FROM due_date_change WHERE dossier_id = $1`, [dossier.id]);

      const [row] = await h.db.query(
        `SELECT new_due_date::text FROM due_date_change WHERE dossier_id = $1`,
        [dossier.id],
      );
      expect(row.new_due_date).toBe('2026-10-15');
    });

    /** The current value cannot drift away from its own history. */
    it('refuses a due-date move with no history row behind it', async () => {
      const { dossier } = await newDossier('Untraced move');
      await expect(
        h.db.query(`UPDATE dossier SET due_date = '2027-01-01' WHERE id = $1`, [dossier.id]),
      ).rejects.toThrow(/must be recorded in due_date_change first/);
    });
  });
});
