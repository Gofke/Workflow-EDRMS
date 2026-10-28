import http from 'http';
import { AddressInfo } from 'net';
import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';
import { SETTING_DEFAULTS } from '../src/settings/settings.defaults';

/**
 * The free assistant: built-in engine by default, optional local language
 * model, every feature off until switched on, permission-filtered, proposals
 * applied only on confirmation, every suggestion kept and judged.
 */
describe('Phase 3 assistant (AI)', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signIn>>['agent'];

  // A stand-in for a local open-source model server (Ollama speaks the same API).
  const received: { url: string; body: Record<string, unknown> }[] = [];
  let model: http.Server;
  let modelPort = 0;

  beforeAll(async () => {
    process.env.OCR_ENABLED = 'true';
    process.env.OCR_LANGUAGES = 'nld+eng';
    h = await startHarness();
    admin = (await signIn(h.app, 'sysadmin@juspol.test')).agent;
    model = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        if (req.method === 'GET' && req.url?.endsWith('/models')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'llama3.1:8b' }, { id: 'mistral:7b' }] }));
          return;
        }
        const body = JSON.parse(data || '{}');
        received.push({ url: req.url ?? '', body });
        const system = (body.messages as { role: string; content: string }[])[0].content;
        const text = system.startsWith('Translate') ? 'Request for transfer of a detainee.' : '- Punt een uit het model\n- Punt twee uit het model';
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: text } }] }));
      });
    });
    await new Promise<void>((resolve) => model.listen(0, resolve));
    modelPort = (model.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => model.close(resolve));
    await h.close();
    delete process.env.OCR_ENABLED;
    delete process.env.OCR_LANGUAGES;
  });

  const allOn = Object.fromEntries(Object.keys(SETTING_DEFAULTS.ai.features).map((k) => [k, true]));
  async function setAi(patch: Partial<typeof SETTING_DEFAULTS.ai>) {
    const current = (await admin.get('/api/settings').expect(200)).body.ai ?? SETTING_DEFAULTS.ai;
    return admin.put('/api/settings/ai').send({ value: { ...current, ...patch } });
  }
  const version = async (id: string) => (await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [id]))[0].version as number;

  async function letter(email: string, subject: string, party: string, extra: Record<string, unknown> = {}, text?: string) {
    const { agent } = await signIn(h.app, email);
    const d = (await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject, party, ...extra }).expect(201)).body;
    if (text) {
      const { newPdf, pdfBuffer } = await import('../src/core/pdf');
      const pdf = await pdfBuffer(newPdf().text(text));
      await agent.post(`/api/records/${d.id}/documents`).attach('file', pdf, { filename: 'brief.pdf', contentType: 'application/pdf' }).expect(201);
    }
    const reg = (await agent.post(`/api/records/${d.id}/register`).send({ version: d.version }).expect(200)).body;
    return reg;
  }

  const LETTER = [
    'Korps Politie Suriname',
    'Afdeling Juridische Zaken',
    '',
    'Paramaribo, 2 oktober 2026',
    'Uw kenmerk: KPS/JZ/2026-118',
    'Onderwerp: Verzoek om inzage in het strafdossier van de heer R. Pinas',
    '',
    'Geachte heer/mevrouw,',
    '',
    'Hierbij verzoeken wij u vriendelijk om inzage in het strafdossier van de heer R. Pinas in verband met een lopend onderzoek naar de overplaatsing van gedetineerden.',
    'Wij verzoeken u binnen 10 werkdagen te reageren. Deze brief is vertrouwelijk.',
    '',
    'Hoogachtend,',
    'Korps Politie Suriname',
  ].join('\n');

  it('is switched off until the administrator switches it on, and never points outside unconfirmed', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const status = (await agent.get('/api/ai/status').expect(200)).body;
    expect(status.provider).toBe('builtin');
    expect(status.local).toBe(true);
    expect(status.free).toBe(true);
    expect(Object.values(status.features).every((v) => v === false)).toBe(true);
    await agent.post('/api/ai/ask').send({ question: 'Hoeveel brieven?' }).expect(403);
    await agent.post('/api/ai/chat').send({ message: 'hallo' }).expect(403);
    const refused = await setAi({ provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', externalProviderAcknowledged: false });
    expect(refused.status).toBe(400);
    await setAi({ features: allOn as typeof SETTING_DEFAULTS.ai.features }).then((r) => expect(r.status).toBe(200));
    expect((await agent.get('/api/ai/status').expect(200)).body.features.chat).toBe(true);
  });

  it('reads a letter and proposes subject, sender, date, reference, deadline and sensitivity', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const d = (await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject: 'Nog in te vullen' }).expect(201)).body;
    const { newPdf, pdfBuffer } = await import('../src/core/pdf');
    await agent.post(`/api/records/${d.id}/documents`).attach('file', await pdfBuffer(newPdf().text(LETTER)), { filename: 'brief.pdf', contentType: 'application/pdf' }).expect(201);
    const r = (await agent.post(`/api/ai/items/${d.id}/intake`).expect(200)).body;
    expect(r.engine.provider).toBe('builtin');
    expect(r.readable).toBe(true);
    expect(r.proposals.subject.value).toBe('Verzoek om inzage in het strafdossier van de heer R. Pinas');
    expect(r.proposals.party.value).toBe('Korps Politie Suriname');
    expect(r.proposals.documentDate.value).toBe('2026-10-02');
    expect(r.proposals.senderReference.value).toBe('KPS/JZ/2026-118');
    // Ten working days from Friday 2 October: Friday 16 October.
    expect(r.proposals.deadlines[0]).toMatchObject({ kind: 'RELATIVE_WORKING_DAYS', workingDays: 10, dueDate: '2026-10-16' });
    expect(r.proposals.classification.value).toBe('CONFIDENTIAL');
    expect(r.proposals.requests[0]).toContain('inzage');
    // Each proposal shows what it was based on.
    expect(r.proposals.subject.basis).toContain('Onderwerp');
    const [row] = await h.db.query(`SELECT feature, subject_id, provider FROM ai_interaction WHERE id = $1`, [r.interactionId]);
    expect(row).toMatchObject({ feature: 'intake', subject_id: d.id, provider: 'builtin' });
    // Nothing was changed on the draft.
    const [item] = await h.db.query(`SELECT subject, party FROM correspondence_item WHERE id = $1`, [d.id]);
    expect(item.subject).toBe('Nog in te vullen');
    // The same from pasted text, and in English.
    const en = (await agent.post('/api/ai/intake').send({ text: 'From: Embassy of the Netherlands\nSubject: Request for legal assistance\nDear Sir or Madam,\nWe kindly request your assistance. Please reply no later than 20 November 2026.' }).expect(200)).body;
    expect(en.proposals.language).toBe('en');
    expect(en.proposals.party.value).toBe('Embassy of the Netherlands');
    expect(en.proposals.subject.value).toBe('Request for legal assistance');
    expect(en.proposals.deadlines[0].dueDate).toBe('2026-11-20');
  });

  it('suggests the unit that handled similar letters, and who there', async () => {
    const [unit] = await h.db.query(`INSERT INTO organisational_unit (code, name, kind) VALUES ('JI', 'Justitiële Inrichtingen', 'DEPARTMENT') RETURNING id`);
    const odir = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    for (const s of ['Verzoek overplaatsing gedetineerde naar Santo Boma', 'Bezoekregeling gedetineerden penitentiaire inrichting']) {
      const item = await letter('assistant1@juspol.test', s, 'Advocatenkantoor Brahim');
      const dossier = (await agent.post('/api/dossiers').send({ subject: s }).expect(201)).body;
      await agent.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: item.id }).expect(200);
      await h.db.query(`UPDATE dossier SET owning_unit_id = $2 WHERE id = $1`, [dossier.id, unit.id]);
      await dir.post(`/api/dossiers/${dossier.id}/responsibility`).send({ responsibleAccountId: odir, version: await version(dossier.id) }).expect(200);
    }
    const fresh = await letter('assistant1@juspol.test', 'Verzoek tot overplaatsing van een gedetineerde', 'Familie Pinas');
    const r = (await agent.post(`/api/ai/items/${fresh.id}/routing`).expect(200)).body;
    expect(r.units[0].unitCode).toBe('JI');
    expect(r.units[0].reasons.join(' ')).toMatch(/vergelijkbare brie/);
    expect(r.units[0].reasons.join(' ')).toMatch(/detentie/);
    expect(r.units[0].person).toMatchObject({ accountId: odir, name: 'A. Boldewijn' });
    expect(r.units[0].confidence).toBeGreaterThan(0.3);
  });

  it('finds near-duplicates, only among letters the person may see', async () => {
    const first = await letter('assistant1@juspol.test', 'Verzoek om overplaatsing gedetineerde J. Pinas', 'Advocatenkantoor Brahim');
    // A similar confidential letter of another unit stays invisible.
    await letter('assistant2@juspol.test', 'Verzoek overplaatsing gedetineerde J. Pinas (geheim)', 'Advocatenkantoor Brahim', { classification: 'CONFIDENTIAL' });
    const second = await letter('assistant1@juspol.test', 'Verzoek overplaatsing gedetineerde Pinas', 'Advocatenkantoor Brahim');
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const r = (await agent.post(`/api/ai/items/${second.id}/duplicates`).expect(200)).body;
    const ids = r.candidates.map((c: { itemId: string }) => c.itemId);
    expect(ids).toContain(first.id);
    expect(r.candidates.find((c: { itemId: string }) => c.itemId === first.id).reasons).toContain('zelfde afzender');
    expect(r.candidates.some((c: { subject: string }) => c.subject.includes('geheim'))).toBe(false);
  });

  let dossierId = '';
  let dossierIdentity = '';
  let incomingId = '';

  it('summarises a matter only from what is in it', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const item = await letter('assistant1@juspol.test', 'Verzoek om inzage strafdossier', 'Korps Politie Suriname', {}, LETTER.replace('Deze brief is vertrouwelijk.', ''));
    incomingId = item.id;
    const dossier = (await agent.post('/api/dossiers').send({ subject: 'Inzage strafdossier R. Pinas' }).expect(201)).body;
    dossierId = dossier.id;
    dossierIdentity = dossier.dossierIdentity;
    await agent.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: item.id }).expect(200);
    const clerk = await accountIdFor(h.db, 'assistant1@juspol.test');
    await agent.post('/api/tasks').send({ title: 'Strafdossier opvragen', assigneeAccountId: clerk, dossierId: dossier.id }).expect(201);
    const s = (await agent.post(`/api/ai/dossiers/${dossier.id}/summary`).send({}).expect(200)).body;
    expect(s.headline).toContain(dossier.dossierIdentity);
    expect(s.bullets.join('\n')).toContain('Verantwoordelijk');
    expect(s.bullets.join('\n')).toContain('1 stuk (1 inkomend, 0 uitgaand)');
    expect(s.bullets.join('\n')).toContain('Taken: 1 open');
    // Extractive: every key sentence is really in the record.
    const [{ t }] = await h.db.query(
      `SELECT string_agg(dt.extracted_text, ' ') AS t FROM document_text dt JOIN captured_document cd ON cd.id = dt.captured_document_id WHERE cd.correspondence_item_id = $1`,
      [item.id],
    );
    const flat = (x: string) => x.replace(/\s+/g, ' ');
    expect(s.keySentences.length).toBeGreaterThan(0);
    for (const k of s.keySentences) expect(flat(t)).toContain(flat(k.text));
    // English on request.
    const en = (await agent.post(`/api/ai/items/${item.id}/summary`).send({ language: 'en' }).expect(200)).body;
    expect(en.bullets[0]).toMatch(/^Incoming letter from Korps Politie Suriname/);
    // Someone who may not see a record gets "not found".
    const secret = await letter('minister@juspol.test', 'Geheim', 'X', { classification: 'SECRET' });
    await agent.post(`/api/ai/items/${secret.id}/summary`).send({}).expect(404);
  });

  it('drafts a reply with placeholders and saves it only when accepted', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const draft = (await agent.post(`/api/ai/items/${incomingId}/draft-reply`).send({}).expect(200)).body;
    expect(draft.body).toMatch(/^Geachte heer\/mevrouw,/);
    expect(draft.body).toContain('kenmerk KPS/JZ/2026-118');
    expect(draft.body).toContain('[Vermeld hier het besluit');
    expect(draft.body).toContain('Hoogachtend,');
    expect(draft.placeholders).toBeGreaterThan(0);
    const reply = (await agent.post(`/api/records/${incomingId}/reply`).send({}).expect(201)).body;
    expect((await h.db.query(`SELECT count(*)::int AS n FROM item_draft_version WHERE item_id = $1`, [reply.id]))[0].n).toBe(0);
    // Someone else cannot judge it.
    const { agent: other } = await signIn(h.app, 'assistant2@juspol.test');
    await other.post(`/api/ai/interactions/${draft.interactionId}/feedback`).send({ outcome: 'ACCEPTED' }).expect(404);
    const edited = draft.body.replace('[Vermeld hier het besluit of het inhoudelijke antwoord.]', 'Uw verzoek wordt in behandeling genomen.');
    const done = (await agent.post(`/api/ai/interactions/${draft.interactionId}/feedback`).send({ outcome: 'EDITED', apply: { targetItemId: reply.id, body: edited } }).expect(200)).body;
    expect(done.applied.draftVersion).toBeDefined();
    const [v] = await h.db.query(`SELECT body, ai_interaction_id FROM item_draft_version WHERE item_id = $1`, [reply.id]);
    expect(v.ai_interaction_id).toBe(draft.interactionId);
    expect(v.body).toContain('Uw verzoek wordt in behandeling genomen.');
    await agent.post(`/api/ai/interactions/${draft.interactionId}/feedback`).send({ outcome: 'ACCEPTED' }).expect(409);
    await expectAuditEvent(h.db, 'AI_SUGGESTION_ACCEPTED', 'draftReply');
    // An outgoing letter cannot be "replied" to.
    await agent.post(`/api/ai/items/${reply.id}/draft-reply`).send({}).expect(400);
  });

  it('turns meeting notes into proposed tasks, created only when confirmed', async () => {
    const { agent } = await signIn(h.app, 'directeur@juspol.test');
    const notes = [
      'Notulen overleg 28 oktober',
      'Aanwezig: Sardjoe, Amatredjo, Pawironadi',
      '- Amatredjo stuurt de ontvangstbevestiging uiterlijk vrijdag',
      '- Actie Pawironadi: dossier aanvullen met het politierapport, spoed',
      '- Sardjoe neemt contact op met het Openbaar Ministerie volgende week',
      'Rondvraag: geen',
    ].join('\n');
    const r = (await agent.post('/api/ai/meeting-notes').send({ text: notes, dossierId }).expect(200)).body;
    expect(r.proposals).toHaveLength(3);
    expect(r.proposals.map((p: { assignee: { name: string } }) => p.assignee?.name)).toEqual(['L. Amatredjo', 'K. Pawironadi', 'M. Sardjoe']);
    expect(r.proposals[1]).toMatchObject({ title: 'Dossier aanvullen met het politierapport', priority: 'URGENT' });
    expect(r.proposals[0].dueDate).not.toBeNull();
    expect(r.proposals[2].dueDate).not.toBeNull();
    expect((await h.db.query(`SELECT count(*)::int AS n FROM task WHERE source = 'MEETING_NOTES'`))[0].n).toBe(0);
    const chosen = r.proposals.slice(0, 2).map((p: { title: string; assignee: { accountId: string }; dueDate: string | null; priority: string }) => ({
      title: p.title,
      assigneeAccountId: p.assignee.accountId,
      dueDate: p.dueDate,
      priority: p.priority,
      dossierId,
    }));
    const done = (await agent.post(`/api/ai/interactions/${r.interactionId}/feedback`).send({ outcome: 'EDITED', note: 'Derde punt vervalt', apply: { tasks: chosen } }).expect(200)).body;
    expect(done.applied.tasks).toHaveLength(2);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM task WHERE source = 'MEETING_NOTES' AND dossier_id = $1`, [dossierId]))[0].n).toBe(2);
  });

  it('answers plain-language questions with only what the person may see', async () => {
    await letter('assistant1@juspol.test', 'Melding inbraak', 'Korps Politie Suriname');
    await letter('assistant2@juspol.test', 'Vertrouwelijk rapport', 'Korps Politie Suriname', { classification: 'CONFIDENTIAL' });
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const visible = (await h.db.query(`SELECT count(*)::int AS n FROM correspondence_item WHERE party ILIKE '%Politie%' AND direction = 'INCOMING' AND classification <> 'CONFIDENTIAL'`))[0].n;
    const r = (await agent.post('/api/ai/ask').send({ question: 'Hoeveel brieven van de Politie kwamen deze maand binnen?' }).expect(200)).body;
    expect(r.understood).toEqual(expect.arrayContaining(['brieven en stukken', 'deze maand', 'inkomend', 'van "Politie"']));
    expect(r.count).toBe(visible);
    expect(r.rows.every((x: { title: string }) => x.title !== 'Vertrouwelijk rapport')).toBe(true);
    expect(r.answer).toContain(`Het zijn er ${visible}`);
    const tasks = (await agent.post('/api/ai/ask').send({ question: 'Toon mijn open taken' }).expect(200)).body;
    expect(tasks.query.entity).toBe('TASK');
    expect(tasks.query.mine).toBe(true);
    expect(tasks.rows.map((x: { title: string }) => x.title)).toContain('Strafdossier opvragen');
    const matters = (await agent.post('/api/ai/ask').send({ question: 'Which matters are about strafdossier?', language: 'en' }).expect(200)).body;
    expect(matters.rows.map((x: { identity: string }) => x.identity)).toContain(dossierIdentity);
  });

  it('shows which matters risk missing their deadline, and why', async () => {
    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const soon = (await h.db.query(`SELECT to_char(current_date + 1, 'YYYY-MM-DD') AS d`))[0].d;
    await dir.post(`/api/dossiers/${dossierId}/due-date`).send({ dueDate: soon, version: await version(dossierId) }).expect(200);
    const late = (await agent.post('/api/dossiers').send({ subject: 'Al te laat' }).expect(201)).body;
    await dir.post(`/api/dossiers/${late.id}/due-date`).send({ dueDate: soon, version: await version(late.id) }).expect(200);
    const directeur = await accountIdFor(h.db, 'directeur@juspol.test');
    await h.db.query(`INSERT INTO due_date_change (dossier_id, previous_due_date, new_due_date, reason, changed_by_account_id) VALUES ($1, $2, current_date - 3, 'test', $3)`, [late.id, soon, directeur]);
    await h.db.query(`UPDATE dossier SET due_date = current_date - 3 WHERE id = $1`, [late.id]);
    const r = (await agent.get('/api/ai/risk').expect(200)).body;
    expect(r.scope).toBe('mine');
    const overdue = r.dossiers.find((d: { dossierId: string }) => d.dossierId === late.id);
    expect(overdue).toMatchObject({ score: 100, level: 'HIGH' });
    expect(overdue.reasons[0]).toMatch(/over termijn/);
    const close = r.dossiers.find((d: { dossierId: string }) => d.dossierId === dossierId);
    expect(['HIGH', 'MEDIUM']).toContain(close.level);
    expect(close.reasons.join(' ')).toMatch(/nog niet ter beoordeling aangeboden/);
    // A clerk cannot widen to everything; a director can.
    expect((await agent.get('/api/ai/risk?scope=all').expect(200)).body.scope).toBe('mine');
    expect((await dir.get('/api/ai/risk?scope=all').expect(200)).body.scope).toBe('all');
  });

  it('chats: help, my work, a matter by number, a task proposal confirmed, private history', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const hello = (await agent.post('/api/ai/chat').send({ message: 'Goedemorgen' }).expect(200)).body;
    expect(hello.message.intent).toBe('greeting');
    expect(hello.message.content).toContain('L. Amatredjo');
    const conversationId = hello.conversationId;
    const help = (await agent.post('/api/ai/chat').send({ conversationId, message: 'Hoe registreer ik een brief?' }).expect(200)).body;
    expect(help.message.intent).toBe('help');
    expect(help.message.content).toContain('Registreren');
    expect(help.message.cards[0].link).toBe('/post');
    const work = (await agent.post('/api/ai/chat').send({ conversationId, message: 'Wat staat er vandaag voor mij klaar?' }).expect(200)).body;
    expect(work.message.intent).toBe('my-work');
    expect(work.message.content).toMatch(/open ta/);
    const summary = (await agent.post('/api/ai/chat').send({ conversationId, message: `Vat ${dossierIdentity} samen` }).expect(200)).body;
    expect(summary.message.intent).toBe('summary');
    expect(summary.message.cards[0].link).toBe(`/zaken/${dossierId}`);
    const data = (await agent.post('/api/ai/chat').send({ conversationId, message: 'Welke zaken zijn over termijn?' }).expect(200)).body;
    expect(data.message.intent).toBe('ask');
    expect(data.message.cards[0].rows.map((r: { title: string }) => r.title)).toContain('Al te laat');
    const tomorrow = (await h.db.query(`SELECT to_char((now() AT TIME ZONE 'America/Paramaribo')::date + 1, 'YYYY-MM-DD') AS d`))[0].d;
    const proposal = (await agent.post('/api/ai/chat').send({ conversationId, message: 'Maak een taak voor Pawironadi om het politierapport op te vragen morgen' }).expect(200)).body;
    expect(proposal.message.intent).toBe('task-proposal');
    const task = proposal.message.cards[0].task;
    expect(task).toMatchObject({ assigneeName: 'K. Pawironadi', dueDate: tomorrow, title: 'Het politierapport op te vragen' });
    expect((await h.db.query(`SELECT count(*)::int AS n FROM task WHERE source = 'CHAT'`))[0].n).toBe(0);
    await agent
      .post(`/api/ai/interactions/${proposal.message.pending.interactionId}/feedback`)
      .send({ outcome: 'ACCEPTED', apply: { tasks: [{ title: task.title, assigneeAccountId: task.assigneeAccountId, dueDate: task.dueDate, priority: task.priority }] } })
      .expect(200);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM task WHERE source = 'CHAT'`))[0].n).toBe(1);
    const history = (await agent.get(`/api/ai/chat/conversations/${conversationId}`).expect(200)).body;
    expect(history.filter((m: { role: string }) => m.role === 'user')).toHaveLength(6);
    expect((await agent.get('/api/ai/chat/conversations').expect(200)).body[0].firstQuestion).toBe('Goedemorgen');
    const { agent: other } = await signIn(h.app, 'assistant2@juspol.test');
    await other.get(`/api/ai/chat/conversations/${conversationId}`).expect(404);
    await other.post('/api/ai/chat').send({ conversationId, message: 'hallo' }).expect(404);
    // A record the person may not see is not summarised, not even by number.
    const secret = await letter('minister@juspol.test', 'Geheime brief', 'Y', { classification: 'SECRET' });
    const refused = (await agent.post('/api/ai/chat').send({ message: 'Vat dit samen', context: { type: 'ITEM', id: secret.id } }).expect(200)).body;
    expect(refused.message.intent).toBe('need-context');
    const byNumber = (await agent.post('/api/ai/chat').send({ message: `Vat ${secret.registrationIdentity} samen` }).expect(200)).body;
    expect(byNumber.message.intent).toBe('need-context');
  });

  it('uses a free local language model when configured, and keeps confidential material inside', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    await setAi({ provider: 'ollama', baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'llama3.1:8b' }).then((r) => expect(r.status).toBe(200));
    const check = (await admin.get('/api/ai/model-check').expect(200)).body;
    expect(check).toMatchObject({ reachable: true, models: ['llama3.1:8b', 'mistral:7b'] });
    const before = received.length;
    const s = (await agent.post(`/api/ai/dossiers/${dossierId}/summary`).send({}).expect(200)).body;
    expect(s.engine).toMatchObject({ provider: 'ollama', model: 'llama3.1:8b', local: true });
    expect(s.bullets).toEqual(['Punt een uit het model', 'Punt twee uit het model']);
    expect(received.length).toBe(before + 1);
    const sent = JSON.stringify(received[received.length - 1].body);
    expect(sent).toContain('Inzage strafdossier R. Pinas');
    expect(sent).toContain('verzin geen namen');
    const translated = (await agent.post('/api/ai/translate').send({ text: 'Verzoek tot overplaatsing van een gedetineerde.', to: 'en' }).expect(200)).body;
    expect(translated.translation).toBe('Request for transfer of a detainee.');
    // An address outside the ministry network: confidential material stays home.
    await setAi({ provider: 'openai-compatible', baseUrl: `http://0.0.0.0:${modelPort}/v1`, externalProviderAcknowledged: true }).then((r) => expect(r.status).toBe(200));
    const confidential = await letter('assistant1@juspol.test', 'Vertrouwelijk verzoek', 'Advocatenkantoor Brahim', { classification: 'CONFIDENTIAL' }, 'Dit is een vertrouwelijk verzoek om gratie voor de gedetineerde.');
    const count = received.length;
    const kept = (await agent.post(`/api/ai/items/${confidential.id}/summary`).send({}).expect(200)).body;
    expect(kept.engine.provider).toBe('builtin');
    expect(kept.engine.fallback).toMatch(/Vertrouwelijke stukken/);
    expect(received.length).toBe(count);
    const open = (await agent.post(`/api/ai/items/${incomingId}/summary`).send({}).expect(200)).body;
    expect(open.engine).toMatchObject({ provider: 'openai-compatible', local: false });
    expect(received.length).toBe(count + 1);
    // A model that does not answer: the built-in assistant answers, and says so.
    await setAi({ provider: 'ollama', baseUrl: 'http://127.0.0.1:1/v1' });
    const fallback = (await agent.post(`/api/ai/dossiers/${dossierId}/summary`).send({}).expect(200)).body;
    expect(fallback.engine.provider).toBe('builtin');
    expect(fallback.engine.fallback).toMatch(/geen antwoord/);
    // Translation needs a model; the built-in engine says so plainly.
    await setAi({ provider: 'builtin' });
    await agent.post('/api/ai/translate').send({ text: 'Hallo', to: 'en' }).expect(400);
  });

  it('switching a feature off stops it everywhere, including in chat', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    await setAi({ features: { ...(allOn as typeof SETTING_DEFAULTS.ai.features), summary: false } });
    await agent.post(`/api/ai/dossiers/${dossierId}/summary`).send({}).expect(403);
    const chat = (await agent.post('/api/ai/chat').send({ message: `Vat ${dossierIdentity} samen` }).expect(200)).body;
    expect(chat.message.intent).toBe('switched-off');
    await setAi({ features: allOn as typeof SETTING_DEFAULTS.ai.features });
  });

  it('keeps every suggestion and reports use and acceptance without content', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const mine = (await agent.get('/api/ai/history').expect(200)).body;
    expect(mine.length).toBeGreaterThan(5);
    expect(mine.some((m: { outcome: string | null }) => m.outcome === 'EDITED')).toBe(true);
    await agent.get('/api/ai/usage').expect(403);
    const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
    const usage = (await minister.get('/api/ai/usage').expect(200)).body;
    const draft = usage.features.find((f: { feature: string }) => f.feature === 'draftReply');
    expect(draft).toMatchObject({ total: 1, edited: 1, acceptanceRate: 100 });
    expect(JSON.stringify(usage)).not.toContain('Pinas');
    // The record of suggestions cannot be altered.
    await h.db.query(`UPDATE ai_interaction SET prompt_summary = 'x'`);
    await h.db.query(`DELETE FROM ai_feedback`);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM ai_interaction WHERE prompt_summary = 'x'`))[0].n).toBe(0);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM ai_feedback`))[0].n).toBeGreaterThan(0);
  });
});
