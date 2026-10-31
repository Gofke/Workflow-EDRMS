import request from 'supertest';
import { todayInSuriname } from '../src/common/actor';
import { progressOf } from '../src/projects/projects.service';
import { accountIdFor, expectAuditEvent, Harness, signIn, startHarness } from './harness';

type Agent = ReturnType<typeof request.agent>;

/**
 * V0.5.0 — projects: owner, project manager, stakeholders and team; the
 * business case the owner approves; phases and tickets; and need-to-know
 * access (a team member sees their own tickets, the line of command a summary,
 * a confidential project only the people on it).
 */
describe('V0.5.0 projects', () => {
  let h: Harness;
  const as: Record<string, Agent> = {};
  const id: Record<string, string> = {};
  const day = (n: number) => {
    const d = new Date(`${todayInSuriname()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  let unitDir: string;
  let unitKab: string;
  let project: { id: string; version: number; milestones: { id: string; name: string; status: string }[] };
  const tickets: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness();
    for (const email of ['minister', 'directeur', 'onderdirecteur', 'assistant1', 'assistant2', 'unauthorised', 'dualrole', 'sysadmin']) {
      as[email] = (await signIn(h.app, `${email}@juspol.test`)).agent;
      id[email] = await accountIdFor(h.db, `${email}@juspol.test`);
    }
    [{ id: unitDir }] = await h.db.query(`SELECT id FROM organisational_unit WHERE code = 'HO-DIR'`);
    [{ id: unitKab }] = await h.db.query(`SELECT id FROM organisational_unit WHERE code = 'HO-KAB'`);
  });
  afterAll(async () => h.close());

  const reload = async () => {
    const res = await as.directeur.get(`/api/projects/${project.id}`).expect(200);
    project = res.body;
    return res.body;
  };

  it('progress: closed phases count in full, the current one by its finished tickets', () => {
    const t = (total: number, done: number) => ({ total, done, open: total - done, overdue: 0 });
    expect(progressOf([{ status: 'CLOSED', tickets: t(4, 4) }, { status: 'ACTIVE', tickets: t(4, 2) }, { status: 'PLANNED', tickets: t(0, 0) }, { status: 'PLANNED', tickets: t(0, 0) }], 'ACTIVE')).toBe(38);
    expect(progressOf([{ status: 'CLOSED', tickets: t(1, 1) }], 'COMPLETED')).toBe(100);
    expect(progressOf([], 'PROPOSED')).toBe(0);
  });

  it('only a decision-maker or the head of a unit starts a project, and only for their own line', async () => {
    const body = { name: 'Digitalisering strafregister', unitId: unitDir, managerAccountId: id.assistant2, startDate: day(0), endDate: day(120) };
    await as.assistant2.post('/api/projects').send(body).expect(403);
    await as.sysadmin.post('/api/projects').send(body).expect(403);
    await as.onderdirecteur.post('/api/projects').send({ ...body, unitId: unitKab }).expect(403);
  });

  it('a project starts with the four standard phases, the business case active, and tells the people on it', async () => {
    const res = await as.directeur
      .post('/api/projects')
      .send({
        name: 'Digitalisering strafregister',
        description: 'Het strafregister gaat van papier naar een beveiligd digitaal register.',
        unitId: unitDir,
        managerAccountId: id.assistant2,
        stakeholders: [id.dualrole],
        startDate: day(0),
        endDate: day(120),
      })
      .expect(201);
    project = res.body;
    expect(res.body.reference).toMatch(/^PRJ-\d{4}-001$/);
    expect(res.body.status).toBe('PROPOSED');
    expect(res.body.myRole).toBe('OWNER');
    expect(res.body.access).toBe('FULL');
    expect(res.body.milestones.map((m: { name: string }) => m.name)).toEqual(['Business case', 'Documentatie en ontwerp', 'Uitvoering', 'Afsluiting en overdracht']);
    expect(res.body.milestones.map((m: { status: string }) => m.status)).toEqual(['ACTIVE', 'PLANNED', 'PLANNED', 'PLANNED']);
    expect(res.body.milestones[0].gate).toBe('BUSINESS_CASE');
    expect(res.body.milestones[3].gate).toBe('CLOSURE');
    expect(res.body.milestones[3].endDate).toBe(day(120));
    const notes = await h.db.query(`SELECT account_id, kind FROM notification WHERE kind = 'PROJECT_ROLE'`);
    expect(notes.map((n: { account_id: string }) => n.account_id).sort()).toEqual([id.assistant2, id.dualrole].sort());
    await expectAuditEvent(h.db, 'PROJECT_CREATED', res.body.reference);
  });

  it('the project manager adds tickets; whoever holds one joins the team', async () => {
    const bc = project.milestones[0].id;
    const t1 = await as.assistant2
      .post(`/api/projects/${project.id}/tickets`)
      .send({ milestoneId: bc, title: 'Business case opstellen', assigneeAccountId: id.assistant2, startDate: day(0), dueDate: day(10) })
      .expect(201);
    const t2 = await as.assistant2
      .post(`/api/projects/${project.id}/tickets`)
      .send({ milestoneId: bc, title: 'Kosten raming opvragen', assigneeAccountId: id.unauthorised, startDate: day(1), dueDate: day(8), priority: 'HIGH' })
      .expect(201);
    tickets.write = t1.body.id;
    tickets.costs = t2.body.id;
    expect(t2.body.project.reference).toBe(project.id ? (await reload()).reference : '');
    expect(t2.body.startDate).toBe(day(1));
    const team = (await reload()).team as { accountId: string; role: string }[];
    expect(team.find((m) => m.accountId === id.unauthorised)?.role).toBe('MEMBER');
    expect(team.find((m) => m.accountId === id.dualrole)?.role).toBe('STAKEHOLDER');
    // Not the stakeholder, not a stranger.
    await as.dualrole.post(`/api/projects/${project.id}/tickets`).send({ milestoneId: bc, title: 'x', assigneeAccountId: id.dualrole }).expect(403);
    await as.assistant1.post(`/api/projects/${project.id}/tickets`).send({ milestoneId: bc, title: 'x', assigneeAccountId: id.assistant1 }).expect(404);
  });

  it('need-to-know: each person sees the project at their own level', async () => {
    const view = async (who: string) => as[who].get(`/api/projects/${project.id}`);
    const owner = (await view('directeur')).body;
    expect(owner.access).toBe('FULL');
    expect(owner.tickets).toHaveLength(2);

    const stakeholder = (await view('dualrole')).body;
    expect(stakeholder.access).toBe('OVERVIEW');
    expect(stakeholder.businessCase).toHaveProperty('problem');
    expect(stakeholder.team.length).toBeGreaterThan(0);
    expect(stakeholder.tickets).toHaveLength(0);

    const member = (await view('unauthorised')).body;
    expect(member.access).toBe('MEMBER');
    expect(member.tickets.map((t: { id: string }) => t.id)).toEqual([tickets.costs]);
    expect(member.businessCase).toEqual({ status: 'DRAFT' });
    expect(member.team).toEqual([]);
    expect(member.events).toEqual([]);

    const minister = (await view('minister')).body;
    expect(minister.access).toBe('SUMMARY');
    expect(minister.tickets).toHaveLength(0);
    expect(minister.businessCase).toEqual({ status: 'DRAFT' });
    expect(minister.progress).toBe(0);
    expect(minister.tickets).toEqual([]);

    expect((await view('onderdirecteur')).body.access).toBe('SUMMARY');
    expect((await view('assistant1')).status).toBe(404);
    expect((await view('sysadmin')).status).toBe(403);
  });

  it('need-to-know reaches the tickets: the line of command does not open them, a team member opens only their own', async () => {
    await as.unauthorised.get(`/api/tasks/${tickets.costs}`).expect(200);
    await as.unauthorised.get(`/api/tasks/${tickets.write}`).expect(404);
    await as.minister.get(`/api/tasks/${tickets.costs}`).expect(404);
    await as.onderdirecteur.get(`/api/tasks/${tickets.costs}`).expect(404);
    await as.directeur.get(`/api/tasks/${tickets.costs}`).expect(200);
    const all = await as.minister.get('/api/tasks?scope=all&limit=500').expect(200);
    expect(all.body.data.map((t: { id: string }) => t.id)).not.toContain(tickets.costs);
    // The project manager may work on the ticket like its owner.
    const perms = (await as.assistant2.get(`/api/tasks/${tickets.costs}`).expect(200)).body.permissions;
    expect(perms.canEdit).toBe(true);
  });

  it('a confidential project is shown only to the people on it', async () => {
    const res = await as.directeur
      .post('/api/projects')
      .send({ name: 'Herinrichting getuigenbescherming', unitId: unitDir, managerAccountId: id.dualrole, classification: 'CONFIDENTIAL', startDate: day(0), endDate: day(60) })
      .expect(201);
    await as.minister.get(`/api/projects/${res.body.id}`).expect(404);
    await as.onderdirecteur.get(`/api/projects/${res.body.id}`).expect(404);
    await as.dualrole.get(`/api/projects/${res.body.id}`).expect(200);
    const list = await as.minister.get('/api/projects').expect(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([project.id]);
    expect(list.body.canCreate).toBe(true);
    const mine = await as.unauthorised.get('/api/projects?scope=mine').expect(200);
    expect(mine.body.data.map((p: { id: string }) => p.id)).toEqual([project.id]);
    expect(mine.body.canCreate).toBe(false);
  });

  it('the business case: written by the project manager, complete before it is submitted, with its phase finished', async () => {
    await reload();
    await as.assistant2.post(`/api/projects/${project.id}/business-case/submit`).send({ version: project.version }).expect(400);
    await as.assistant2
      .put(`/api/projects/${project.id}/business-case`)
      .send({ version: project.version, problem: 'Uittreksels duren drie weken.', solution: 'Digitaal register met koppeling aan de politie.', benefits: 'Uittreksel binnen een dag.', costs: 'SRD 2,4 mln over twee jaar.', risks: 'Datakwaliteit oude kaarten.', budget: 2400000 })
      .expect(200);
    await reload();
    const res = await as.assistant2.post(`/api/projects/${project.id}/business-case/submit`).send({ version: project.version }).expect(400);
    expect(res.body.message).toMatch(/open tickets? of the business case phase/);
    for (const t of [tickets.write, tickets.costs]) {
      const holder = t === tickets.write ? as.assistant2 : as.unauthorised;
      const v = (await holder.get(`/api/tasks/${t}`).expect(200)).body.task.version;
      await holder.post(`/api/tasks/${t}/complete`).send({ version: v }).expect(200);
    }
    await reload();
    await as.directeur.post(`/api/projects/${project.id}/business-case/submit`).send({ version: project.version }).expect(403);
    await as.assistant2.post(`/api/projects/${project.id}/business-case/submit`).send({ version: project.version }).expect(200);
    const [note] = await h.db.query(`SELECT account_id FROM notification WHERE kind = 'BUSINESS_CASE_SUBMITTED'`);
    expect(note.account_id).toBe(id.directeur);
  });

  it('only the owner decides; a return needs a reason; approval closes the business case phase and starts the next', async () => {
    await reload();
    await as.assistant2.post(`/api/projects/${project.id}/business-case/approve`).send({ version: project.version }).expect(403);
    await as.directeur.post(`/api/projects/${project.id}/business-case/return`).send({ version: project.version }).expect(400);
    await as.directeur.post(`/api/projects/${project.id}/business-case/return`).send({ version: project.version, reason: 'Graag de kosten per jaar uitsplitsen.' }).expect(200);
    await reload();
    expect(project).toMatchObject({ businessCaseStatus: 'RETURNED', status: 'PROPOSED' });
    await as.assistant2.put(`/api/projects/${project.id}/business-case`).send({ version: project.version, costs: '2027: SRD 1,4 mln; 2028: SRD 1,0 mln.' }).expect(200);
    await reload();
    await as.assistant2.post(`/api/projects/${project.id}/business-case/submit`).send({ version: project.version }).expect(200);
    await reload();
    const res = await as.directeur.post(`/api/projects/${project.id}/business-case/approve`).send({ version: project.version }).expect(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.businessCaseStatus).toBe('APPROVED');
    expect(res.body.milestones.map((m: { status: string }) => m.status)).toEqual(['CLOSED', 'ACTIVE', 'PLANNED', 'PLANNED']);
    expect(res.body.phase).toEqual({ position: 2, count: 4, name: 'Documentatie en ontwerp' });
    expect(res.body.progress).toBe(25);
    await expectAuditEvent(h.db, 'BUSINESS_CASE_RETURNED', 'kosten per jaar');
    await expectAuditEvent(h.db, 'BUSINESS_CASE_APPROVED', project.id ? res.body.reference : '');
    const decided = await h.db.query(`SELECT account_id FROM notification WHERE kind = 'BUSINESS_CASE_DECIDED'`);
    expect(decided.every((n: { account_id: string }) => n.account_id === id.assistant2)).toBe(true);
  });

  it('a phase closes only when its tickets are done; the closure is signed off by the owner and completes the project', async () => {
    project = await reload();
    const doc = project.milestones[1].id;
    const t = await as.assistant2
      .post(`/api/projects/${project.id}/tickets`)
      .send({ milestoneId: doc, title: 'Functioneel ontwerp', assigneeAccountId: id.unauthorised, startDate: day(2), dueDate: day(20) })
      .expect(201);
    await reload();
    await as.assistant2.post(`/api/projects/${project.id}/milestones/${doc}/close`).send({ version: project.version }).expect(400);
    // A member with open tickets cannot be taken off the project.
    await as.directeur.delete(`/api/projects/${project.id}/members/${id.unauthorised}`).expect(400);
    const v = (await as.unauthorised.get(`/api/tasks/${t.body.id}`)).body.task.version;
    await as.unauthorised.post(`/api/tasks/${t.body.id}/complete`).send({ version: v }).expect(200);
    await reload();
    await as.unauthorised.post(`/api/projects/${project.id}/milestones/${doc}/close`).send({ version: project.version }).expect(403);
    let res = await as.assistant2.post(`/api/projects/${project.id}/milestones/${doc}/close`).send({ version: project.version }).expect(200);
    expect(res.body.phase.position).toBe(3);
    res = await as.assistant2.post(`/api/projects/${project.id}/milestones/${project.milestones[2].id}/close`).send({ version: res.body.version }).expect(200);
    expect(res.body.phase.position).toBe(4);
    const closure = project.milestones[3].id;
    await as.assistant2.post(`/api/projects/${project.id}/milestones/${closure}/close`).send({ version: res.body.version }).expect(403);
    res = await as.directeur.post(`/api/projects/${project.id}/milestones/${closure}/close`).send({ version: res.body.version, note: 'Opgeleverd en overgedragen aan de griffie.' }).expect(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.progress).toBe(100);
    expect(res.body.permissions.canAddTickets).toBe(false);
    await expectAuditEvent(h.db, 'PROJECT_COMPLETED', res.body.reference);
    await as.assistant2.post(`/api/projects/${project.id}/tickets`).send({ milestoneId: closure, title: 'Na afloop', assigneeAccountId: id.assistant2 }).expect(400);
  });

  it('hold, resume and cancel are the owner\'s, with a reason', async () => {
    const res = await as.directeur
      .post('/api/projects')
      .send({ name: 'Wijkagenten opleiding', unitId: unitDir, managerAccountId: id.assistant2, startDate: day(0), endDate: day(40) })
      .expect(201);
    const pid = res.body.id;
    let v = res.body.version;
    await as.assistant2.post(`/api/projects/${pid}/status`).send({ action: 'HOLD', version: v, reason: 'x' }).expect(403);
    await as.directeur.post(`/api/projects/${pid}/status`).send({ action: 'HOLD', version: v }).expect(400);
    let r = await as.directeur.post(`/api/projects/${pid}/status`).send({ action: 'HOLD', version: v, reason: 'Wacht op begroting 2027.' }).expect(200);
    expect(r.body.status).toBe('ON_HOLD');
    v = r.body.version;
    await as.directeur.post(`/api/projects/${pid}/status`).send({ action: 'RESUME', version: v }).expect(400);
    r = await as.directeur.post(`/api/projects/${pid}/status`).send({ action: 'RESUME', version: v, reason: 'Begroting rond.' }).expect(200);
    expect(r.body.status).toBe('PROPOSED');
    r = await as.directeur.post(`/api/projects/${pid}/status`).send({ action: 'CANCEL', version: r.body.version, reason: 'Opgegaan in het landelijke programma.' }).expect(200);
    expect(r.body.status).toBe('CANCELLED');
    await expectAuditEvent(h.db, 'PROJECT_STATUS_CHANGED', 'landelijke programma');
  });

  it('stakeholders are appointed by the owner; the project manager adds team members', async () => {
    const res = await as.directeur
      .post('/api/projects')
      .send({ name: 'Vervanging radiosystemen', unitId: unitDir, managerAccountId: id.assistant2, startDate: day(0), endDate: day(200) })
      .expect(201);
    const pid = res.body.id;
    await as.assistant2.post(`/api/projects/${pid}/members`).send({ accountId: id.dualrole, role: 'STAKEHOLDER' }).expect(403);
    await as.assistant2.post(`/api/projects/${pid}/members`).send({ accountId: id.unauthorised, role: 'MEMBER' }).expect(200);
    await as.directeur.post(`/api/projects/${pid}/members`).send({ accountId: id.dualrole, role: 'STAKEHOLDER' }).expect(200);
    await as.directeur.post(`/api/projects/${pid}/members`).send({ accountId: id.sysadmin, role: 'MEMBER' }).expect(400);
    const r = await as.assistant2.delete(`/api/projects/${pid}/members/${id.unauthorised}`).expect(200);
    expect(r.body.team.map((m: { accountId: string }) => m.accountId)).toEqual([id.dualrole]);
    await expectAuditEvent(h.db, 'PROJECT_MEMBER_REMOVED');
  });

  it('own phases: between 3 and 8, the first is the business case and the last the closure', async () => {
    const base = { name: 'Bewustwordingscampagne huiselijk geweld', unitId: unitDir, managerAccountId: id.assistant2, startDate: day(0), endDate: day(90) };
    await as.directeur.post('/api/projects').send({ ...base, milestones: [{ name: 'Alleen', startDate: day(0), endDate: day(90) }] }).expect(400);
    const res = await as.directeur
      .post('/api/projects')
      .send({
        ...base,
        milestones: [
          { name: 'Business case', startDate: day(0), endDate: day(10) },
          { name: 'Campagne', startDate: day(11), endDate: day(80) },
          { name: 'Evaluatie', startDate: day(81), endDate: day(90) },
        ],
      })
      .expect(201);
    expect(res.body.milestones.map((m: { gate: string | null }) => m.gate)).toEqual(['BUSINESS_CASE', null, 'CLOSURE']);
    const added = await as.assistant2.post(`/api/projects/${res.body.id}/milestones`).send({ name: 'Nameting', startDate: day(70), endDate: day(85) }).expect(201);
    expect(added.body.milestones.map((m: { name: string }) => m.name)).toEqual(['Business case', 'Campagne', 'Nameting', 'Evaluatie']);
  });
});
