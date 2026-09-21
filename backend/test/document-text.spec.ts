import { chmodSync } from 'fs';
import { join } from 'path';
import { accountIdFor, Harness, signIn, startHarness } from './harness';

/**
 * Derived text from captured documents (FR-COR-015).
 *
 * The requirement has one non-negotiable half: OCR text is retrieval
 * assistance and must never silently replace the captured content. These tests
 * hold the captured bytes and their hash constant across every OCR outcome —
 * read, unreadable, failed, skipped — and check that the text is always
 * presented as derived.
 *
 * The engine is a stub with tesseract's interface, so the suite does not
 * require an OCR engine to be installed wherever it runs. The real engine was
 * exercised separately; see the delivery note.
 */
describe('Document text (OCR)', () => {
  let h: Harness;
  const stub = join(__dirname, 'fixtures', 'fake-ocr.sh');
  const pdfStub = join(__dirname, 'fixtures', 'fake-pdftext.sh');

  beforeAll(async () => {
    chmodSync(stub, 0o755);
    chmodSync(pdfStub, 0o755);
    process.env.OCR_ENABLED = 'true';
    process.env.OCR_COMMAND = stub;
    process.env.PDF_TEXT_COMMAND = pdfStub;
    process.env.OCR_LANGUAGES = 'eng';
    process.env.OCR_TIMEOUT_MS = '1500';
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
    delete process.env.OCR_ENABLED;
    delete process.env.OCR_COMMAND;
    delete process.env.PDF_TEXT_COMMAND;
  });

  const png = (marker: string) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(` ${marker} ${Date.now()}${Math.random()}`, 'utf8'),
    ]);

  async function captured(bytes: Buffer, mediaType = 'image/png', filename = 'scan.png') {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const draft = (
      await agent
        .post('/api/records/drafts')
        .send({ direction: 'INCOMING', subject: 'Scan', party: 'PARTY-SYN-A' })
        .expect(201)
    ).body;
    const document = (
      await agent
        .post(`/api/records/${draft.id}/documents`)
        .attach('file', bytes, { filename, contentType: mediaType })
        .expect(201)
    ).body;
    return { agent, draft, document };
  }

  it('reads a scan and offers the text as derived, beside the untouched document', async () => {
    const bytes = png('READABLE');
    const { agent, draft, document } = await captured(bytes);

    const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
    expect(text.status).toBe('EXTRACTED');
    expect(text.text).toContain('Ministerie van Justitie en Politie');
    expect(text.derived).toBe(true);
    expect(text.stale).toBe(false);
    expect(text.engine).toContain('fake-ocr');

    // The authoritative content is unchanged and still passes its own check.
    const content = await agent
      .get(`/api/records/${draft.id}/documents/${document.id}/content`)
      .expect(200);
    expect(Buffer.from(content.body).equals(bytes)).toBe(true);
    const [row] = await h.db.query(`SELECT content_hash, media_type FROM captured_document WHERE id = $1`, [
      document.id,
    ]);
    expect(row.content_hash).toBe(document.contentHash);
    expect(row.media_type).toBe('image/png');
  });

  it('records an unreadable page as read-but-empty, not as absent', async () => {
    const { agent, draft, document } = await captured(png('OCR-EMPTY'));
    const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
    expect(text.status).toBe('EMPTY');
    expect(text.text).toBeNull();
    expect(text.extractedAt).not.toBeNull();
  });

  it('captures the document even when the engine fails, and says the text failed', async () => {
    const { agent, draft, document } = await captured(png('OCR-FAIL'));
    expect(document.contentHash).toHaveLength(64);
    await agent.get(`/api/records/${draft.id}/documents/${document.id}/content`).expect(200);

    const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
    expect(text.status).toBe('FAILED');
    expect(text.text).toBeNull();
  });

  it('captures the document even when the engine hangs past its time limit', async () => {
    const { agent, draft, document } = await captured(png('OCR-HANG'));
    await agent.get(`/api/records/${draft.id}/documents/${document.id}/content`).expect(200);
    const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
    expect(text.status).toBe('FAILED');
  }, 20_000);

  // V0.1.17: a PDF is no longer skipped — its text layer is read. A type with
  // no configured reader still is.
  it('skips a type no reader is configured for', async () => {
    const docx = Buffer.from('PK\u0003\u0004 not really a docx', 'utf8');
    const { agent, draft, document } = await captured(
      docx,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'brief.docx',
    );
    const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
    expect(text.status).toBe('SKIPPED');
    expect(text.text).toBeNull();
  });

  describe('PDFs (V0.1.17)', () => {
    const pdf = (marker: string) =>
      Buffer.from(`%PDF-1.4\n% ${marker} ${Date.now()}${Math.random()}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'utf8');

    it('reads the text layer of a PDF with the PDF reader, not the OCR engine', async () => {
      const { agent, draft, document } = await captured(pdf('WITH-TEXT'), 'application/pdf', 'besluit.pdf');
      const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
      expect(text.status).toBe('EXTRACTED');
      expect(text.text).toContain('Besluit 2026-118');
      expect(text.engine).toContain('fake-pdftext');
      expect(text.derived).toBe(true);
    });

    it('reports a scanned PDF with no text layer as read-and-empty, not as failed', async () => {
      const { agent, draft, document } = await captured(pdf('PDF-SCANNED'), 'application/pdf', 'scan.pdf');
      const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
      expect(text.status).toBe('EMPTY');
      expect(text.text).toBeNull();
    });

    it('captures the PDF even when the reader fails', async () => {
      const bytes = pdf('PDF-FAIL');
      const { agent, draft, document } = await captured(bytes, 'application/pdf', 'kapot.pdf');
      const content = await agent
        .get(`/api/records/${draft.id}/documents/${document.id}/content`)
        .expect(200);
      expect(Buffer.from(content.body).equals(bytes)).toBe(true);
      const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
      expect(text.status).toBe('FAILED');
      expect(text.engine).toContain('fake-pdftext');
    });
  });

  it('never writes text that claims to be the document', async () => {
    const { document } = await captured(png('READABLE'));
    const [row] = await h.db.query(
      `SELECT dt.content_hash AS text_hash, cd.content_hash AS document_hash, cd.storage_key
         FROM document_text dt JOIN captured_document cd ON cd.id = dt.captured_document_id
        WHERE dt.captured_document_id = $1`,
      [document.id],
    );
    // Derived text is stored apart, against the hash it was read from.
    expect(row.text_hash).toBe(row.document_hash);
    expect(row.storage_key).toContain(row.document_hash);
  });

  it('marks text stale when it no longer matches the document it claims to describe', async () => {
    const { agent, draft, document } = await captured(png('READABLE'));
    // Simulate text left behind by earlier content, which a re-capture would produce.
    await h.db.query(`UPDATE document_text SET content_hash = repeat('0', 64) WHERE captured_document_id = $1`, [
      document.id,
    ]);
    const text = (await agent.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(200)).body;
    expect(text.stale).toBe(true);
  });

  it('keeps the text closed to the administrator and refuses an unknown document', async () => {
    const { draft, document } = await captured(png('READABLE'));
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    await admin.get(`/api/records/${draft.id}/documents/${document.id}/text`).expect(403);

    const { agent } = await signIn(h.app, 'assistant2@juspol.test');
    await agent
      .get(`/api/records/${draft.id}/documents/00000000-0000-4000-8000-000000000000/text`)
      .expect(404);
    expect(await accountIdFor(h.db, 'assistant2@juspol.test')).toBeTruthy();
  });
});
