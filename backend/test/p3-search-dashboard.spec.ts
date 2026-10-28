import { execFileSync } from 'child_process';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * Search, My Work, the management overview, department performance,
 * workload, trends and the exported reports.
 */
describe('Phase 3 search and dashboards', () => {
  let h: Harness;
  beforeAll(async () => {
    process.env.OCR_ENABLED = 'true';
    process.env.OCR_LANGUAGES = 'nld+eng';
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
    delete process.env.OCR_ENABLED;
    delete process.env.OCR_LANGUAGES;
  });

  const version = async (id: string) => (await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [id]))[0].version as number;

  async function letter(email: string, subject: string, party: string, classification?: string) {
    const { agent } = await signIn(h.app, email);
    const d = (await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject, party, ...(classification ? { classification } : {}) }).expect(201)).body;
    return (await agent.post(`/api/records/${d.id}/register`).send({ version: d.version }).expect(200)).body;
  }

  it('finds letters in Dutch, by word form, sender and number', async () => {
    const a = await letter('assistant1@juspol.test', 'Verzoeken om herziening van straffen', 'Openbaar Ministerie');
    await letter('assistant1@juspol.test', 'Begroting 2027', 'Korps Politie Suriname');
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const byWord = (await agent.get('/api/search?q=verzoek&types=ITEM').expect(200)).body;
    expect(byWord.hits.map((x: { id: string }) => x.id)).toContain(a.id);
    const byParty = (await agent.get('/api/search?q=politie&types=ITEM').expect(200)).body;
    expect(byParty.hits[0].snippet).toBe('Korps Politie Suriname');
    const byNumber = (await agent.get(`/api/search?q=${a.registrationIdentity}`).expect(200)).body;
    expect(byNumber.hits[0].identity).toBe(a.registrationIdentity);
    const filtered = (await agent.get('/api/search?party=Openbaar&types=ITEM').expect(200)).body;
    expect(filtered.counts.ITEM).toBe(1);
  });

  it('finds the words inside a document, shown as derived text', async () => {
    const item = await letter('assistant1@juspol.test', 'Bijlage met tekst', 'Rechtbank');
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const { newPdf, pdfBuffer } = await import('../src/core/pdf');
    const pdf = await pdfBuffer(newPdf().text('De gedetineerde verzoekt om overplaatsing naar Santo Boma.'));
    await agent.post(`/api/records/${item.id}/documents`).attach('file', pdf, { filename: 'verzoek.pdf', contentType: 'application/pdf' }).expect(201);
    const result = (await agent.get('/api/search?q=overplaatsing&types=DOCUMENT').expect(200)).body;
    expect(result.hits[0].identity).toBe(item.registrationIdentity);
    expect(result.hits[0].snippet).toContain('«overplaatsing»');
    expect(result.hits[0].meta.derived).toBe('true');
  });

  it('never finds a record the person may not see — not even as a count', async () => {
    await letter('assistant2@juspol.test', 'Geheim onderzoek naar corruptie', 'Inspectie', 'CONFIDENTIAL');
    const { agent: outsider } = await signIn(h.app, 'assistant1@juspol.test');
    const result = (await outsider.get('/api/search?q=corruptie').expect(200)).body;
    expect(result.hits).toHaveLength(0);
    expect(result.counts.ITEM).toBe(0);
    const { agent: cleared } = await signIn(h.app, 'directeur@juspol.test');
    expect((await cleared.get('/api/search?q=corruptie').expect(200)).body.counts.ITEM).toBe(1);
  });

  it('keeps a person’s saved searches to themselves', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const saved = (await agent.post('/api/search/saved').send({ name: 'Politie', query: { q: 'politie' } }).expect(201)).body;
    expect(saved[0].name).toBe('Politie');
    const { agent: other } = await signIn(h.app, 'assistant2@juspol.test');
    expect((await other.get('/api/search/saved').expect(200)).body).toHaveLength(0);
    await other.delete(`/api/search/saved/${saved[0].id}`).expect(404);
    await agent.delete(`/api/search/saved/${saved[0].id}`).expect(200);
  });

  it('gathers a person’s work in one place', async () => {
    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    const clerk = await accountIdFor(h.db, 'assistant1@juspol.test');
    await dir.post('/api/tasks').send({ title: 'Mijn werk taak', assigneeAccountId: clerk, dueDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) }).expect(201);
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject: 'Nog te registreren' }).expect(201);
    const work = (await agent.get('/api/my-work').expect(200)).body;
    expect(work.summary.openTasks).toBeGreaterThan(0);
    expect(work.summary.dueThisWeek).toBeGreaterThan(0);
    expect(work.summary.draftsToRegister).toBeGreaterThan(0);
    expect(work.tasks[0].title).toBe('Mijn werk taak');
    // The reviewer sees what awaits their decision.
    const dossier = (await agent.post('/api/dossiers').send({ subject: 'Voor beslissing' }).expect(201)).body;
    await agent.post(`/api/dossiers/${dossier.id}/submit`).send({ reviewerAccountId: await accountIdFor(h.db, 'directeur@juspol.test'), version: await version(dossier.id) }).expect(200);
    const dirWork = (await dir.get('/api/my-work').expect(200)).body;
    expect(dirWork.summary.awaitingMyDecision).toBe(1);
    expect(dirWork.reviewQueue[0].dossierIdentity).toBe(dossier.dossierIdentity);
  });

  it('gives decision-makers the overview with on-time rate and overdue matters, and refuses others', async () => {
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    await clerk.get('/api/dashboard/overview').expect(403);
    // One matter finalised on time, one overdue.
    const onTime = (await clerk.post('/api/dossiers').send({ subject: 'Op tijd' }).expect(201)).body;
    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    const future = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await dir.post(`/api/dossiers/${onTime.id}/due-date`).send({ dueDate: future, version: await version(onTime.id) }).expect(200);
    const directeur = await accountIdFor(h.db, 'directeur@juspol.test');
    const draft = (await clerk.post('/api/records/drafts').send({ direction: 'INCOMING', subject: 'Stuk op tijd' }).expect(201)).body;
    const reg = (await clerk.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)).body;
    await clerk.post(`/api/dossiers/${onTime.id}/links`).send({ itemId: reg.id }).expect(200);
    await clerk.post(`/api/dossiers/${onTime.id}/submit`).send({ reviewerAccountId: directeur, version: await version(onTime.id) }).expect(200);
    await dir.post(`/api/dossiers/${onTime.id}/approve`).send({ version: await version(onTime.id) }).expect(200);
    await dir.post(`/api/dossiers/${onTime.id}/finalise`).send({ version: await version(onTime.id) }).expect(200);
    const late = (await clerk.post('/api/dossiers').send({ subject: 'Te laat' }).expect(201)).body;
    await dir.post(`/api/dossiers/${late.id}/due-date`).send({ dueDate: future, version: await version(late.id) }).expect(200);
    await h.db.query(`INSERT INTO due_date_change (dossier_id, previous_due_date, new_due_date, reason, changed_by_account_id) VALUES ($1, $2, current_date - 4, 'test', $3)`, [late.id, future, directeur]);
    await h.db.query(`UPDATE dossier SET due_date = current_date - 4 WHERE id = $1`, [late.id]);
    const overview = (await dir.get('/api/dashboard/overview').expect(200)).body;
    expect(overview.counts.overdueMatters).toBeGreaterThanOrEqual(1);
    expect(overview.counts.underReview).toBeGreaterThanOrEqual(1);
    expect(overview.onTime.total).toBe(1);
    expect(overview.onTime.percentage).toBe(100);
    expect(overview.overdue.map((o: { dossierIdentity: string }) => o.dossierIdentity)).toContain(late.dossierIdentity);
    expect(overview.overdue[0].workingDaysLate).toBeGreaterThan(0);
    expect(overview.byUnit.length).toBeGreaterThan(0);
    expect(overview.trends.months).toHaveLength(6);
    expect(overview.recentDecisions[0].eventType).toBe('FINALISED');
  });

  it('reports workload per person and department performance', async () => {
    const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
    const workload = (await minister.get('/api/dashboard/workload').expect(200)).body;
    const clerk = workload.find((w: { name: string }) => w.name === 'L. Amatredjo');
    expect(clerk.openTasks).toBeGreaterThan(0);
    const departments = (await minister.get('/api/dashboard/departments').expect(200)).body;
    const kab = departments.find((d: { code: string }) => d.code === 'HO-KAB');
    expect(kab.registered).toBeGreaterThan(0);
    const trends = (await minister.get('/api/dashboard/trends?months=3').expect(200)).body;
    expect(trends.months).toHaveLength(3);
    expect(trends.topSenders.length).toBeGreaterThan(0);
  });

  it('exports reports to Excel and PDF, audited, with no formula injection', async () => {
    await letter('assistant1@juspol.test', 'Injectie', '=HYPERLINK("http://evil")');
    const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
    const xlsx = await minister.get('/api/reports/trends.xlsx').buffer(true).parse(binary as never).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    const senders = wb.getWorksheet('Afzenders')!;
    const values: unknown[] = [];
    senders.eachRow((row) => values.push(row.getCell(1).value));
    expect(values).toContain(`'=HYPERLINK("http://evil")`);
    const pdf = await minister.get('/api/reports/departments.pdf').buffer(true).parse(binary as never).expect(200);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    // The PDF is sealed: its seal is public, valid, and says what it is.
    const [seal] = await h.db.query(`SELECT id FROM document_seal WHERE payload::jsonb->>'kind' = 'REPORT' ORDER BY sealed_at DESC LIMIT 1`);
    expect(seal).toBeDefined();
    const check = (await request(h.app.getHttpServer()).get(`/api/public/seals/${seal.id}`).expect(200)).body;
    expect(check).toMatchObject({ valid: true, kind: 'REPORT', title: 'Prestaties per afdeling (laatste 90 dagen)' });
    expect(execFileSync('pdftotext', ['-', '-'], { input: pdf.body }).toString()).toContain(`Zegelnummer ${seal.id}`);
    await minister.get('/api/reports/nonsense.pdf').expect(400);
    await expectAuditEvent(h.db, 'REPORT_EXPORTED', 'Trends');
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    await clerk.get('/api/reports/workload.xlsx').expect(403);
  });
});
