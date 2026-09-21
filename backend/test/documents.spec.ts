import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { Harness, signIn, expectAuditEvent, startHarness } from './harness';

/**
 * Document capture and retrieval (FR-COR-006, FR-COR-014).
 *
 * TS02-TC-REG-012 is the case this spec exists for: captured content and its
 * provenance must survive registration and a session change unchanged, and
 * nothing in the process may alter, re-render or replace it. The distinctive
 * marker the test case asks a tester to record by eye is done here by comparing
 * the exact bytes.
 */
describe('Captured documents', () => {
  let h: Harness;
  beforeAll(async () => {
    // The store is content-addressed and survives a database reset, so a stale
    // or damaged file from an earlier run would be silently reused. Cleared
    // here so each run starts from nothing.
    await rm(process.env.DOCUMENT_STORAGE_PATH as string, { recursive: true, force: true });
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  // A tiny but genuine PDF, carrying a distinctive marker in its bytes.
  const MARKER = 'MARKER-DOC-SYN-INC-01';
  const pdf = Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${MARKER}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    'utf8',
  );

  async function itemFor(subject: string, register = true) {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const created = await agent
      .post('/api/records/drafts')
      .send({ direction: 'INCOMING', subject, party: 'PARTY-SYN-A' })
      .expect(201);
    if (!register) return { agent, item: created.body };
    const registered = await agent
      .post(`/api/records/${created.body.id}/register`)
      .send({ version: created.body.version })
      .expect(200);
    return { agent, item: registered.body };
  }

  it('captures a document and records its integrity reference and provenance', async () => {
    const { agent, item } = await itemFor('Capture with provenance');

    const response = await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, { filename: 'inkomende-brief.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(response.body.originalFilename).toBe('inkomende-brief.pdf');
    expect(response.body.mediaType).toBe('application/pdf');
    expect(response.body.byteSize).toBe(pdf.length);
    expect(response.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Provenance: who captured it, and when, by server time.
    expect(response.body.capturedByName).toBe('L. Amatredjo');
    expect(Date.now() - new Date(response.body.capturedAt).getTime()).toBeLessThan(60_000);
    await expectAuditEvent(h.db, 'DOCUMENT_CAPTURED', 'inkomende-brief.pdf');
  });

  /** TS02-TC-REG-012: the same bytes come back, across a session change. */
  it('returns the captured content byte-for-byte, and again after signing in afresh', async () => {
    const { agent, item } = await itemFor('Byte fidelity');
    const captured = await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, { filename: 'scan.pdf', contentType: 'application/pdf' })
      .expect(201);

    const first = await agent
      .get(`/api/records/${item.id}/documents/${captured.body.id}/content`)
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(Buffer.compare(first.body as Buffer, pdf)).toBe(0);
    expect((first.body as Buffer).toString('utf8')).toContain(MARKER);
    expect(first.headers['content-disposition']).toContain('scan.pdf');
    expect(first.headers['content-type']).toContain('application/pdf');
    expect(first.headers['x-content-type-options']).toBe('nosniff');

    // New session, same content.
    const { agent: later } = await signIn(h.app, 'assistant1@juspol.test');
    const second = await later
      .get(`/api/records/${item.id}/documents/${captured.body.id}/content`)
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(second.body as Buffer, pdf)).toBe(0);
    await expectAuditEvent(h.db, 'DOCUMENT_RETRIEVED', 'scan.pdf');
  });

  it('computes the hash over the received bytes, not over anything the client claims', async () => {
    const { agent, item } = await itemFor('Hash correctness');
    const captured = await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(201);

    const { createHash } = await import('crypto');
    expect(captured.body.contentHash).toBe(createHash('sha256').update(pdf).digest('hex'));
  });

  /**
   * The control that makes the integrity reference worth having: altered stored
   * content is refused rather than served as authoritative evidence.
   */
  it('refuses to serve content that no longer matches its integrity reference', async () => {
    const { agent, item } = await itemFor('Tamper detection');
    const captured = await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, { filename: 'tamper.pdf', contentType: 'application/pdf' })
      .expect(201);

    const [row] = await h.db.query(`SELECT storage_key FROM captured_document WHERE id = $1`, [
      captured.body.id,
    ]);
    const path = join(process.env.DOCUMENT_STORAGE_PATH as string, row.storage_key);
    const original = await readFile(path);
    try {
      await writeFile(
        path,
        Buffer.from(original.toString('utf8').replace(MARKER, 'ALTERED-CONTENT')),
      );
      await agent
        .get(`/api/records/${item.id}/documents/${captured.body.id}/content`)
        .expect(500);
      await expectAuditEvent(h.db, 'DOCUMENT_INTEGRITY_FAILED', 'tamper.pdf');
    } finally {
      // Restored even when the assertion above fails. Without this, a failing
      // run leaves damaged content in the store and every later run reusing
      // that hash fails for the wrong reason.
      await writeFile(path, original);
    }
  });

  it('keeps every capture, so a later document never replaces an earlier one', async () => {
    const { agent, item } = await itemFor('Append only');
    const second = Buffer.from(pdf.toString('utf8').replace(MARKER, 'MARKER-SECOND'), 'utf8');

    await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, { filename: 'first.pdf', contentType: 'application/pdf' })
      .expect(201);
    await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', second, { filename: 'second.pdf', contentType: 'application/pdf' })
      .expect(201);

    const list = await agent.get(`/api/records/${item.id}/documents`).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.map((d: { originalFilename: string }) => d.originalFilename)).toEqual([
      'first.pdf',
      'second.pdf',
    ]);
    expect(list.body[0].contentHash).not.toBe(list.body[1].contentHash);
  });

  it('discards edits and deletes against the capture record', async () => {
    const { agent, item } = await itemFor('History protection');
    const captured = await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, { filename: 'protected.pdf', contentType: 'application/pdf' })
      .expect(201);

    await h.db.query(`UPDATE captured_document SET content_hash = repeat('0', 64)`);
    await h.db.query(`DELETE FROM captured_document WHERE id = $1`, [captured.body.id]);

    const [row] = await h.db.query(
      `SELECT content_hash, original_filename FROM captured_document WHERE id = $1`,
      [captured.body.id],
    );
    expect(row.content_hash).toBe(captured.body.contentHash);
    expect(row.original_filename).toBe('protected.pdf');
  });

  it('can capture against a draft as well as a registered record', async () => {
    const { agent, item } = await itemFor('Draft capture', false);
    expect(item.state).toBe('DRAFT');
    await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, { filename: 'draft-scan.pdf', contentType: 'application/pdf' })
      .expect(201);
  });

  it('refuses an unaccepted media type and an empty file', async () => {
    const { agent, item } = await itemFor('Type and size rules');

    await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', Buffer.from('#!/bin/sh\necho hello\n'), {
        filename: 'script.sh',
        contentType: 'application/x-sh',
      })
      .expect(415);

    await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', Buffer.alloc(0), { filename: 'empty.pdf', contentType: 'application/pdf' })
      .expect(400);
  });

  it('strips any path from the supplied filename', async () => {
    const { agent, item } = await itemFor('Filename handling');
    const captured = await agent
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, {
        filename: '../../etc/passwd.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    expect(captured.body.originalFilename).toBe('passwd.pdf');
  });

  it('keeps content closed to the administrator and to anyone without a session', async () => {
    const { item } = await itemFor('Access control');
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    await admin.get(`/api/records/${item.id}/documents`).expect(403);
    await admin
      .post(`/api/records/${item.id}/documents`)
      .attach('file', pdf, { filename: 'admin.pdf', contentType: 'application/pdf' })
      .expect(403);
    await require('supertest')(h.app.getHttpServer())
      .get(`/api/records/${item.id}/documents`)
      .expect(401);
  });
});
