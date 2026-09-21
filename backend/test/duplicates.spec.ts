import { expectAuditEvent, Harness, signIn, startHarness } from './harness';

/**
 * The duplicate warning (FR-COR-016; TS-02 case 026).
 *
 * The warning is optional; the protection is not. These tests hold both: a
 * likely duplicate is named, and naming it changes nothing — no merge, no
 * block, no write. Registration proceeds and yields a second, distinct record.
 */
describe('Possible duplicates', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const scan = (marker: string) =>
    Buffer.from(`%PDF-1.4\n% ${marker}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'utf8');

  async function assistant() {
    return (await signIn(h.app, 'assistant1@juspol.test')).agent;
  }

  async function draft(
    agent: Awaited<ReturnType<typeof assistant>>,
    fields: { subject: string; party?: string | null; direction?: string },
    document?: { bytes: Buffer; filename: string },
  ) {
    const created = (
      await agent
        .post('/api/records/drafts')
        .send({ direction: fields.direction ?? 'INCOMING', subject: fields.subject, party: fields.party ?? undefined })
        .expect(201)
    ).body;
    if (document) {
      await agent
        .post(`/api/records/${created.id}/documents`)
        .attach('file', document.bytes, { filename: document.filename, contentType: 'application/pdf' })
        .expect(201);
    }
    const [{ version }] = await h.db.query(`SELECT version FROM correspondence_item WHERE id = $1`, [created.id]);
    return { ...created, version };
  }

  async function register(agent: Awaited<ReturnType<typeof assistant>>, item: { id: string; version: number }) {
    return (await agent.post(`/api/records/${item.id}/register`).send({ version: item.version }).expect(200)).body;
  }

  async function snapshotOf(itemId: string) {
    const [row] = await h.db.query(
      `SELECT ci.registration_identity, ci.subject, ci.party, ci.state, ci.version,
              array_agg(cd.content_hash ORDER BY cd.content_hash) AS hashes
         FROM correspondence_item ci
         LEFT JOIN captured_document cd ON cd.correspondence_item_id = ci.id
        WHERE ci.id = $1
        GROUP BY ci.id`,
      [itemId],
    );
    return row;
  }

  it('names a registered record carrying a byte-identical document, and registration still proceeds as a separate record', async () => {
    const agent = await assistant();
    const bytes = scan(`IDENTICAL-${Date.now()}`);
    const original = await register(
      agent,
      await draft(agent, { subject: 'Inzageverzoek dossier 44', party: 'PARTY-SYN-A' }, { bytes, filename: 'DOC-SYN-INC-01.pdf' }),
    );
    const before = await snapshotOf(original.id);
    const [{ n: countBefore }] = await h.db.query(
      `SELECT count(*)::int AS n FROM correspondence_item WHERE state = 'REGISTERED'`,
    );

    // Same bytes, different filename, different subject: only the document matches.
    const second = await draft(agent, { subject: 'Andere omschrijving', party: 'PARTY-SYN-B' }, { bytes, filename: 'DOC-SYN-INC-02.pdf' });
    const warning = (await agent.get(`/api/records/${second.id}/possible-duplicates`).expect(200)).body;
    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatchObject({
      itemId: original.id,
      registrationIdentity: original.registrationIdentity,
      reasons: ['IDENTICAL_DOCUMENT'],
    });

    const registered = await register(agent, second);
    expect(registered.registrationIdentity).toBeTruthy();
    expect(registered.registrationIdentity).not.toBe(original.registrationIdentity);

    const [{ n: countAfter }] = await h.db.query(
      `SELECT count(*)::int AS n FROM correspondence_item WHERE state = 'REGISTERED'`,
    );
    expect(countAfter).toBe(countBefore + 1);
    expect(await snapshotOf(original.id)).toEqual(before);
  });

  it('names a registered record with the same direction, subject and party, ignoring case and spacing', async () => {
    const agent = await assistant();
    const original = await register(agent, await draft(agent, { subject: 'Klacht over vergunning', party: 'Advocatenkantoor X' }));
    const second = await draft(agent, { subject: '  KLACHT over Vergunning ', party: 'advocatenkantoor x' });

    const warning = (await agent.get(`/api/records/${second.id}/possible-duplicates`).expect(200)).body;
    expect(warning.map((w: { itemId: string }) => w.itemId)).toEqual([original.id]);
    expect(warning[0].reasons).toEqual(['SAME_SUBJECT_AND_PARTY']);
  });

  it('reports both reasons once when both match', async () => {
    const agent = await assistant();
    const bytes = scan(`BOTH-${Date.now()}`);
    const original = await register(
      agent,
      await draft(agent, { subject: 'Beide redenen', party: 'PARTY-SYN-C' }, { bytes, filename: 'a.pdf' }),
    );
    const second = await draft(agent, { subject: 'Beide redenen', party: 'PARTY-SYN-C' }, { bytes, filename: 'b.pdf' });

    const warning = (await agent.get(`/api/records/${second.id}/possible-duplicates`).expect(200)).body;
    expect(warning).toHaveLength(1);
    expect(warning[0].itemId).toBe(original.id);
    expect([...warning[0].reasons].sort()).toEqual(['IDENTICAL_DOCUMENT', 'SAME_SUBJECT_AND_PARTY']);
  });

  it('does not match across direction, across party, against drafts, or against itself', async () => {
    const agent = await assistant();
    const subject = `Geen match ${Date.now()}`;
    await register(agent, await draft(agent, { subject, party: 'PARTY-SYN-D', direction: 'OUTGOING' }));
    await register(agent, await draft(agent, { subject, party: 'PARTY-SYN-OTHER' }));
    await draft(agent, { subject, party: 'PARTY-SYN-D' }); // a draft, never a candidate

    const mine = await draft(agent, { subject, party: 'PARTY-SYN-D' });
    expect((await agent.get(`/api/records/${mine.id}/possible-duplicates`).expect(200)).body).toEqual([]);

    const registeredMine = await register(agent, mine);
    expect((await agent.get(`/api/records/${registeredMine.id}/possible-duplicates`).expect(200)).body).toEqual([]);
  });

  it('writes nothing when asked', async () => {
    const agent = await assistant();
    const bytes = scan(`QUIET-${Date.now()}`);
    await register(agent, await draft(agent, { subject: 'Stil', party: 'P' }, { bytes, filename: 'x.pdf' }));
    const second = await draft(agent, { subject: 'Stil', party: 'P' }, { bytes, filename: 'y.pdf' });

    const counts = async () =>
      (
        await h.db.query(
          `SELECT (SELECT count(*) FROM audit_event)::int AS audit,
                  (SELECT count(*) FROM correspondence_item)::int AS items,
                  (SELECT count(*) FROM captured_document)::int AS docs,
                  (SELECT version FROM correspondence_item WHERE id = $1) AS version`,
          [second.id],
        )
      )[0];
    const before = await counts();
    await agent.get(`/api/records/${second.id}/possible-duplicates`).expect(200);
    await agent.get(`/api/records/${second.id}/possible-duplicates`).expect(200);
    expect(await counts()).toEqual(before);
  });

  it('still records the registration of a warned-about record in the ordinary way', async () => {
    const agent = await assistant();
    const bytes = scan(`AUDIT-${Date.now()}`);
    await register(agent, await draft(agent, { subject: 'Audit dup', party: 'Q' }, { bytes, filename: 'x.pdf' }));
    const second = await draft(agent, { subject: 'Audit dup', party: 'Q' }, { bytes, filename: 'y.pdf' });
    const registered = await register(agent, second);
    await expectAuditEvent(h.db, 'ITEM_REGISTERED', registered.registrationIdentity);
  });

  it('is closed to the administrator and refuses an unknown record', async () => {
    const agent = await assistant();
    const mine = await draft(agent, { subject: 'Toegang', party: 'R' });
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    await admin.get(`/api/records/${mine.id}/possible-duplicates`).expect(403);
    await agent.get('/api/records/00000000-0000-4000-8000-000000000000/possible-duplicates').expect(404);
  });
});
