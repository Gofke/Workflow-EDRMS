import request from 'supertest';
import { resetAssistantGate } from '../src/ai/agent/assistant.controller';
import { AssistantService } from '../src/ai/agent/assistant.service';
import { ChatModel, GenerateRequest, GenerateResponse } from '../src/ai/agent/types';
import { todayInSuriname } from '../src/common/actor';
import { WorkingDaysService } from '../src/core/working-days.service';
import { DeadlinesService } from '../src/deadlines/deadlines.service';
import { SETTING_DEFAULTS } from '../src/settings/settings.defaults';
import { accountIdFor, Harness, signIn, startHarness } from './harness';

type Agent = ReturnType<typeof request.agent>;

/** A model that follows a script and keeps everything it was sent (fakes only: no real model, no key). */
class ScriptModel implements ChatModel {
  readonly provider = 'fake';
  requests: Omit<GenerateRequest, 'signal'>[] = [];
  constructor(private readonly script: (req: GenerateRequest, round: number) => Partial<GenerateResponse>) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const { signal, ...rest } = req;
    void signal;
    this.requests.push(JSON.parse(JSON.stringify(rest)));
    return { text: '', calls: [], raw: null, model: req.model, inputTokens: 10, outputTokens: 5, ...this.script(req, this.requests.length) };
  }
  get seen(): string {
    return JSON.stringify(this.requests);
  }
}
/** What the tools returned to the model (tool descriptions contain example numbers). */
const toolResults = (m: ScriptModel) => JSON.stringify(m.requests.map((r) => r.entries.filter((e) => e.kind === 'results')));
const callThenEcho = (name: string, args: Record<string, unknown>) =>
  new ScriptModel((req, round) => {
    if (round === 1) return { calls: [{ name, args }] };
    const last = req.entries[req.entries.length - 1];
    return { text: JSON.stringify(last.kind === 'results' ? last.results.map((r) => r.response) : []) };
  });

/**
 * V0.5.0 — the independent review's findings, each kept as a test: project and
 * ticket data stay need-to-know through every other door (escalation, stand-ins,
 * subtasks, timelines, history, counts, the assistant's ordinary task tools), and
 * the project's own rules hold (separation of duties, roles, gates, handover).
 */
