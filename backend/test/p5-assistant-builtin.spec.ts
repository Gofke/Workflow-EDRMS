import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { resetAssistantGate } from '../src/ai/agent/assistant.controller';
import { GeminiModel } from '../src/ai/agent/providers';
import { todayInSuriname } from '../src/common/actor';
import { SETTING_DEFAULTS } from '../src/settings/settings.defaults';
import { accountIdFor, Harness, signIn, startHarness } from './harness';

type Agent = ReturnType<typeof request.agent>;

/**
 * V0.5.1 — fixes from the first test round: the built-in assistant answers
 * project and department questions (with the same need-to-know), no notice line
 * when it takes over, English questions get English, a new matter takes its
 * deadline from the file plan, and Gemini is asked to think briefly.
 */
describe('V0.5.1 built-in assistant, deadlines and Gemini settings', () => {
  let h: Harness;
  const as: Record<string, Agent> = {};
  const id: Record<string, string> = {};
  const day = (n: number) => {
    const d = new Date(`${todayInSuriname()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const ask = async (who: string, question: string, lang: 'nl' | 'en' = 'nl') =>
    (await as[who].post('/api/v1/ai/query').send({ question, history: [], lang }).expect(200)).body.data;
  let late: { id: string; reference: string };
  let secret: { id: string; reference: string };

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'builtin';
    delete process.env.AI_API_KEY;
    h = await startHarness();
    for (const who of ['minister', 'directeur', 'assistant2', 'unauthorised', 'dualrole', 'sysadmin']) {
      as[who] = (await signIn(h.app, `${who}@juspol.test`)).agent;
      id[who] = await accountIdFor(h.db, `${who}@juspol.test`);
    }
    const current = (await as.sysadmin.get('/api/settings').expect(200)).body.ai ?? SETTING_DEFAULTS.ai;
    await as.sysadmin.put('/api/settings/ai').send({ value: { ...current, features: { ...current.features, assistant: true } } }).expect(200);
    const [{ id: unit }] = await h.db.query(`SELECT id FROM organisational_unit WHERE code = 'HO-DIR'`);
    const make = async (name: string, extra: Record<string, unknown> = {}) =>
      (await as.directeur.post('/api/projects').send({ name, unitId: unit, managerAccountId: id.assistant2, startDate: day(0), endDate: day(90), ...extra }).expect(201)).body;
    const p = await make('Digitalisering strafregister');
    late = { id: p.id, reference: p.reference };
    await h.db.query(`UPDATE project SET start_date = $2, end_date = $3 WHERE id = $1`, [p.id, day(-30), day(-1)]);
    await as.assistant2.post(`/api/projects/${p.id}/tickets`).send({ milestoneId: p.milestones[0].id, title: 'Kostenraming', assigneeAccountId: id.unauthorised }).expect(201);
    const s = await make('Uitwijkcentrum ICT', { classification: 'CONFIDENTIAL' });
    secret = { id: s.id, reference: s.reference };
  });
  afterAll(async () => {
    delete process.env.AI_PROVIDER;
    await h.close();
  });
  beforeEach(() => resetAssistantGate());

  it('answers "which projects are behind?" without a notice line, and never shows a confidential project to the line of command', async () => {
    const r = await ask('minister', 'Welke projecten lopen achter?');
    expect(r.notice).toBeNull();
    expect(r.answer).toContain(late.reference);
    const cards = JSON.stringify(r.cards);
    expect(cards).toContain(late.reference);
    expect(cards).not.toContain(secret.reference);
    expect(r.answer).not.toMatch(/niet zeker of ik u goed begrijp/);
  });

  it('one project by name: a team member hears about their own tickets only; a confidential project is not found for the line of command', async () => {
    const member = await ask('unauthorised', 'Hoe staat het strafregister project ervoor?');
    expect(member.answer).toContain(late.reference);
    expect(member.answer).toMatch(/alleen uw eigen tickets/);
    const minister = await ask('minister', 'Hoe staat het project Uitwijkcentrum ervoor?');
    expect(minister.answer).toMatch(/niet vinden/);
    expect(JSON.stringify(minister.cards)).not.toContain('Uitwijkcentrum');
    const owner = await ask('directeur', 'Hoe staat het project Uitwijkcentrum ervoor?');
    expect(owner.answer).toContain(secret.reference);
  });

  it('a question in English gets English, also from a Dutch screen', async () => {
    const r = await ask('minister', 'Which projects are behind schedule?', 'nl');
    expect(r.answer).toMatch(/behind schedule/);
  });

  it('a department outside the line is refused; inside it is counted', async () => {
    const out = await ask('dualrole', 'Hoeveel zaken heeft HO-ICT?');
    expect(out.answer).toMatch(/buiten uw lijn/);
    expect(out.cards).toEqual([]);
    const inside = await ask('dualrole', 'Hoeveel zaken heeft HO-DIR?');
    expect(inside.answer).toMatch(/open (zaak|zaken)/);
  });

  it('a question it does not understand still gets suggestions to choose from', async () => {
    const r = await ask('assistant2', 'blauwe olifanten dansen');
    expect(r.suggestions.length).toBeGreaterThan(2);
    expect(r.notice).toBeNull();
  });

  it('a new matter takes its deadline from the file plan category', async () => {
    const [{ id: cat }] = await h.db.query(
      `INSERT INTO dossier_category (code, name, retention_years, retention_action, handling_working_days)
       VALUES ('9.9', 'Testcategorie', 7, 'DESTROY', 10) RETURNING id`,
    );
    const d = (await as.assistant2.post('/api/dossiers').send({ subject: 'Zaak met termijn', categoryId: cat }).expect(201)).body;
    expect(d.dueDate).toBeTruthy();
    expect(d.dueDate > day(10)).toBe(true);
  });

  it('Gemini is asked to think briefly; a model that refuses the setting is asked again without it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data);
        bodies.push(body);
        res.setHeader('Content-Type', 'application/json');
        if (body.generationConfig?.thinkingConfig) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { code: 400, message: 'Thinking budget is not supported for this model.', status: 'INVALID_ARGUMENT' } }));
          return;
        }
        res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }, modelVersion: 'fake' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
      const m = new GeminiModel('test-key-not-a-real-key-0000', base);
      const out = await m.generate({ model: 'gemini-flash-latest', system: 's', entries: [{ kind: 'user', text: 'hallo' }], tools: [], allowTools: false, maxOutputTokens: 50, temperature: 0.2, signal: new AbortController().signal } as never);
      expect(out.text).toBe('ok');
      expect((bodies[0].generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 512 });
      expect((bodies[1].generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
