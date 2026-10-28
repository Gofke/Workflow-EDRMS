import ExcelJS from 'exceljs';
import { generateKeyPairSync, sign } from 'crypto';
import { readFile, rename, writeFile } from 'fs/promises';
import JSZip from 'jszip';
import { join } from 'path';
import { hashPassword } from '../src/auth/password';
import { loadDocumentConfig } from '../src/config/document-config';
import { canonicalJson } from '../src/core/seal.service';
import { Harness, SEED_PASSWORD, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * The auditor's tools (audit viewer, exports, integrity check with anchors and
 * a sealed report), integration keys, the WijSamen intake and the signed
 * exchange of records with other organisations.
 */
describe('Phase 3 oversight and integrations', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    const passwordHash = await hashPassword(SEED_PASSWORD);
    const [person] = await h.db.query(`INSERT INTO person (full_name, job_position) VALUES ('T. Kromodimedjo', 'Auditor') RETURNING id`);
    const [unit] = await h.db.query(`SELECT id FROM organisational_unit WHERE code = 'HO-ICT'`);
    const [account] = await h.db.query(
      `INSERT INTO account (email, password_hash, is_enabled, person_id, organisational_unit_id) VALUES ('auditor@juspol.test', $1, true, $2, $3) RETURNING id`,
      [passwordHash, person.id, unit.id],
    );
    await h.db.query(`INSERT INTO role_assignment (account_id, functional_role_id) SELECT $1, id FROM functional_role WHERE code = 'AUDITOR'`, [account.id]);
  });
  afterAll(async () => {
    await h.close();
  });

  const version = async (id: string) => (await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [id]))[0].version as number;

  async function registered(email: string, subject: string, text = 'Inhoud van de brief.') {
    const { agent } = await signIn(h.app, email);
    const d = (await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject, party: 'Ministerie van Binnenlandse Zaken' }).expect(201)).body;
    const { newPdf, pdfBuffer } = await import('../src/core/pdf');
    await agent.post(`/api/records/${d.id}/documents`).attach('file', await pdfBuffer(newPdf().text(text)), { filename: 'brief.pdf', contentType: 'application/pdf' }).expect(201);
    return (await agent.post(`/api/records/${d.id}/register`).send({ version: d.version }).expect(200)).body;
  }

  describe('audit viewer', () => {
    it('lets the auditor search everything, the administrator only the running of the system', async () => {
      await registered('assistant1@juspol.test', 'Brief voor het logboek');
      const { agent: auditor } = await signIn(h.app, 'auditor@juspol.test');
      const records = (await auditor.get('/api/audit/events?category=RECORDS&limit=200').expect(200)).body;
      expect(records.data.map((e: { eventType: string }) => e.eventType)).toContain('ITEM_REGISTERED');
      expect(records.data.every((e: { category: string }) => e.category === 'RECORDS')).toBe(true);
      const found = (await auditor.get('/api/audit/events?q=logboek').expect(200)).body;
      expect(found.total).toBeGreaterThan(0);
      const byActor = (await auditor.get('/api/audit/events?actor=Amatredjo&type=ITEM_REGISTERED').expect(200)).body;
      expect(byActor.data.every((e: { actor: string }) => e.actor.includes('Amatredjo'))).toBe(true);
      const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
      expect((await auditor.get(`/api/audit/events?from=${today}&to=${today}`).expect(200)).body.total).toBeGreaterThan(0);
      expect((await auditor.get('/api/audit/events?from=2001-01-01&to=2001-01-02').expect(200)).body.total).toBe(0);
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      expect((await admin.get('/api/audit/events?category=RECORDS').expect(200)).body.total).toBe(0);
      const security = (await admin.get('/api/audit/events?category=SECURITY').expect(200)).body;
      expect(security.data.map((e: { eventType: string }) => e.eventType)).toContain('SIGN_IN_SUCCEEDED');
      const overview = (await auditor.get('/api/audit/overview').expect(200)).body;
      expect(overview.categories.RECORDS).toBeGreaterThan(0);
      const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
      await clerk.get('/api/audit/events').expect(403);
    });

    it('exports to CSV and Excel, recorded, with no formula injection', async () => {
      await h.db.query(
        `INSERT INTO audit_event (event_type, actor_account_id, actor_description, summary) VALUES ('SETTING_CHANGED', NULL, 'test', '=HYPERLINK("http://evil")')`,
      );
      const { agent: auditor } = await signIn(h.app, 'auditor@juspol.test');
      const csv = await auditor.get('/api/audit/events.csv?type=SETTING_CHANGED').buffer(true).parse(binary as never).expect(200);
      const text = csv.body.toString('utf8');
      expect(text.split('\r\n')[0]).toContain('Gebeurtenis');
      expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
      const xlsx = await auditor.get('/api/audit/events.xlsx?category=SECURITY').buffer(true).parse(binary as never).expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.body);
      expect(wb.getWorksheet('Logboek')!.getRow(4).getCell(3).value).toBe('Gebeurtenis');
      await expectAuditEvent(h.db, 'AUDIT_EXPORTED', 'CSV');
    });
  });

  describe('integration keys and WijSamen', () => {
    let key = '';
    it('shows a key once, stores only its hash, and only the administrator manages keys', async () => {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      const created = (await admin.post('/api/admin/integrations').send({ name: 'WijSamen app', kind: 'WIJSAMEN', actAsAccountId: await accountIdFor(h.db, 'assistant1@juspol.test') }).expect(201)).body;
      key = created.key;
      expect(key).toMatch(/^jp_[0-9a-f]{12}_/);
      const list = (await admin.get('/api/admin/integrations').expect(200)).body;
      expect(JSON.stringify(list)).not.toContain(key);
      expect(list[0].keyPrefix).toBe(created.keyPrefix);
      const [row] = await h.db.query(`SELECT key_hash FROM integration_client WHERE id = $1`, [created.id]);
      expect(row.key_hash).not.toContain(key.slice(16));
      const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
      await clerk.get('/api/admin/integrations').expect(403);
    });

    it('takes in a WijSamen report as a draft, once, with its photos, and tells the app only its status', async () => {
      const { newPdf, pdfBuffer, qrPng } = await import('../src/core/pdf');
      const big = newPdf();
      for (let i = 0; i < 1200; i += 1) big.text(`Regel ${i} ${Math.random().toString(36).repeat(8)} ${Math.random().toString(36).repeat(8)}`);
      const attachment = (await pdfBuffer(big)).toString('base64');
      expect(attachment.length).toBeGreaterThan(150_000);
      const report = {
        reference: 'WS-2026-000123',
        category: 'Overlast',
        subject: 'Geluidsoverlast bij politiepost Latour',
        description: 'Elke nacht harde muziek vanaf het terrein naast de politiepost.',
        reporter: { name: 'R. Jong A Lim', email: 'melder@example.sr' },
        location: 'Latour, Paramaribo',
        occurredOn: '2026-10-20',
        attachments: [
          { filename: 'foto.png', contentType: 'image/png', base64: (await qrPng('foto')).toString('base64') },
          { filename: 'verklaring.pdf', contentType: 'application/pdf', base64: attachment },
        ],
      };
      const http = (await import('supertest')).default(h.app.getHttpServer());
      await http.post('/api/integrations/wijsamen/reports').send(report).expect(401);
      await http.post('/api/integrations/wijsamen/reports').set('X-Api-Key', `${key}x`).send(report).expect(401);
      const r = (await http.post('/api/integrations/wijsamen/reports').set('X-Api-Key', key).send(report).expect(201)).body;
      expect(r.status).toBe('RECEIVED');
      const [item] = await h.db.query(`SELECT state, source, subject, party, sender_reference FROM correspondence_item WHERE id = $1`, [r.itemId]);
      expect(item).toMatchObject({ state: 'DRAFT', source: 'WIJSAMEN', subject: 'WijSamen: Geluidsoverlast bij politiepost Latour', party: 'R. Jong A Lim (via WijSamen)', sender_reference: 'WS-2026-000123' });
      expect((await h.db.query(`SELECT count(*)::int AS n FROM captured_document WHERE correspondence_item_id = $1`, [r.itemId]))[0].n).toBe(3);
      // Sent again: recognised. Changed under the same reference: refused.
      expect((await http.post('/api/integrations/wijsamen/reports').set('X-Api-Key', key).send(report).expect(201)).body).toMatchObject({ status: 'ALREADY_RECEIVED', itemId: r.itemId });
      await http.post('/api/integrations/wijsamen/reports').set('X-Api-Key', key).send({ ...report, description: 'Anders' }).expect(409);
      expect((await http.get('/api/integrations/wijsamen/reports/WS-2026-000123').set('X-Api-Key', key).expect(200)).body.stage).toBe('RECEIVED');
      const { agent } = await signIn(h.app, 'assistant1@juspol.test');
      const v = (await h.db.query(`SELECT version FROM correspondence_item WHERE id = $1`, [r.itemId]))[0].version;
      await agent.post(`/api/records/${r.itemId}/register`).send({ version: v }).expect(200);
      const status = (await http.get('/api/integrations/wijsamen/reports/WS-2026-000123').set('X-Api-Key', key).expect(200)).body;
      expect(status.stage).toBe('REGISTERED');
      expect(JSON.stringify(status)).not.toContain('muziek');
      await http.get('/api/integrations/wijsamen/reports/ONBEKEND-1').set('X-Api-Key', key).expect(404);
      await expectAuditEvent(h.db, 'WIJSAMEN_REPORT_RECEIVED', 'WS-2026-000123');
      // A revoked key no longer works.
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      const [client] = await h.db.query(`SELECT id FROM integration_client WHERE kind = 'WIJSAMEN'`);
      await admin.post(`/api/admin/integrations/${client.id}/revoke`).expect(200);
      await http.get('/api/integrations/wijsamen/reports/WS-2026-000123').set('X-Api-Key', key).expect(401);
    });
  });

  describe('exchange with other organisations', () => {
    let dossierId = '';
    let original: { registrationIdentity: string } = { registrationIdentity: '' };
    let pkg: Buffer = Buffer.alloc(0);
    const other = generateKeyPairSync('ed25519');

    it('registers partners by their public key', async () => {
      const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
      const me = (await admin.get('/api/exchange/identity').expect(200)).body;
      expect(me).toMatchObject({ code: 'JUSPOL', format: 'juspol-exchange/1' });
      // For the round trip in this test the ministry is its own partner.
      await admin.post('/api/exchange/partners').send({ code: 'JUSPOL', name: 'Justitie en Politie (zelf)', publicKeyPem: me.publicKeyPem }).expect(200);
      await admin.post('/api/exchange/partners').send({ code: 'BIZA', name: 'Ministerie van Binnenlandse Zaken', publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }) }).expect(200);
      await admin.post('/api/exchange/partners').send({ code: 'BAD', name: 'Fout', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PUBLIC KEY-----' }).expect(400);
      await expectAuditEvent(h.db, 'EXCHANGE_PARTNER_SAVED', 'BIZA');
    });

    it('sends a matter as a signed package and takes it in on the other side, once', async () => {
      const { agent } = await signIn(h.app, 'assistant1@juspol.test');
      original = await registered('assistant1@juspol.test', 'Verzoek om gegevens bevolkingsregister', 'De gegevens van de betrokkene worden gevraagd.');
      const dossier = (await agent.post('/api/dossiers').send({ subject: 'Gegevensuitwisseling BIZA' }).expect(201)).body;
      dossierId = dossier.id;
      await agent.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: (original as unknown as { id: string }).id }).expect(200);
      const res = await agent.post(`/api/exchange/dossiers/${dossier.id}/export`).send({ partnerCode: 'JUSPOL' }).buffer(true).parse(binary as never).expect(200);
      pkg = res.body;
      const zip = await JSZip.loadAsync(pkg);
      expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['manifest.json', 'manifest.sig', 'afzender-sleutel.pem', 'LEESMIJ.txt']));
      const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
      expect(manifest.items[0]).toMatchObject({ registrationIdentity: original.registrationIdentity, subject: 'Verzoek om gegevens bevolkingsregister' });
      const verified = (await agent.post('/api/exchange/verify').attach('package', pkg, 'pakket.zip').expect(200)).body;
      expect(verified).toMatchObject({ valid: true, from: { code: 'JUSPOL' } });
      const imported = (await agent.post('/api/exchange/import').attach('package', pkg, 'pakket.zip').expect(201)).body;
      expect(imported.items).toHaveLength(1);
      const [item] = await h.db.query(`SELECT state, source, party, sender_reference FROM correspondence_item WHERE id = $1`, [imported.items[0].id]);
      expect(item).toMatchObject({ state: 'DRAFT', source: 'EXCHANGE', party: 'Justitie en Politie (zelf)', sender_reference: original.registrationIdentity });
      const hashes = await h.db.query(
        `SELECT cd.content_hash FROM captured_document cd JOIN correspondence_item ci ON ci.id = cd.correspondence_item_id WHERE ci.registration_identity = $1 OR ci.id = $2 ORDER BY ci.created_at`,
        [original.registrationIdentity, imported.items[0].id],
      );
      expect(hashes[0].content_hash).toBe(hashes[1].content_hash);
      await agent.post('/api/exchange/import').attach('package', pkg, 'pakket.zip').expect(409);
      const log = (await agent.get('/api/exchange/log').expect(200)).body;
      expect(log.map((l: { direction: string }) => l.direction).sort()).toEqual(['EXPORTED', 'IMPORTED']);
      await expectAuditEvent(h.db, 'EXCHANGE_IMPORTED', 'JUSPOL');
    });

    it('refuses an altered file, an altered manifest, a forged sender and a package for someone else', async () => {
      const { agent } = await signIn(h.app, 'assistant1@juspol.test');
      const zip = await JSZip.loadAsync(pkg);
      const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
      const path = manifest.items[0].documents[0].path;
      const altered = await JSZip.loadAsync(pkg);
      altered.file(path, Buffer.from('%PDF-1.4 vervalst'));
      const r1 = await agent.post('/api/exchange/import').attach('package', await altered.generateAsync({ type: 'nodebuffer' }), 'p.zip').expect(400);
      expect(r1.body.message).toMatch(/does not match its fingerprint/);
      const changed = await JSZip.loadAsync(pkg);
      changed.file('manifest.json', JSON.stringify({ ...manifest, items: [{ ...manifest.items[0], subject: 'Iets anders' }] }));
      const r2 = await agent.post('/api/exchange/import').attach('package', await changed.generateAsync({ type: 'nodebuffer' }), 'p.zip').expect(400);
      expect(r2.body.message).toMatch(/signature/);
      // Claims to come from BIZA but is signed with another key.
      const forger = generateKeyPairSync('ed25519');
      const forged = await JSZip.loadAsync(pkg);
      const fake = Buffer.from(canonicalJson({ ...manifest, from: { ...manifest.from, code: 'BIZA' } }));
      forged.file('manifest.json', fake);
      forged.file('manifest.sig', sign(null, fake, forger.privateKey).toString('base64'));
      const r3 = await agent.post('/api/exchange/import').attach('package', await forged.generateAsync({ type: 'nodebuffer' }), 'p.zip').expect(400);
      expect(r3.body.message).toMatch(/registered key/);
      // Really from BIZA — accepted signature — and addressed to us: accepted.
      const genuine = await JSZip.loadAsync(pkg);
      const fromBiza = Buffer.from(canonicalJson({ ...manifest, id: 'b1', from: { code: 'BIZA', name: 'BIZA', keyId: 'x' } }));
      genuine.file('manifest.json', fromBiza);
      genuine.file('manifest.sig', sign(null, fromBiza, other.privateKey).toString('base64'));
      await agent.post('/api/exchange/verify').attach('package', await genuine.generateAsync({ type: 'nodebuffer' }), 'p.zip').expect(200);
      // Addressed to BIZA: not for us.
      const res = await agent.post(`/api/exchange/dossiers/${dossierId}/export`).send({ partnerCode: 'BIZA' }).buffer(true).parse(binary as never).expect(200);
      const r4 = await agent.post('/api/exchange/import').attach('package', res.body, 'p.zip').expect(400);
      expect(r4.body.message).toMatch(/addressed to another/);
      await agent.post('/api/exchange/import').attach('package', Buffer.from('geen zip'), 'p.zip').expect(400);
    });

    it('never sends a secret matter, and a confidential one only by a decision-maker', async () => {
      const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
      const secret = (await minister.post('/api/dossiers').send({ subject: 'Geheime zaak', classification: 'SECRET' }).expect(201)).body;
      const r = await minister.post(`/api/exchange/dossiers/${secret.id}/export`).send({ partnerCode: 'BIZA' }).expect(400);
      expect(r.body.message).toMatch(/Secret matters/);
      const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
      const conf = (await clerk.post('/api/dossiers').send({ subject: 'Vertrouwelijke zaak', classification: 'CONFIDENTIAL' }).expect(201)).body;
      const item = await registered('assistant1@juspol.test', 'Vertrouwelijk stuk');
      await clerk.post(`/api/dossiers/${conf.id}/links`).send({ itemId: item.id }).expect(200);
      await clerk.post(`/api/exchange/dossiers/${conf.id}/export`).send({ partnerCode: 'BIZA' }).expect(403);
      const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
      await dir.post(`/api/exchange/dossiers/${conf.id}/export`).send({ partnerCode: 'BIZA' }).expect(200);
      void version;
    });
  });

  describe('integrity check', () => {
    const root = loadDocumentConfig().storageRoot;

    it('confirms the history and every stored file are intact, and issues a sealed report', async () => {
      const { agent: auditor } = await signIn(h.app, 'auditor@juspol.test');
      const r = (await auditor.post('/api/integrity/run').expect(200)).body;
      expect(r.ok).toBe(true);
      expect(r.audit.chainOk).toBe(true);
      expect(r.audit.events).toBeGreaterThan(20);
      expect(r.documents.checked).toBeGreaterThan(3);
      expect(r.documents.failed).toBe(0);
      const pdf = await auditor.get(`/api/integrity/runs/${r.id}/report.pdf`).buffer(true).parse(binary as never).expect(200);
      expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
      const report = (await auditor.get(`/api/integrity/runs/${r.id}`).expect(200)).body;
      expect(report.sealId).toBeTruthy();
      const http = (await import('supertest')).default(h.app.getHttpServer());
      expect((await http.get(`/api/public/seals/${report.sealId}`).expect(200)).body.valid).toBe(true);
      await expectAuditEvent(h.db, 'INTEGRITY_CHECK_RUN', 'chain intact');
      const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
      await clerk.post('/api/integrity/run').expect(403);
    });

    it('finds a changed or missing file', async () => {
      const [doc] = await h.db.query(`SELECT id, storage_key, original_filename FROM captured_document ORDER BY captured_at LIMIT 1`);
      const file = join(root, doc.storage_key);
      const before = await readFile(file);
      await writeFile(file, Buffer.concat([before, Buffer.from('x')]));
      const { agent: auditor } = await signIn(h.app, 'auditor@juspol.test');
      const changed = (await auditor.post('/api/integrity/run').expect(200)).body;
      expect(changed.ok).toBe(false);
      expect(changed.documents.failures.find((f: { id: string }) => f.id === doc.id).reason).toBe('content changed');
      await rename(file, `${file}.weg`);
      const missing = (await auditor.post('/api/integrity/run').expect(200)).body;
      expect(missing.documents.failures.find((f: { id: string }) => f.id === doc.id).reason).toBe('file missing');
      await rename(`${file}.weg`, file);
      await writeFile(file, before);
      expect((await auditor.post('/api/integrity/run').expect(200)).body.ok).toBe(true);
    });

    it('finds an altered audit event, even when the alteration bypassed the database rules', async () => {
      const [e] = await h.db.query(`SELECT seq, summary FROM audit_event ORDER BY seq OFFSET 5 LIMIT 1`);
      await h.db.query(`ALTER TABLE audit_event DISABLE RULE audit_event_no_update`);
      await h.db.query(`UPDATE audit_event SET summary = 'Vervalst' WHERE seq = $1`, [e.seq]);
      const { agent: auditor } = await signIn(h.app, 'auditor@juspol.test');
      const r = (await auditor.post('/api/integrity/run').expect(200)).body;
      expect(r.audit.chainOk).toBe(false);
      expect(r.audit.broken).toContain(Number(e.seq));
      await h.db.query(`UPDATE audit_event SET summary = $2 WHERE seq = $1`, [e.seq, e.summary]);
      await h.db.query(`ALTER TABLE audit_event ENABLE RULE audit_event_no_update`);
      expect((await auditor.post('/api/integrity/run').expect(200)).body.audit.chainOk).toBe(true);
    });

    it('finds events cut off the end of the history, which a chain alone cannot show', async () => {
      const { agent: auditor } = await signIn(h.app, 'auditor@juspol.test');
      const before = (await auditor.post('/api/integrity/run').expect(200)).body;
      expect(before.anchors.ok).toBe(true);
      await h.db.query(`ALTER TABLE audit_event DISABLE RULE audit_event_no_delete`);
      await h.db.query(`DELETE FROM audit_event WHERE seq >= $1`, [before.audit.newestSeq]);
      await h.db.query(`ALTER TABLE audit_event ENABLE RULE audit_event_no_delete`);
      const after = (await auditor.post('/api/integrity/run').expect(200)).body;
      expect(after.audit.chainOk).toBe(true);
      expect(after.anchors.ok).toBe(false);
      expect(after.anchors.missing.map((m: { seq: number }) => m.seq)).toContain(before.audit.newestSeq);
      expect(after.ok).toBe(false);
      const runs = (await auditor.get('/api/integrity/runs').expect(200)).body;
      expect(runs[0].ok).toBe(false);
    });
  });
});
