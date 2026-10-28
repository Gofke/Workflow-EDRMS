import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/**
 * Approval routes, advice requests and stand-ins.
 */
describe('Phase 3 approvals', () => {
  let h: Harness;
  let routeId: string;
  beforeAll(async () => {
    h = await startHarness();
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    // A second Directeur would make the next step ambiguous; the seed has one of each.
    routeId = (
      await admin
        .post('/api/approval-routes')
        .send({
          name: 'Ministeriële brief',
          steps: [
            { role: 'ONDER_DIRECTEUR', label: 'Inhoudelijke toets' },
            { role: 'DIRECTEUR', label: 'Akkoord Directeur' },
            { role: 'MINISTER', label: 'Ondertekening Minister' },
          ],
        })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await h.close();
  });

  const version = async (id: string) => (await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [id]))[0].version as number;

  async function preparedMatter(subject: string) {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (await agent.post('/api/dossiers').send({ subject }).expect(201)).body;
    const draft = (await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject: `Stuk ${subject}` }).expect(201)).body;
    const item = (await agent.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)).body;
    await agent.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: item.id }).expect(200);
    return { agent, dossier };
  }

  it('takes a matter through three steps, each decided by the designated reviewer, ending in approval', async () => {
    const { agent: clerk, dossier } = await preparedMatter('Route in drie stappen');
    const odir = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    const dualrole = await accountIdFor(h.db, 'dualrole@juspol.test');
    // The first reviewer must hold the first step's role.
    await clerk.post(`/api/dossiers/${dossier.id}/route/submit`).send({ routeId, reviewerAccountId: await accountIdFor(h.db, 'directeur@juspol.test'), version: await version(dossier.id) }).expect(400);
    const submitted = (await clerk.post(`/api/dossiers/${dossier.id}/route/submit`).send({ routeId, reviewerAccountId: odir, version: await version(dossier.id) }).expect(200)).body;
    expect(submitted.route.steps.map((s: { status: string }) => s.status)).toEqual(['CURRENT', 'PENDING', 'PENDING']);

    // Someone else holding the role cannot decide the step.
    const { agent: other } = await signIn(h.app, 'dualrole@juspol.test');
    await other.post(`/api/dossiers/${dossier.id}/route/approve`).send({ version: await version(dossier.id) }).expect(403);
    void dualrole;

    const { agent: onder } = await signIn(h.app, 'onderdirecteur@juspol.test');
    const step1 = (await onder.post(`/api/dossiers/${dossier.id}/route/approve`).send({ version: await version(dossier.id), note: 'Inhoudelijk juist' }).expect(200)).body;
    expect(step1.processingState).toBe('UNDER_REVIEW');
    expect(step1.route.steps.map((s: { status: string }) => s.status)).toEqual(['DONE', 'CURRENT', 'PENDING']);
    expect(step1.route.currentReviewerName).toBe('M. Sardjoe');
    await expectAuditEvent(h.db, 'ROUTE_STEP_APPROVED', 'Inhoudelijke toets');

    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    const queue = (await dir.get('/api/dossiers/review-queue').expect(200)).body;
    expect(queue.map((q: { dossierId: string }) => q.dossierId)).toContain(dossier.id);
    const step2 = (await dir.post(`/api/dossiers/${dossier.id}/route/approve`).send({ version: await version(dossier.id) }).expect(200)).body;
    expect(step2.route.currentReviewerName).toBe('R. Dijkstra');

    const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
    const final = (await minister.post(`/api/dossiers/${dossier.id}/route/approve`).send({ version: await version(dossier.id) }).expect(200)).body;
    expect(final.processingState).toBe('APPROVED');
    expect(final.route.steps.map((s: { status: string }) => s.status)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(final.route.completedAt).not.toBeNull();
    const timeline = (await minister.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    expect(timeline.filter((e: { kind: string }) => e.kind === 'ROUTE_STEP_APPROVED')).toHaveLength(2);
    expect(timeline.filter((e: { kind: string }) => e.kind === 'APPROVED')).toHaveLength(1);
    const [notified] = await h.db.query(`SELECT 1 FROM notification n JOIN account a ON a.id = n.account_id WHERE a.email = 'minister@juspol.test' AND n.kind = 'REVIEW_REQUESTED' AND n.subject_id = $1`, [dossier.id]);
    expect(notified).toBeTruthy();
  });

  it('refuses to pass on a matter that changed after it was submitted', async () => {
    const { agent: clerk, dossier } = await preparedMatter('Gewijzigd tijdens route');
    const odir = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await clerk.post(`/api/dossiers/${dossier.id}/route/submit`).send({ routeId, reviewerAccountId: odir, version: await version(dossier.id) }).expect(200);
    const draft = (await clerk.post('/api/records/drafts').send({ direction: 'INCOMING', subject: 'Later bijgevoegd' }).expect(201)).body;
    const item = (await clerk.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)).body;
    await clerk.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: item.id }).expect(200);
    const { agent: onder } = await signIn(h.app, 'onderdirecteur@juspol.test');
    await onder.post(`/api/dossiers/${dossier.id}/route/approve`).send({ version: await version(dossier.id) }).expect(409);
  });

  it('restarts the route from the first step after a return', async () => {
    const { agent: clerk, dossier } = await preparedMatter('Teruggestuurd onderweg');
    const odir = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    await clerk.post(`/api/dossiers/${dossier.id}/route/submit`).send({ routeId, reviewerAccountId: odir, version: await version(dossier.id) }).expect(200);
    const { agent: onder } = await signIn(h.app, 'onderdirecteur@juspol.test');
    await onder.post(`/api/dossiers/${dossier.id}/route/approve`).send({ version: await version(dossier.id) }).expect(200);
    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    await dir.post(`/api/dossiers/${dossier.id}/return`).send({ reason: 'Juridische onderbouwing ontbreekt', version: await version(dossier.id) }).expect(200);
    const returned = (await clerk.get(`/api/dossiers/${dossier.id}/route`).expect(200)).body;
    expect(returned.endedReason).toBe('RETURNED');
    const again = (await clerk.post(`/api/dossiers/${dossier.id}/route/submit`).send({ routeId, reviewerAccountId: odir, version: await version(dossier.id) }).expect(200)).body;
    expect(again.route.steps.map((s: { status: string }) => s.status)).toEqual(['CURRENT', 'PENDING', 'PENDING']);
  });

  it('asks another person for advice, gives them access, and records the answer', async () => {
    const { agent: clerk } = await signIn(h.app, 'assistant2@juspol.test');
    const dossier = (await clerk.post('/api/dossiers').send({ subject: 'Vertrouwelijk advies', classification: 'CONFIDENTIAL' }).expect(201)).body;
    const outsiderEmail = 'assistant1@juspol.test'; // another unit, no clearance
    const outsider = await accountIdFor(h.db, outsiderEmail);
    const { agent: out } = await signIn(h.app, outsiderEmail);
    await out.get(`/api/dossiers/${dossier.id}/timeline`).expect(404);
    const advice = (await clerk.post(`/api/dossiers/${dossier.id}/advice`).send({ requestedFromAccountId: outsider, question: 'Is dit juridisch houdbaar?' }).expect(201)).body;
    expect(advice.status).toBe('OPEN');
    // The person asked can now open the matter, because the request relates them to it.
    await out.get(`/api/dossiers/${dossier.id}/timeline`).expect(200);
    const mine = (await out.get('/api/advice/mine').expect(200)).body;
    expect(mine[0].dossierIdentity).toBe(dossier.dossierIdentity);
    await clerk.post(`/api/advice/${advice.id}/answer`).send({ answer: 'x' }).expect(403);
    const answered = (await out.post(`/api/advice/${advice.id}/answer`).send({ answer: 'Ja, op grond van artikel 12.' }).expect(200)).body;
    expect(answered.status).toBe('ANSWERED');
    await out.post(`/api/advice/${advice.id}/answer`).send({ answer: 'nog eens' }).expect(400);
    await expect(h.db.query(`UPDATE advice_request SET answer = 'herschreven' WHERE id = $1`, [advice.id])).rejects.toThrow(/cannot be changed/);
    const requester = await accountIdFor(h.db, 'assistant2@juspol.test');
    const [given] = await h.db.query(`SELECT 1 FROM notification WHERE account_id = $1 AND kind = 'ADVICE_GIVEN'`, [requester]);
    expect(given).toBeTruthy();
    const timeline = (await clerk.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    expect(timeline.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['ADVICE_REQUESTED', 'ADVICE_GIVEN']));
  });

  it('can hold a submission until open advice is in, when configured', async () => {
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    await admin.put('/api/settings/workflow').send({ value: { blockSubmitWithOpenAdvice: true } }).expect(200);
    const { agent: clerk, dossier } = await preparedMatter('Wacht op advies');
    const advice = (await clerk.post(`/api/dossiers/${dossier.id}/advice`).send({ requestedFromAccountId: await accountIdFor(h.db, 'onderdirecteur@juspol.test'), question: 'Uw mening?' }).expect(201)).body;
    const directeur = await accountIdFor(h.db, 'directeur@juspol.test');
    await clerk.post(`/api/dossiers/${dossier.id}/submit`).send({ reviewerAccountId: directeur, version: await version(dossier.id) }).expect(400);
    await clerk.post(`/api/advice/${advice.id}/withdraw`).send({ reason: 'Niet meer nodig' }).expect(200);
    await clerk.post(`/api/dossiers/${dossier.id}/submit`).send({ reviewerAccountId: directeur, version: await version(dossier.id) }).expect(200);
    await admin.put('/api/settings/workflow').send({ value: { blockSubmitWithOpenAdvice: false } }).expect(200);
  });

  it('sets an absence with a stand-in, who receives the delegatable authority for the period', async () => {
    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    const standIn = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const until = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
    const absence = (await dir.post('/api/out-of-office').send({ startsOn: today, endsOn: until, standInAccountId: standIn, message: 'Dienstreis Nickerie' }).expect(201)).body;
    expect(absence.delegationId).toBeTruthy();
    await expectAuditEvent(h.db, 'OUT_OF_OFFICE_SET', 'stands in with delegated authority');
    const [delegation] = await h.db.query(`SELECT delegate_account_id, revoked_at FROM delegation WHERE id = $1`, [absence.delegationId]);
    expect(delegation.delegate_account_id).toBe(standIn);
    const { agent: onder } = await signIn(h.app, 'onderdirecteur@juspol.test');
    const standing = (await onder.get('/api/out-of-office/standing-in').expect(200)).body;
    expect(standing[0].absentName).toBe('M. Sardjoe');
    const [note] = await h.db.query(`SELECT title FROM notification WHERE account_id = $1 AND kind = 'OUT_OF_OFFICE'`, [standIn]);
    expect(note.title).toContain('M. Sardjoe');
    await dir.post('/api/out-of-office').send({ startsOn: today, endsOn: until, standInAccountId: standIn }).expect(400);
    await dir.post(`/api/out-of-office/${absence.id}/end`).expect(200);
    const [after] = await h.db.query(`SELECT revoked_at FROM delegation WHERE id = $1`, [absence.delegationId]);
    expect(after.revoked_at).not.toBeNull();
    // Support staff have no authority to pass on: the absence carries no delegation.
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    const plain = (await clerk.post('/api/out-of-office').send({ startsOn: today, endsOn: until, standInAccountId: await accountIdFor(h.db, 'assistant2@juspol.test') }).expect(201)).body;
    expect(plain.delegationId).toBeNull();
  });
});