describe('V0.5.0 projects — need-to-know through every door', () => {
  let h: Harness;
  const as: Record<string, Agent> = {};
  const id: Record<string, string> = {};
  let unitDir: string;
  const day = (n: number) => {
    const d = new Date(`${todayInSuriname()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const svc = <T>(type: new (...args: never[]) => T): T => h.app.get(type as never);
  const make = async (name: string, extra: Record<string, unknown> = {}) =>
    (await as.directeur.post('/api/projects').send({ name, unitId: unitDir, managerAccountId: id.assistant2, startDate: day(0), endDate: day(120), ...extra }).expect(201)).body;
  const get = (who: string, pid: string) => as[who].get(`/api/projects/${pid}`);
  const ticket = async (pid: string, milestoneId: string, title: string, assignee: string, extra: Record<string, unknown> = {}) =>
    (await as.assistant2.post(`/api/projects/${pid}/tickets`).send({ milestoneId, title, assigneeAccountId: id[assignee], ...extra }).expect(201)).body;
  const writeCase = async (pid: string) => {
    const v = (await get('assistant2', pid)).body.version;
    await as.assistant2.put(`/api/projects/${pid}/business-case`).send({ version: v, problem: 'a', solution: 'b', benefits: 'c', costs: 'd' }).expect(200);
  };
  const submitAndApprove = async (pid: string) => {
    await writeCase(pid);
    let v = (await get('assistant2', pid)).body.version;
    await as.assistant2.post(`/api/projects/${pid}/business-case/submit`).send({ version: v }).expect(200);
    v = (await get('directeur', pid)).body.version;
    return (await as.directeur.post(`/api/projects/${pid}/business-case/approve`).send({ version: v }).expect(200)).body;
  };

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_API_KEY = 'test-key-not-a-real-key-0000';
    process.env.AI_MODEL = 'gemini-flash-latest';
    h = await startHarness();
    for (const who of ['minister', 'directeur', 'onderdirecteur', 'assistant1', 'assistant2', 'unauthorised', 'dualrole', 'sysadmin']) {
      as[who] = (await signIn(h.app, `${who}@juspol.test`)).agent;
      id[who] = await accountIdFor(h.db, `${who}@juspol.test`);
    }
    [{ id: unitDir }] = await h.db.query(`SELECT id FROM organisational_unit WHERE code = 'HO-DIR'`);
    const current = (await as.sysadmin.get('/api/settings').expect(200)).body.ai ?? SETTING_DEFAULTS.ai;
    await as.sysadmin.put('/api/settings/ai').send({ value: { ...current, features: { ...current.features, assistant: true } } }).expect(200);
  });
  afterAll(async () => {
    AssistantService.modelFactory = null;
    await h.close();
  });
  beforeEach(() => resetAssistantGate());

  it('an overdue ticket escalates to the project manager and then the owner, never up the line; the audit log names the number only', async () => {
    const p = await make('Geheim project ESC', { classification: 'CONFIDENTIAL' });
    const t = await ticket(p.id, p.milestones[0].id, 'TICKET-ESCALATIE-TITEL', 'unauthorised', { dueDate: day(30) });
    await h.db.query(`UPDATE organisational_unit SET head_account_id = $1, parent_unit_id = (SELECT id FROM organisational_unit WHERE code = 'HO-KAB') WHERE code = 'HO-DIR'`, [id.onderdirecteur]);
    await h.db.query(`UPDATE organisational_unit SET head_account_id = $1 WHERE code = 'HO-KAB'`, [id.minister]);
    try {
      const wd = svc(WorkingDaysService);
      const due = '2026-11-04';
      await h.db.query(`UPDATE task SET due_date = $2 WHERE id = $1`, [t.id, due]);
      await svc(DeadlinesService).run(await wd.addWorkingDays(due, 3));
      await svc(DeadlinesService).run(await wd.addWorkingDays(due, 12));
      const esc: { account_id: string }[] = await h.db.query(`SELECT account_id FROM notification WHERE kind = 'DEADLINE_ESCALATION' AND title LIKE '%TICKET-ESCALATIE-TITEL%'`);
      expect(esc.map((e) => e.account_id).sort()).toEqual([id.assistant2, id.directeur].sort());
      const audit = await h.db.query(`SELECT summary FROM audit_event WHERE event_type = 'DEADLINE_ESCALATED' AND summary LIKE $1`, [`%${t.reference}%`]);
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toContain('TICKET-ESCALATIE-TITEL');
    } finally {
      await h.db.query(`UPDATE organisational_unit SET head_account_id = NULL, parent_unit_id = NULL`);
    }
  });

  it('a stakeholder reads the history without ticket titles', async () => {
    const p = await make('Project historie', { stakeholders: [id.dualrole] });
    const t = await ticket(p.id, p.milestones[0].id, 'TICKET-TITEL-VOOR-HISTORIE', 'unauthorised');
    const s = (await get('dualrole', p.id).expect(200)).body;
    expect(s.access).toBe('OVERVIEW');
    expect(JSON.stringify(s.events)).toContain(t.reference);
    expect(JSON.stringify(s.events)).not.toContain('TICKET-TITEL-VOOR-HISTORIE');
  });

  it("only the owner changes a person's role; a removed stakeholder comes back through a ticket as a team member only", async () => {
    const p = await make('Project rollen', { stakeholders: [id.dualrole], classification: 'CONFIDENTIAL' });
    await writeCase(p.id);
    await as.assistant2.post(`/api/projects/${p.id}/members`).send({ accountId: id.dualrole, role: 'MEMBER' }).expect(403);
    expect((await get('dualrole', p.id)).body.access).toBe('OVERVIEW');
    await as.directeur.post(`/api/projects/${p.id}/members`).send({ accountId: id.dualrole, role: 'STAKEHOLDER' }).expect(400);

    await as.directeur.delete(`/api/projects/${p.id}/members/${id.dualrole}`).expect(200);
    await get('dualrole', p.id).expect(404);
    await ticket(p.id, p.milestones[0].id, 'Klein klusje', 'dualrole');
    const back = (await get('dualrole', p.id).expect(200)).body;
    expect(back.myRole).toBe('MEMBER');
    expect(back.businessCase.problem).toBeUndefined();
  });

  it('a replaced project manager loses the tickets; the new one takes them over; only the lead reassigns, with the person checked and audited', async () => {
    const p = await make('Project overdracht', { classification: 'CONFIDENTIAL' });
    const t = await ticket(p.id, p.milestones[0].id, 'TICKET-OVERDRACHT', 'unauthorised');
    const cur = (await get('directeur', p.id)).body;
    await as.directeur.put(`/api/projects/${p.id}`).send({ version: cur.version, managerAccountId: id.dualrole }).expect(200);
    await get('assistant2', p.id).expect(404);
    await as.assistant2.get(`/api/tasks/${t.id}`).expect(404);
    const [owner] = await h.db.query(`SELECT owner_account_id FROM task WHERE id = $1`, [t.id]);
    expect(owner.owner_account_id).toBe(id.dualrole);
    const handover = await h.db.query(`SELECT summary FROM audit_event WHERE event_type = 'PROJECT_UPDATED' AND summary LIKE '%project manager%→%' AND subject_description LIKE $1`, [`${p.reference}%`]);
    expect(handover).toHaveLength(1);

    // The holder cannot pass the ticket on; the project manager can, to a ministry account only.
    let v = (await as.unauthorised.get(`/api/tasks/${t.id}`).expect(200)).body.task.version;
    await as.unauthorised.put(`/api/tasks/${t.id}`).send({ version: v, assigneeAccountId: id.assistant1 }).expect(403);
    v = (await as.dualrole.get(`/api/tasks/${t.id}`).expect(200)).body.task.version;
    await as.dualrole.put(`/api/tasks/${t.id}`).send({ version: v, assigneeAccountId: id.sysadmin }).expect(400);
    await as.dualrole.put(`/api/tasks/${t.id}`).send({ version: v, ownerAccountId: id.assistant1 }).expect(400);
    const before = (await h.db.query(`SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'PROJECT_MEMBER_ADDED'`))[0].n;
    await as.dualrole.put(`/api/tasks/${t.id}`).send({ version: v, assigneeAccountId: id.assistant1 }).expect(200);
    const after = (await h.db.query(`SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'PROJECT_MEMBER_ADDED'`))[0].n;
    expect(after).toBe(before + 1);
    expect((await get('assistant1', p.id).expect(200)).body.access).toBe('MEMBER');
  });

  it('the project manager writes the business case and every save is audited; owner and manager are two people', async () => {
    const p = await make('Project scheiding');
    await as.directeur.put(`/api/projects/${p.id}/business-case`).send({ version: p.version, problem: 'door de opdrachtgever' }).expect(403);
    const before = (await h.db.query(`SELECT count(*)::int AS n FROM audit_event WHERE subject_description LIKE $1`, [`${p.reference}%`]))[0].n;
    await as.assistant2.put(`/api/projects/${p.id}/business-case`).send({ version: p.version, problem: 'door de projectleider' }).expect(200);
    const saved = await h.db.query(`SELECT new_value FROM audit_event WHERE subject_description LIKE $1 ORDER BY occurred_at DESC LIMIT 1`, [`${p.reference}%`]);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM audit_event WHERE subject_description LIKE $1`, [`${p.reference}%`]))[0].n).toBe(before + 1);
    expect(saved[0].new_value).toContain('problem');
    await as.directeur.post('/api/projects').send({ name: 'Zelf goedkeuren', unitId: unitDir, managerAccountId: id.directeur, startDate: day(0), endDate: day(60) }).expect(400);
    const v = (await get('directeur', p.id)).body.version;
    await as.directeur.put(`/api/projects/${p.id}`).send({ version: v, managerAccountId: id.directeur }).expect(400);
  });

  it('the phase rules hold: no ticket after submission, no phase after the closure starts, nothing changes on a closed project, a reopened ticket needs an open phase', async () => {
    const p = await make('Project fasen', {
      milestones: [
        { name: 'BC', startDate: day(0), endDate: day(10) },
        { name: 'Werk', startDate: day(11), endDate: day(50) },
        { name: 'Afsluiting', startDate: day(51), endDate: day(120) },
      ],
    });
    const done = await ticket(p.id, p.milestones[0].id, 'Haalbaarheid', 'unauthorised');
    let v = (await as.unauthorised.get(`/api/tasks/${done.id}`)).body.task.version;
    await as.unauthorised.post(`/api/tasks/${done.id}/complete`).send({ version: v }).expect(200);
    await writeCase(p.id);
    v = (await get('assistant2', p.id)).body.version;
    await as.assistant2.post(`/api/projects/${p.id}/business-case/submit`).send({ version: v }).expect(200);
    await as.assistant2.post(`/api/projects/${p.id}/tickets`).send({ milestoneId: p.milestones[0].id, title: 'Na indienen', assigneeAccountId: id.unauthorised }).expect(400);
    v = (await get('directeur', p.id)).body.version;
    let r = (await as.directeur.post(`/api/projects/${p.id}/business-case/approve`).send({ version: v }).expect(200)).body;
    // The business case phase is closed: its ticket cannot be reopened.
    v = (await as.assistant2.get(`/api/tasks/${done.id}`)).body.task.version;
    await as.assistant2.post(`/api/tasks/${done.id}/status`).send({ status: 'IN_PROGRESS', version: v }).expect(400);
    r = (await as.assistant2.post(`/api/projects/${p.id}/milestones/${r.milestones[1].id}/close`).send({ version: r.version }).expect(200)).body;
    await as.assistant2.post(`/api/projects/${p.id}/milestones`).send({ name: 'Extra fase', startDate: day(60), endDate: day(70) }).expect(400);

    const c = await make('Project gestopt');
    const open = await ticket(c.id, c.milestones[0].id, 'Loopt nog', 'unauthorised');
    await as.directeur.post(`/api/projects/${c.id}/status`).send({ action: 'CANCEL', version: c.version }).expect(400);
    const cancelled = (await as.directeur.post(`/api/projects/${c.id}/status`).send({ action: 'CANCEL', version: c.version, reason: 'Vervallen.' }).expect(200)).body;
    const [{ status }] = await h.db.query(`SELECT status FROM task WHERE id = $1`, [open.id]);
    expect(status).toBe('CANCELLED');
    const res = await as.assistant2.put(`/api/projects/${c.id}/milestones/${cancelled.milestones[2].id}`).send({ version: cancelled.version, name: 'Na annulering' }).expect(400);
    expect(res.body.message).toMatch(/closed/);
  });

  it("the assistant's ordinary task tools treat a confidential project's tickets as restricted", async () => {
    const p = await make('VERTROUWELIJK-PROJ-R9', { classification: 'CONFIDENTIAL' });
    const t = await ticket(p.id, p.milestones[0].id, 'R9-TICKET-TITEL', 'unauthorised', { dueDate: day(3) });
    let m = callThenEcho('list_records', { kind: 'tasks' });
    AssistantService.modelFactory = () => m;
    await as.directeur.post('/api/v1/ai/query').send({ question: 'Welke taken zijn er?', history: [], lang: 'nl' }).expect(200);
    expect(toolResults(m)).toContain('"kind":"results"');
    expect(toolResults(m)).not.toContain(t.reference);
    m = callThenEcho('my_work', {});
    AssistantService.modelFactory = () => m;
    await as.unauthorised.post('/api/v1/ai/query').send({ question: 'Wat wacht op mij?', history: [], lang: 'nl' }).expect(200);
    expect(toolResults(m)).not.toContain(t.reference);
    m = callThenEcho('find_record', { reference: t.reference });
    AssistantService.modelFactory = () => m;
    await as.unauthorised.post('/api/v1/ai/query').send({ question: `Hoe staat ${t.reference}?`, history: [], lang: 'nl' }).expect(200);
    const last = m.requests[m.requests.length - 1];
    expect(JSON.stringify(last.entries[last.entries.length - 1])).toContain('"restricted":true');

    process.env.AI_TIER = 'paid';
    const current = (await as.sysadmin.get('/api/settings').expect(200)).body.ai;
    await as.sysadmin.put('/api/settings/ai').send({ value: { ...current, dataPolicy: 'records' } }).expect(200);
    try {
      m = callThenEcho('list_records', { kind: 'tasks' });
      AssistantService.modelFactory = () => m;
      await as.directeur.post('/api/v1/ai/query').send({ question: 'Welke taken zijn er?', history: [], lang: 'nl' }).expect(200);
      expect(m.seen).not.toContain('R9-TICKET-TITEL');
    } finally {
      await as.sysadmin.put('/api/settings/ai').send({ value: { ...current, dataPolicy: 'metadata' } }).expect(200);
      delete process.env.AI_TIER;
    }
  });

  it('phase names, written by people, stay away from the model under the metadata policy', async () => {
    const p = await make('Project fasenaam', {
      milestones: [
        { name: 'Business case', startDate: day(0), endDate: day(10) },
        { name: 'FASE-NAAM-AANKOOP-CAMERAS', startDate: day(11), endDate: day(50) },
        { name: 'Afsluiting', startDate: day(51), endDate: day(120) },
      ],
    });
    const m = callThenEcho('project_detail', { project: p.reference });
    AssistantService.modelFactory = () => m;
    const res = await as.directeur.post('/api/v1/ai/query').send({ question: 'Status?', history: [], lang: 'nl' }).expect(200);
    expect(m.seen).not.toContain('FASE-NAAM-AANKOOP');
    expect(JSON.parse(res.body.data.answer)[0].phases).toHaveLength(3);
  });

  it('a stand-in gets no copy of project or ticket notifications', async () => {
    await h.db.query(`INSERT INTO out_of_office (account_id, starts_on, ends_on, stand_in_account_id, message) VALUES ($1, current_date - 1, current_date + 5, $2, 'weg')`, [id.unauthorised, id.assistant1]);
    try {
      const p = await make('STANDIN-GEHEIM-PROJECTNAAM', { classification: 'CONFIDENTIAL', members: [id.unauthorised] });
      await ticket(p.id, p.milestones[0].id, 'STANDIN-TICKET-TITEL', 'unauthorised');
      const notes = await h.db.query(`SELECT title, body FROM notification WHERE account_id = $1`, [id.assistant1]);
      expect(JSON.stringify(notes)).not.toContain('STANDIN-GEHEIM-PROJECTNAAM');
      expect(JSON.stringify(notes)).not.toContain('STANDIN-TICKET-TITEL');
      // The absent person still gets their own.
      const own = await h.db.query(`SELECT title FROM notification WHERE account_id = $1 AND title LIKE '%STANDIN-TICKET-TITEL%'`, [id.unauthorised]);
      expect(own.length).toBeGreaterThan(0);
    } finally {
      await h.db.query(`UPDATE out_of_office SET ended_at = now()`);
    }
  });

  it('a subtask of a ticket stays in the project: only for people on it, never on a matter', async () => {
    const p = await make('SUBTAAK-GEHEIM-PROJECT', { classification: 'CONFIDENTIAL', members: [id.dualrole] });
    const t = await ticket(p.id, p.milestones[0].id, 'Hoofdticket', 'unauthorised');
    await as.unauthorised.post(`/api/tasks/${t.id}/subtasks`).send({ title: 'Help even', assigneeAccountId: id.assistant1 }).expect(400);
    await as.unauthorised.post(`/api/tasks/${t.id}/subtasks`).send({ title: 'Help even', assigneeAccountId: id.dualrole, audience: [id.assistant1] }).expect(400);
    const sub = (await as.unauthorised.post(`/api/tasks/${t.id}/subtasks`).send({ title: 'Help even', assigneeAccountId: id.dualrole }).expect(201)).body;
    expect(sub.project.id).toBe(p.id);
    // Someone who follows the ticket but may not add subtasks to it cannot add one;
    // a team member who does not follow it does not see it at all.
    await as.dualrole.post(`/api/tasks/${t.id}/subtasks`).send({ title: 'Ook nog', assigneeAccountId: id.dualrole }).expect(404);
    const tv = (await as.assistant2.get(`/api/tasks/${t.id}`).expect(200)).body.task.version;
    await as.assistant2.put(`/api/tasks/${t.id}`).send({ version: tv, audience: [id.dualrole] }).expect(200);
    await as.dualrole.post(`/api/tasks/${t.id}/subtasks`).send({ title: 'Ook nog', assigneeAccountId: id.dualrole }).expect(403);
    const dossier = (await as.unauthorised.post('/api/dossiers').send({ subject: 'Gewone zaak' }).expect(201)).body;
    await as.unauthorised.post(`/api/tasks/${t.id}/subtasks`).send({ title: 'Op een zaak', assigneeAccountId: id.unauthorised, dossierId: dossier.id }).expect(400);
    // And the database refuses it from any other client.
    await expect(h.db.query(`UPDATE task SET dossier_id = $2 WHERE id = $1`, [t.id, dossier.id])).rejects.toThrow(/task_ticket_stays_in_project/);
  });

  it('the line of command gets no free text; ministry-wide counts leave confidential tickets out; a bad member id is not found', async () => {
    const p = await make('Project tekst', { description: 'BESCHRIJVING-VRIJE-TEKST' });
    await as.directeur.delete(`/api/projects/${p.id}/members/not-a-uuid`).expect(404);
    const min = (await get('minister', p.id).expect(200)).body;
    expect(min.access).toBe('SUMMARY');
    expect(min.description).toBe('');
    const before = (await as.minister.get('/api/dashboard/overview').expect(200)).body.counts.openTasks;
    const c = await make('Teller', { classification: 'CONFIDENTIAL' });
    await ticket(c.id, c.milestones[0].id, 'Telt niet mee', 'unauthorised');
    const after = (await as.minister.get('/api/dashboard/overview').expect(200)).body.counts.openTasks;
    expect(after).toBe(before);
  });

  it('closing a phase counts open subtasks too', async () => {
    const p = await make('Project subtaken');
    const t = await ticket(p.id, p.milestones[0].id, 'Met subtaak', 'unauthorised');
    const sub = (await as.unauthorised.post(`/api/tasks/${t.id}/subtasks`).send({ title: 'Nog open', assigneeAccountId: id.unauthorised }).expect(201)).body;
    const v = (await as.unauthorised.get(`/api/tasks/${t.id}`)).body.task.version;
    await h.db.query(`UPDATE task SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [t.id]);
    void v;
    await writeCase(p.id);
    const pv = (await get('assistant2', p.id)).body.version;
    const res = await as.assistant2.post(`/api/projects/${p.id}/business-case/submit`).send({ version: pv }).expect(400);
    expect(res.body.message).toMatch(/1 open ticket/);
    await h.db.query(`UPDATE task SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [sub.id]);
    const approved = await submitAndApprove(p.id);
    expect(approved.status).toBe('ACTIVE');
  });
  // ---- found when the fixes above were verified

  it('a ticket does not repeat, so no copy is ever made outside the project', async () => {
    const p = await make('Herhaling GEHEIM', { classification: 'CONFIDENTIAL' });
    const t = await ticket(p.id, p.milestones[0].id, 'HERHAAL-TITEL', 'unauthorised', { dueDate: day(5) });
    const v = (await as.assistant2.get(`/api/tasks/${t.id}`)).body.task.version;
    await as.assistant2.put(`/api/tasks/${t.id}`).send({ version: v, recurrence: 'WEEKLY' }).expect(400);
    await as.unauthorised.post(`/api/tasks/${t.id}/subtasks`).send({ title: 'Herhaalt', assigneeAccountId: id.unauthorised, dueDate: day(4), recurrence: 'WEEKLY' }).expect(400);
    await as.assistant2.post(`/api/projects/${p.id}/tickets`).send({ milestoneId: p.milestones[0].id, title: 'x', assigneeAccountId: id.unauthorised, recurrence: 'WEEKLY' }).expect(400);
  });

  it('notices about a ticket reach only people who may open it: not the old manager, not an outsider as owner or by a mention', async () => {
    const p = await make('Meldingen GEHEIM', { classification: 'CONFIDENTIAL' });
    const t = await ticket(p.id, p.milestones[0].id, 'OUDE-PL-TITEL', 'unauthorised');
    const cur = (await get('directeur', p.id)).body;
    await as.directeur.put(`/api/projects/${p.id}`).send({ version: cur.version, managerAccountId: id.dualrole }).expect(200);
    const v = (await as.unauthorised.get(`/api/tasks/${t.id}`)).body.task.version;
    await as.unauthorised.post(`/api/tasks/${t.id}/complete`).send({ version: v }).expect(200);
    const old = await h.db.query(`SELECT 1 FROM notification WHERE account_id = $1 AND (title LIKE '%OUDE-PL-TITEL%' OR body LIKE '%OUDE-PL-TITEL%') AND created_at > now() - interval '1 minute' AND kind = 'TASK_COMPLETED'`, [id.assistant2]);
    expect(old).toHaveLength(0);
    const t2 = (await as.dualrole.post(`/api/projects/${p.id}/tickets`).send({ milestoneId: p.milestones[0].id, title: 'Hoofd', assigneeAccountId: id.unauthorised }).expect(201)).body;
    await as.unauthorised.post(`/api/tasks/${t2.id}/subtasks`).send({ title: 'Met eigenaar', assigneeAccountId: id.unauthorised, ownerAccountId: id.minister }).expect(400);
    await as.unauthorised.post(`/api/tasks/${t2.id}/comments`).send({ body: `Zie @[Minister](${id.minister}) MENTION-GEHEIM` }).expect(201);
    const mention = await h.db.query(`SELECT 1 FROM notification WHERE account_id = $1 AND (title LIKE '%MENTION-GEHEIM%' OR body LIKE '%MENTION-GEHEIM%')`, [id.minister]);
    expect(mention).toHaveLength(0);
  });

  it('leaving the project ends following its tickets', async () => {
    const p = await make('Volger GEHEIM', { classification: 'CONFIDENTIAL' });
    await as.assistant2.post(`/api/projects/${p.id}/members`).send({ accountId: id.assistant1, role: 'MEMBER' }).expect(200);
    const t = await ticket(p.id, p.milestones[0].id, 'VOLGER-TITEL', 'unauthorised');
    const v = (await as.assistant2.get(`/api/tasks/${t.id}`)).body.task.version;
    await as.assistant2.put(`/api/tasks/${t.id}`).send({ version: v, audience: [id.assistant1] }).expect(200);
    await as.assistant1.get(`/api/tasks/${t.id}`).expect(200);
    await as.assistant2.delete(`/api/projects/${p.id}/members/${id.assistant1}`).expect(200);
    await as.assistant1.get(`/api/tasks/${t.id}`).expect(404);
  });

  it('a ticket that waited for the lock sees the phase closed meanwhile', async () => {
    const p = await make('Slot');
    const a = await submitAndApprove(p.id);
    const phase = a.milestones[1];
    const qr = h.db.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    await qr.query(`SELECT 1 FROM project WHERE id = $1 FOR UPDATE`, [p.id]);
    const pending = as.assistant2.post(`/api/projects/${p.id}/tickets`).send({ milestoneId: phase.id, title: 'TE-LAAT', assigneeAccountId: id.unauthorised }).then((r) => r);
    await new Promise((r) => setTimeout(r, 800));
    await qr.query(`UPDATE project_milestone SET status = 'CLOSED', closed_at = now(), closed_by_account_id = $2 WHERE id = $1`, [phase.id, id.assistant2]);
    await qr.query(`UPDATE project_milestone SET status = 'ACTIVE' WHERE id = $1`, [a.milestones[2].id]);
    await qr.commitTransaction();
    await qr.release();
    expect((await pending).status).toBe(400);
    expect(await h.db.query(`SELECT 1 FROM task WHERE title = 'TE-LAAT'`)).toHaveLength(0);
  });

  it('whoever wrote or submitted a business case never decides on it, even after a swap of roles', async () => {
    const p = await make('Ruil');
    await writeCase(p.id);
    let v = (await get('assistant2', p.id)).body.version;
    await as.assistant2.post(`/api/projects/${p.id}/business-case/submit`).send({ version: v }).expect(200);
    v = (await get('directeur', p.id)).body.version;
    await as.directeur.put(`/api/projects/${p.id}`).send({ version: v, ownerAccountId: id.assistant2, managerAccountId: id.directeur }).expect(400);
    // Returned first, then swapped: the author is now the owner, and still may not decide.
    v = (await get('directeur', p.id)).body.version;
    await as.directeur.post(`/api/projects/${p.id}/business-case/return`).send({ version: v, reason: 'Kosten uitsplitsen.' }).expect(200);
    v = (await get('directeur', p.id)).body.version;
    await as.directeur.put(`/api/projects/${p.id}`).send({ version: v, ownerAccountId: id.assistant2, managerAccountId: id.dualrole }).expect(200);
    v = (await get('dualrole', p.id)).body.version;
    await as.dualrole.post(`/api/projects/${p.id}/business-case/submit`).send({ version: v }).expect(200);
    v = (await get('assistant2', p.id)).body.version;
    await as.assistant2.post(`/api/projects/${p.id}/business-case/approve`).send({ version: v }).expect(403);
  });
});
