import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { newPdf, pdfBuffer } from '../src/core/pdf';
import { IntegrationKeysService } from '../src/integrations/integration-keys.service';
import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MailComposer = require('nodemailer/lib/mail-composer');

/**
 * Letters and documents: preview, integrity, malware refusal, scanned-paper
 * OCR in Dutch, labels and receipts, citizen tracking, standard letters, draft
 * versions, the composed letter with its seal, and e-mail intake.
 */
describe('Phase 3 letters and documents', () => {
  let h: Harness;
  const dir = mkdtempSync(join(tmpdir(), 'letters-'));
  beforeAll(async () => {
    process.env.OCR_ENABLED = 'true';
    process.env.OCR_LANGUAGES = 'nld+eng';
    process.env.OCR_TIMEOUT_MS = '60000';
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
    delete process.env.OCR_ENABLED;
    delete process.env.OCR_LANGUAGES;
    delete process.env.OCR_TIMEOUT_MS;
  });

  const pdfText = (bytes: Buffer): string => {
    const file = join(dir, `t-${Math.random()}.pdf`);
    writeFileSync(file, bytes);
    return execFileSync('pdftotext', [file, '-']).toString();
  };

  async function registered(subject: string, extra: Record<string, unknown> = {}) {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const draft = (await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject, party: 'Stichting Rechtshulp', documentDate: '2026-10-20', senderReference: 'SR/2026/114', ...extra }).expect(201)).body;
    const item = (await agent.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)).body;
    return { agent, item };
  }

  it('reads a scanned paper letter by OCR, in Dutch, from the page images', async () => {
    const png = join(dir, 'scan.png');
    execFileSync('convert', ['-size', '1400x500', 'xc:white', '-font', 'DejaVu-Sans', '-pointsize', '44', '-fill', 'black',
      '-annotate', '+60+140', 'Verzoek om herziening van het', '-annotate', '+60+220', 'detentiebeleid in Santo Boma', png]);
    const doc = newPdf();
    doc.image(readFileSync(png), 40, 60, { width: 515 });
    const scanned = await pdfBuffer(doc);
    expect(pdfText(scanned).trim()).toBe('');
    const { agent, item } = await registered('Gescande brief');
    const captured = (await agent.post(`/api/records/${item.id}/documents`).attach('file', scanned, { filename: 'scan.pdf', contentType: 'application/pdf' }).expect(201)).body;
    const text = (await agent.get(`/api/records/${item.id}/documents/${captured.id}/text`).expect(200)).body;
    expect(text.status).toBe('EXTRACTED');
    expect(text.method).toBe('PAGE_OCR');
    expect(text.engine).toContain('nld+eng');
    expect(text.text.toLowerCase()).toContain('detentiebeleid');
    expect(text.derived).toBe(true);
  });

  it('shows a document inline, checks its fingerprint, and logs who looked', async () => {
    const { agent, item } = await registered('Preview test');
    const pdf = await pdfBuffer(newPdf().text('Preview inhoud'));
    const doc = (await agent.post(`/api/records/${item.id}/documents`).attach('file', pdf, { filename: 'brief.pdf', contentType: 'application/pdf' }).expect(201)).body;
    const preview = await agent.get(`/api/records/${item.id}/documents/${doc.id}/preview`).expect(200);
    expect(preview.headers['content-disposition']).toMatch(/^inline/);
    expect(preview.headers['content-type']).toBe('application/pdf');
    const verify = (await agent.get(`/api/records/${item.id}/documents/${doc.id}/verify`).expect(200)).body;
    expect(verify.intact).toBe(true);
    expect(verify.contentHash).toBe(doc.contentHash);
    // A document cannot be fetched through a different record's address.
    const other = await registered('Ander stuk');
    await agent.get(`/api/records/${other.item.id}/documents/${doc.id}/preview`).expect(404);
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const views = (await directeur.get(`/api/access/items/${item.id}/views`).expect(200)).body;
    expect(views.map((v: { kind: string }) => v.kind)).toContain('PREVIEWED');
    // Tampering with the stored bytes is detected.
    const [row] = await h.db.query(`SELECT storage_key FROM captured_document WHERE id = $1`, [doc.id]);
    writeFileSync(join(process.env.DOCUMENT_STORAGE_PATH as string, row.storage_key), Buffer.from('tampered'));
    const after = (await agent.get(`/api/records/${item.id}/documents/${doc.id}/verify`).expect(200)).body;
    expect(after.intact).toBe(false);
  });

  it('refuses malware on a record and keeps no trace of it in storage', async () => {
    const { agent, item } = await registered('Malware test');
    const exe = Buffer.alloc(256);
    exe.write('MZ', 0);
    exe.writeUInt32LE(0x80, 0x3c);
    exe.write('PE\0\0', 0x80, 'latin1');
    await agent.post(`/api/records/${item.id}/documents`).attach('file', exe, { filename: 'factuur.pdf', contentType: 'application/pdf' }).expect(422);
    const js = Buffer.from('%PDF-1.4\n1 0 obj<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>endobj\n%%EOF');
    await agent.post(`/api/records/${item.id}/documents`).attach('file', js, { filename: 'brief.pdf', contentType: 'application/pdf' }).expect(422);
    const docs = (await agent.get(`/api/records/${item.id}/documents`).expect(200)).body;
    expect(docs).toHaveLength(0);
    await expectAuditEvent(h.db, 'DOCUMENT_REJECTED_MALWARE', 'factuur.pdf');
  });

  it('prints a label and a receipt with the tracking code, and lets the citizen follow the letter', async () => {
    const { agent, item } = await registered('Volgbare brief');
    const tracking = (await agent.get(`/api/records/${item.id}/tracking`).expect(200)).body;
    expect(tracking.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const label = await agent.get(`/api/records/${item.id}/label.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(pdfText(label.body)).toContain(item.registrationIdentity);
    const receipt = await agent.get(`/api/records/${item.id}/receipt.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const receiptText = pdfText(receipt.body);
    expect(receiptText).toContain('Ontvangstbevestiging');
    expect(receiptText).toContain(tracking.code);
    await expectAuditEvent(h.db, 'LABEL_PRINTED', item.registrationIdentity);

    const pub = request(h.app.getHttpServer());
    await pub.post('/api/public/track').send({ reference: item.registrationIdentity, code: 'AAAA-BBBB' }).expect(404);
    const status = (await pub.post('/api/public/track').send({ reference: item.registrationIdentity, code: tracking.code.toLowerCase() }).expect(200)).body;
    expect(status.status).toBe('RECEIVED');
    expect(status.subject).toBeUndefined();
    expect(status.expectedBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dossier = (await agent.post('/api/dossiers').send({ subject: 'Behandeling volgbare brief' }).expect(201)).body;
    await agent.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: item.id }).expect(200);
    const progress = (await pub.post('/api/public/track').send({ reference: item.registrationIdentity, code: tracking.code }).expect(200)).body;
    expect(progress.status).toBe('IN_PROGRESS');
  });

  it('stops answering an address after repeated wrong guesses', async () => {
    const pub = request(h.app.getHttpServer());
    for (let i = 0; i < 10; i += 1) {
      await pub.post('/api/public/track').set('X-Forwarded-For', '203.0.113.9').send({ reference: 'IN-2026-99999', code: 'ZZZZ-ZZZZ' }).expect(404);
    }
    await pub.post('/api/public/track').set('X-Forwarded-For', '203.0.113.9').send({ reference: 'IN-2026-99999', code: 'ZZZZ-ZZZZ' }).expect(429);
  });

  it('starts a reply from a standard letter and keeps every version of the text', async () => {
    const { agent, item } = await registered('Verzoek om informatie over subsidie');
    const templates = (await agent.get('/api/letters/templates').expect(200)).body;
    expect(templates.map((t: { code: string }) => t.code)).toEqual(expect.arrayContaining(['ONTVANGST', 'ANTWOORD', 'DOORVERWIJZING', 'UITNODIGING']));
    const antwoord = templates.find((t: { code: string }) => t.code === 'ANTWOORD');
    const reply = (await agent.post(`/api/records/${item.id}/reply`).send({ templateId: antwoord.id }).expect(201)).body;
    expect(reply.direction).toBe('OUTGOING');
    expect(reply.party).toBe('Stichting Rechtshulp');
    let versions = (await agent.get(`/api/records/${reply.id}/draft-versions`).expect(200)).body;
    expect(versions).toHaveLength(1);
    expect(versions[0].body).toContain('20 oktober 2026');
    expect(versions[0].body).toContain('SR/2026/114');
    expect(versions[0].body).toContain('Verzoek om informatie over subsidie');
    await agent.post(`/api/records/${reply.id}/draft-versions`).send({ body: versions[0].body.replace('[Inhoudelijke reactie]', 'Uw verzoek wordt gehonoreerd.'), note: 'Inhoud ingevuld' }).expect(201);
    versions = (await agent.get(`/api/records/${reply.id}/draft-versions`).expect(200)).body;
    expect(versions.map((v: { versionNo: number }) => v.versionNo)).toEqual([1, 2]);
    await h.db.query(`UPDATE item_draft_version SET body = 'overschreven' WHERE item_id = $1 AND version_no = 1`, [reply.id]);
    const [v1] = await h.db.query(`SELECT body FROM item_draft_version WHERE item_id = $1 AND version_no = 1`, [reply.id]);
    expect(v1.body).not.toBe('overschreven');
  });

  it('composes a concept, then a final sealed letter that anyone can verify', async () => {
    const { agent, item } = await registered('Klacht over afhandeling aangifte');
    const reply = (await agent.post(`/api/records/${item.id}/reply`).send({}).expect(201)).body;
    await agent.post(`/api/records/${reply.id}/compose`).send({}).expect(400);
    await agent.post(`/api/records/${reply.id}/draft-versions`).send({ body: 'Geachte heer/mevrouw,\n\nUw klacht is onderzocht en gegrond verklaard.' }).expect(201);
    const concept = (await agent.post(`/api/records/${reply.id}/compose`).send({}).expect(201)).body;
    expect(concept.document.originalFilename).toMatch(/^Concept-/);
    await agent.post(`/api/records/${reply.id}/compose`).send({ seal: true }).expect(400);
    const [{ version }] = await h.db.query(`SELECT version FROM correspondence_item WHERE id = $1`, [reply.id]);
    const final = (await agent.post(`/api/records/${reply.id}/register`).send({ version }).expect(200)).body;
    await agent.post(`/api/records/${reply.id}/draft-versions`).send({ body: 'na registratie' }).expect(400);
    // Support staff may not seal.
    await agent.post(`/api/records/${reply.id}/compose`).send({ seal: true }).expect(403);
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const sealed = (await directeur.post(`/api/records/${reply.id}/compose`).send({ seal: true }).expect(201)).body;
    expect(sealed.seal.id).toMatch(/^[0-9a-f-]{36}$/);
    await expectAuditEvent(h.db, 'SEAL_APPLIED', final.registrationIdentity);
    const pub = request(h.app.getHttpServer());
    const check = (await pub.get(`/api/public/seals/${sealed.seal.id}`).expect(200)).body;
    expect(check.valid).toBe(true);
    expect(check.registrationIdentity).toBe(final.registrationIdentity);
    expect(check.documentSha256).toBe(sealed.document.contentHash);
    expect(check.subject).toBeUndefined();
    const key = (await pub.get('/api/public/seal-key').expect(200)).body;
    expect(key.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    // The PDF itself names its seal.
    const [{ storage_key }] = await h.db.query(`SELECT storage_key FROM captured_document WHERE id = $1`, [sealed.document.id]);
    const text = pdfText(readFileSync(join(process.env.DOCUMENT_STORAGE_PATH as string, storage_key)));
    expect(text).toContain(final.registrationIdentity);
    // The verification address may wrap across lines in the PDF's text.
    expect(text).toContain(`/verifieren/${sealed.seal.id}`);
    expect(text).not.toContain('CONCEPT');
    // A tampered stored letter no longer verifies.
    writeFileSync(join(process.env.DOCUMENT_STORAGE_PATH as string, storage_key), Buffer.from('tampered'));
    const broken = (await pub.get(`/api/public/seals/${sealed.seal.id}`).expect(200)).body;
    expect(broken.valid).toBe(false);
    await pub.get('/api/public/seals/00000000-0000-4000-8000-000000000000').expect(404);
  });

  async function eml(subject: string, messageId: string, attachments: { filename: string; content: Buffer; contentType: string }[]) {
    return new Promise<Buffer>((resolve, reject) =>
      new MailComposer({
        from: 'Burger Jansen <burger@example.sr>',
        to: 'post@juspol.sr',
        subject,
        messageId,
        date: new Date('2026-10-27T13:00:00Z'),
        text: 'Geachte minister,\n\nGraag een reactie binnen 14 dagen.\n\nMet vriendelijke groet',
        attachments,
      }).compile().build((err: Error | null, msg: Buffer) => (err ? reject(err) : resolve(msg))),
    );
  }

  it('takes an e-mail in as a draft with its attachments, once', async () => {
    const pdf = await pdfBuffer(newPdf().text('Bijlage bij e-mail'));
    const raw = await eml('Verzoek om gesprek', '<abc-123@example.sr>', [
      { filename: 'bijlage.pdf', content: pdf, contentType: 'application/pdf' },
      { filename: 'programma.exe', content: Buffer.from('MZ'), contentType: 'application/x-msdownload' },
    ]);
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const result = (await agent.post('/api/intake/email').attach('message', raw, { filename: 'mail.eml', contentType: 'message/rfc822' }).expect(201)).body;
    expect(result.item.subject).toBe('Verzoek om gesprek');
    expect(result.item.party).toBe('Burger Jansen <burger@example.sr>');
    expect(result.item.state).toBe('DRAFT');
    expect(result.captured.map((c: { filename: string }) => c.filename)).toEqual(['E-mailbericht.pdf', 'bijlage.pdf']);
    expect(result.skipped[0].filename).toBe('programma.exe');
    const [row] = await h.db.query(`SELECT source, document_date::text AS d FROM correspondence_item WHERE id = $1`, [result.item.id]);
    expect(row.source).toBe('EMAIL');
    expect(row.d).toBe('2026-10-27');
    await agent.post('/api/intake/email').attach('message', raw, { filename: 'mail.eml', contentType: 'message/rfc822' }).expect(409);
    await expectAuditEvent(h.db, 'EMAIL_INTAKE_RECEIVED', 'Burger Jansen');
  });

  it('accepts e-mail from the mail server only with a valid integration key', async () => {
    const keys = h.app.get(IntegrationKeysService);
    const clerk = await accountIdFor(h.db, 'assistant2@juspol.test');
    const created = await keys.create({ accountId: clerk, description: 'test' }, { name: 'Mailserver', kind: 'MAIL_GATEWAY', actAsAccountId: clerk });
    const raw = await eml('Via de mailserver', '<gw-1@example.sr>', []);
    const pub = request(h.app.getHttpServer());
    await pub.post('/api/intake/email/gateway').set('Content-Type', 'message/rfc822').set('X-Api-Key', 'jp_000000000000_nope-nope-nope-nope-nope').send(raw).expect(401);
    const result = (await pub.post('/api/intake/email/gateway').set('Content-Type', 'message/rfc822').set('X-Api-Key', created.key).send(raw).expect(201)).body;
    expect(result.item.subject).toBe('Via de mailserver');
    const [note] = await h.db.query(`SELECT kind FROM notification WHERE account_id = $1 AND kind = 'INTAKE_RECEIVED'`, [clerk]);
    expect(note.kind).toBe('INTAKE_RECEIVED');
    const [{ created_by }] = await h.db.query(`SELECT created_by_account_id AS created_by FROM correspondence_item WHERE id = $1`, [result.item.id]);
    expect(created_by).toBe(clerk);
    await keys.revoke({ accountId: clerk, description: 'test' }, created.id);
    await pub.post('/api/intake/email/gateway').set('Content-Type', 'message/rfc822').set('X-Api-Key', created.key).send(raw).expect(401);
  });
});
