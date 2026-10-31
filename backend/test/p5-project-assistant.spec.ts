import request from 'supertest';
import { resetAssistantGate } from '../src/ai/agent/assistant.controller';
import { AssistantService } from '../src/ai/agent/assistant.service';
import { ChatModel, GenerateRequest, GenerateResponse } from '../src/ai/agent/types';
import { todayInSuriname } from '../src/common/actor';
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

/** Round 1: call one tool; round 2: answer with what it returned. */
const callThenEcho = (name: string, args: Record<string, unknown>) =>
  new ScriptModel((req, round) => {
    if (round === 1) return { calls: [{ name, args }] };
    const last = req.entries[req.entries.length - 1];
    return { text: JSON.stringify(last.kind === 'results' ? last.results.map((r) => r.response) : []) };
  });

/**
 * V0.5.0 — the assistant on projects: the same need-to-know as the screens,
 * metadata only for the model (no project names, no ticket titles), and
 * confidential projects never sent to the model.
 */
describe('V0.5.0 assistant on projects', () => {
  let h: Harness;
  const as: Record<string, Agent> = {};
  const id: Record<string, string> = {};
  const day = (n: number) => {
    const d = new Date(`${todayInSuriname()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const project: Record<string, { id: string; reference: string }> = {};
  const ticket: Record<string, { id: string; reference: string }> = {};
  const ask = (who: string, question: string) => as[who].post('/api/v1/ai/query').send({ question, history: [], lang: 'nl' });

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_API_KEY = 'test-key-not-a-real-key-0000';
    process.env.AI_MODEL = 'gemini-flash-latest';
    h = await startHarness();
    for (const who of ['minister', 'directeur', 'assistant2', 'unauthorised', 'dualrole', 'sysadmin']) {
      as[who] = (await signIn(h.app, `${who}@juspol.test`)).agent;
      id[who] = await accountIdFor(h.db, `${who}@juspol.test`);
    }
    const current = (await as.sysadmin.get('/api/settings').expect(200)).body.ai ?? SETTING_DEFAULTS.ai;
    await as.sysadmin.put('/api/settings/ai').send({ value: { ...current, features: { ...current.features, assistant: true } } }).expect(200);
    const [{ id: unit }] = await h.db.query(`SELECT id FROM organisational_unit WHERE code = 'HO-DIR'`);
    const make = async (key: string, name: string, extra: Record<string, unknown> = {}) => {
      const res = await as.directeur
        .post('/api/projects')
        .send({ name, unitId: unit, managerAccountId: id.assistant2, startDate: day(0), endDate: day(90), ...extra })
        .expect(201);
      project[key] = { id: res.body.id, reference: res.body.reference };
      return res.body;
    };
    const p = await make('register', 'Digitalisering strafregister KLASSIFIEK-NAAM');
    await make('secret', 'Uitwijkcentrum GEHEIME-LOCATIE', { classification: 'CONFIDENTIAL' });
    const bc = p.milestones[0].id;
    for (const [key, title, who, due] of [
      ['mine', 'Kostenraming TITEL-VAN-TEAMLID', 'unauthorised', day(-1)],
      ['other', 'Privacytoets TITEL-VAN-ANDER', 'assistant2', day(5)],
    ] as const) {
      // The first ticket is overdue: made due today, then moved back a day in the database.
      const res = await as.assistant2.post(`/api/projects/${project.register.id}/tickets`).send({ milestoneId: bc, title, assigneeAccountId: id[who], startDate: day(0), dueDate: due < day(0) ? day(0) : due }).expect(201);
      ticket[key] = { id: res.body.id, reference: res.body.reference };
    }
    await h.db.query(`UPDATE task SET due_date = $2, start_date = $2 WHERE id = $1`, [ticket.mine.id, day(-1)]);
  });
  afterAll(async () => {
    AssistantService.modelFactory = null;
    await h.close();
  });
  beforeEach(() => resetAssistantGate());

  it('the project tools are offered to the business roles only', async () => {
    const m = new ScriptModel(() => ({ text: 'ok' }));
    AssistantService.modelFactory = () => m;
    await ask('unauthorised', 'Hoe staat mijn project ervoor?').expect(200);
    expect(m.requests[0].tools.map((t) => t.name)).toEqual(expect.arrayContaining(['projects', 'project_detail']));
    const admin = new ScriptModel(() => ({ text: 'ok' }));
    AssistantService.modelFactory = () => admin;
    await ask('sysadmin', 'Welke projecten lopen er?').expect(200);
    expect(admin.requests[0].tools.map((t) => t.name)).not.toContain('projects');
  });

  it('a team member gets their own ticket only; the model sees numbers and statuses, never the project name or ticket titles', async () => {
    const m = callThenEcho('project_detail', { project: 'strafregister' });
    AssistantService.modelFactory = () => m;
    const res = await ask('unauthorised', 'Hoe staat het strafregister-project ervoor?').expect(200);
    const [out] = JSON.parse(res.body.data.answer);
    expect(out.ref).toBe(project.register.reference);
    expect(out.ticketsYouMaySee).toBe('alleen uw eigen tickets');
    expect(out.tickets.map((t: { ref: string }) => t.ref)).toEqual([ticket.mine.reference]);
    expect(out.tickets[0].overdue).toBe(true);
    expect(out.team).toBeUndefined();
    expect(m.seen).not.toContain('KLASSIFIEK-NAAM');
    expect(m.seen).not.toContain('TITEL-VAN-TEAMLID');
    expect(m.seen).not.toContain(ticket.other.reference);
    // The person sees the name and their ticket's title in the card.
    const card = JSON.stringify(res.body.data.cards);
    expect(card).toContain('KLASSIFIEK-NAAM');
    expect(card).toContain('TITEL-VAN-TEAMLID');
    expect(card).not.toContain('TITEL-VAN-ANDER');
  });

  it('the owner gets every ticket; the line of command gets a summary without tickets', async () => {
    let m = callThenEcho('project_detail', { project: project.register.reference });
    AssistantService.modelFactory = () => m;
    let out = JSON.parse((await ask('directeur', 'Status?').expect(200)).body.data.answer)[0];
    expect(out.tickets.map((t: { ref: string }) => t.ref).sort()).toEqual([ticket.mine.reference, ticket.other.reference].sort());
    expect(out.yourRole).toBe('opdrachtgever');

    m = callThenEcho('project_detail', { project: project.register.reference });
    AssistantService.modelFactory = () => m;
    out = JSON.parse((await ask('minister', 'Status?').expect(200)).body.data.answer)[0];
    expect(out.tickets).toEqual([]);
    expect(out.yourAccess).toMatch(/samenvatting/);
    expect(out.overdueTickets).toBe(1);
  });

  it('confidential projects never reach the model; the person on it is told in a note, the line of command does not see it at all', async () => {
    let m = callThenEcho('projects', {});
    AssistantService.modelFactory = () => m;
    let res = await ask('directeur', 'Welke projecten heb ik?').expect(200);
    let out = JSON.parse(res.body.data.answer)[0];
    expect(out.total).toBe(1);
    expect(m.seen).not.toContain(project.secret.reference);
    expect(m.seen).not.toContain('GEHEIME-LOCATIE');
    expect(JSON.stringify(res.body.data.cards)).toContain('GEHEIME-LOCATIE');
    expect(res.body.data.cards.some((c: { kind: string }) => c.kind === 'NOTE')).toBe(true);

    m = callThenEcho('project_detail', { project: project.secret.reference });
    AssistantService.modelFactory = () => m;
    res = await ask('directeur', 'En het uitwijkcentrum?').expect(200);
    out = JSON.parse(res.body.data.answer)[0];
    expect(out).toEqual({ found: true, confidential: true, shownToThePersonInACard: true });

    m = callThenEcho('project_detail', { project: project.secret.reference });
    AssistantService.modelFactory = () => m;
    res = await ask('minister', 'En het uitwijkcentrum?').expect(200);
    expect(JSON.parse(res.body.data.answer)[0]).toEqual({ found: false });
    expect(JSON.stringify(res.body.data.cards ?? [])).not.toContain('GEHEIME-LOCATIE');
  });

  it('"what waits for me" includes a business case waiting for the owner', async () => {
    await h.db.query(`UPDATE task SET status = 'COMPLETED', completed_at = now() WHERE id = ANY($1)`, [[ticket.mine.id, ticket.other.id]]);
    const p = (await as.assistant2.get(`/api/projects/${project.register.id}`).expect(200)).body;
    await as.assistant2.put(`/api/projects/${project.register.id}/business-case`).send({ version: p.version, problem: 'a', solution: 'b', benefits: 'c', costs: 'd' }).expect(200);
    const v = (await as.assistant2.get(`/api/projects/${project.register.id}`).expect(200)).body.version;
    await as.assistant2.post(`/api/projects/${project.register.id}/business-case/submit`).send({ version: v }).expect(200);
    let m = callThenEcho('my_work', {});
    AssistantService.modelFactory = () => m;
    let out = JSON.parse((await ask('directeur', 'Wat wacht er op mij?').expect(200)).body.data.answer)[0];
    expect(out.projectDecisionsWaitingForMe).toBe(1);
    m = callThenEcho('projects', { only: 'awaiting_my_decision' });
    AssistantService.modelFactory = () => m;
    out = JSON.parse((await ask('directeur', 'Welke business cases wachten op mij?').expect(200)).body.data.answer)[0];
    expect(out.projects.map((x: { ref: string }) => x.ref)).toEqual([project.register.reference]);
    expect(out.projects[0].businessCase).toBe('ter goedkeuring bij de opdrachtgever');
  });
});
