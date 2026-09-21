import request from 'supertest';
import { clampPageLimit, DEFAULT_PAGE, MAX_PAGE } from '../src/timeline/timeline.service';
import { accountIdFor, expectAuditEvent, Harness, signIn, startHarness } from './harness';

/**
 * Timeline paging and export (V0.1.14).
 *
 * Paging must never serve an entry twice or skip one silently, even when the
 * history grows in the middle — which it does whenever an older record is
 * filed. Export must say exactly what the timeline says, and a reason typed into
 * the system must not become a spreadsheet formula on the way out.
 */
describe('Timeline paging and export', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  type Entry = { occurredAt: string; source: string; headline: string; detail: string | null };
  const key = (e: Entry) => `${e.occurredAt}|${e.source}|${e.headline}|${e.detail ?? ''}`;

  async function version(dossierId: string): Promise<number> {
    const [row] = await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [dossierId]);
    return row.version;
  }

  async function registeredRecord(subject: string) {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const draft = (
      await agent
        .post('/api/records/drafts')
        .send({ direction: 'INCOMING', subject, party: 'PARTY-SYN-A' })
        .expect(201)
    ).body;
    return (await agent.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)).body;
  }

  /** A matter with a dozen or so entries: records filed, deadlines moved. */
  async function busyMatter(reasons: string[] = []) {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const dossier = (await directeur.post('/api/dossiers').send({ subject: `Busy ${Date.now()}` }).expect(201)).body;
    for (let i = 0; i < 3; i++) {
      const record = await registeredRecord(`Brief ${i}`);
      await directeur.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: record.id }).expect(200);
    }
    const dates = ['2026-10-01', '2026-10-15', '2026-11-01', '2026-11-15'];
    for (let i = 0; i < dates.length; i++) {
      await directeur
        .post(`/api/dossiers/${dossier.id}/due-date`)
        .send({ dueDate: dates[i], reason: reasons[i] ?? `Uitstel ${i}`, version: await version(dossier.id) })
        .expect(200);
    }
    return { directeur, dossier };
  }

  async function readAllPages(agent: request.SuperAgentTest, dossierId: string, limit: number) {
    const pages: { entries: Entry[]; total: number; nextCursor: string | null }[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { limit: String(limit) };
      if (cursor) query.cursor = cursor;
      const page = (await agent.get(`/api/dossiers/${dossierId}/timeline/page`).query(query).expect(200)).body;
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor && pages.length < 100);
    return pages;
  }

  it('serves the same account page by page as in one read, in the same order', async () => {
    const { directeur, dossier } = await busyMatter();
    const whole: Entry[] = (await directeur.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    expect(whole.length).toBeGreaterThan(9);

    const pages = await readAllPages(directeur as unknown as request.SuperAgentTest, dossier.id, 4);
    const paged = pages.flatMap((p) => p.entries);
    expect(paged.map(key)).toEqual(whole.map(key));
    expect(pages.every((p) => p.total === whole.length)).toBe(true);
    expect(pages.slice(0, -1).every((p) => p.entries.length === 4)).toBe(true);
    expect(pages[pages.length - 1].nextCursor).toBeNull();
  });

  it('never serves an entry twice when an older record is filed between pages', async () => {
    const { directeur, dossier } = await busyMatter();
    // Registered now, filed later: its registration lands in the middle of the account.
    const older = await registeredRecord('Eerder geregistreerd');

    const first = (
      await directeur.get(`/api/dossiers/${dossier.id}/timeline/page`).query({ limit: 6 }).expect(200)
    ).body;
    await directeur.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: older.id }).expect(200);

    const rest: Entry[] = [];
    let cursor = first.nextCursor;
    let total = first.total;
    while (cursor) {
      const page = (
        await directeur.get(`/api/dossiers/${dossier.id}/timeline/page`).query({ cursor, limit: 6 }).expect(200)
      ).body;
      rest.push(...page.entries);
      total = page.total;
      cursor = page.nextCursor;
    }

    const served = [...first.entries, ...rest].map(key);
    expect(new Set(served).size).toBe(served.length);
    // The account grew behind the reader; the total says so.
    expect(total).toBeGreaterThan(first.total);
  });

  it('caps the page size and rejects a forged page reference', async () => {
    const { directeur, dossier } = await busyMatter();
    const big = (
      await directeur.get(`/api/dossiers/${dossier.id}/timeline/page`).query({ limit: 100000 }).expect(200)
    ).body;
    expect(big.entries.length).toBe(big.total);
    expect(big.nextCursor).toBeNull();

    const response = await directeur
      .get(`/api/dossiers/${dossier.id}/timeline/page`)
      .query({ cursor: 'not-a-cursor' })
      .expect(400);
    expect(response.body.message).toContain('page reference');
  });

  it('exports exactly what the timeline says, with its provenance', async () => {
    const { directeur, dossier } = await busyMatter();
    const whole: Entry[] = (await directeur.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;

    const response = await directeur.get(`/api/dossiers/${dossier.id}/timeline/export`).expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain(`${dossier.dossierIdentity}-timeline.csv`);

    const text: string = response.text;
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain(`"Dossier","${dossier.dossierIdentity}"`);
    expect(text).toContain('"Exported by","M. Sardjoe (directeur@juspol.test)"');
    expect(text).toContain(`"Entries","${whole.length}"`);

    const lines = text.trim().split('\r\n');
    const header = lines.findIndex((l) => l.startsWith('"Occurred at (UTC)"'));
    expect(lines.length - header - 1).toBe(whole.length);
    for (const entry of whole) {
      expect(text).toContain(`"${entry.occurredAt}","${entry.headline}"`);
    }
  });

  it('neutralises a reason that a spreadsheet would run as a formula', async () => {
    const { directeur, dossier } = await busyMatter(['=HYPERLINK("http://example.test","klik")', '+1+1', '@SUM(A1)']);
    const text = (await directeur.get(`/api/dossiers/${dossier.id}/timeline/export`).expect(200)).text;
    expect(text).toContain(`"'=HYPERLINK(""http://example.test"",""klik"")"`);
    expect(text).toContain(`"'+1+1"`);
    expect(text).toContain(`"'@SUM(A1)"`);
    expect(text).not.toMatch(/(^|,)"=/m);
  });

  it('records the export, and nothing else', async () => {
    const { directeur, dossier } = await busyMatter();
    const [{ n: eventsBefore }] = await h.db.query(`SELECT count(*)::int AS n FROM due_date_change`);
    const [{ n: versionBefore }] = await h.db.query(`SELECT version AS n FROM dossier WHERE id = $1`, [dossier.id]);

    await directeur.get(`/api/dossiers/${dossier.id}/timeline/export`).expect(200);

    await expectAuditEvent(h.db, 'TIMELINE_EXPORTED', dossier.dossierIdentity);
    const [{ n: eventsAfter }] = await h.db.query(`SELECT count(*)::int AS n FROM due_date_change`);
    const [{ n: versionAfter }] = await h.db.query(`SELECT version AS n FROM dossier WHERE id = $1`, [dossier.id]);
    expect(eventsAfter).toBe(eventsBefore);
    expect(versionAfter).toBe(versionBefore);
  });

  it('keeps paging and export closed to the administrator and to anyone without a session', async () => {
    const { dossier } = await busyMatter();
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    await admin.get(`/api/dossiers/${dossier.id}/timeline/page`).expect(403);
    await admin.get(`/api/dossiers/${dossier.id}/timeline/export`).expect(403);
    await request(h.app.getHttpServer()).get(`/api/dossiers/${dossier.id}/timeline/page`).expect(401);
    await request(h.app.getHttpServer()).get(`/api/dossiers/${dossier.id}/timeline/export`).expect(401);
    const [{ n }] = await h.db.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'TIMELINE_EXPORTED' AND subject_description LIKE $1`,
      [`${dossier.dossierIdentity}%`],
    );
    expect(n).toBe(0);
  });

  it('clamps a client-supplied page size', () => {
    expect(clampPageLimit(100000)).toBe(MAX_PAGE);
    expect(clampPageLimit(MAX_PAGE + 1)).toBe(MAX_PAGE);
    expect(clampPageLimit(7.9)).toBe(7);
    expect(clampPageLimit(0)).toBe(DEFAULT_PAGE);
    expect(clampPageLimit(-5)).toBe(DEFAULT_PAGE);
    expect(clampPageLimit(Number.NaN)).toBe(DEFAULT_PAGE);
  });

  it('refuses an unknown dossier', async () => {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const unknown = '00000000-0000-4000-8000-000000000000';
    await agent.get(`/api/dossiers/${unknown}/timeline/page`).expect(404);
    await agent.get(`/api/dossiers/${unknown}/timeline/export`).expect(404);
  });

  it('lets support staff page and export as they may read', async () => {
    const { dossier } = await busyMatter();
    const { agent } = await signIn(h.app, 'assistant2@juspol.test');
    await agent.get(`/api/dossiers/${dossier.id}/timeline/page`).expect(200);
    await agent.get(`/api/dossiers/${dossier.id}/timeline/export`).expect(200);
    expect(await accountIdFor(h.db, 'assistant2@juspol.test')).toBeTruthy();
  });
});
