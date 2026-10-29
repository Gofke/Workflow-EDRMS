import { execFileSync } from 'child_process';
import { createHash, createPublicKey, verify } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import JSZip from 'jszip';
import { tmpdir } from 'os';
import { join } from 'path';
import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

const binary = (res: NodeJS.ReadableStream & { setEncoding?: (e: string) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * Case files: the file plan, related matters, retention with legal hold, the
 * signed archive transfer package and the timeline PDF.
 */
describe('Phase 3 case files', () => {
  let h: Harness;
  let recordsManagerEmail: string;
  beforeAll(async () => {
    h = await startHarness();
    const { agent: admin } = await signIn(h.app, 'sysadmin@juspol.test');
    recordsManagerEmail = 'archief@juspol.test';
    await admin
      .post('/api/admin/accounts')
      .send({ fullName: 'P. Archivaris', email: recordsManagerEmail, roles: ['RECORDS_MANAGER'], initialPassword: process.env.SEED_PASSWORD })
      .expect(201);
  });
  afterAll(async () => {
    await h.close();
  });

  async function version(id: string): Promise<number> {
    const [row] = await h.db.query(`SELECT version FROM dossier WHERE id = $1`, [id]);
    return row.version;
  }

  /** A matter taken all the way to finalised and closed. */
  async function closedMatter(subject: string, categoryId?: string) {
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (await clerk.post('/api/dossiers').send({ subject, ...(categoryId ? { categoryId } : {}) }).expect(201)).body;
    const draft = (await clerk.post('/api/records/drafts').send({ direction: 'INCOMING', subject: `Brief bij ${subject}`, party: 'OM' }).expect(201)).body;
    const item = (await clerk.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)).body;
    await clerk.post(`/api/records/${item.id}/documents`).attach('file', Buffer.from('%PDF-1.4\n%%EOF'), { filename: 'brief.pdf', contentType: 'application/pdf' }).expect(201);
    await clerk.post(`/api/dossiers/${dossier.id}/links`).send({ itemId: item.id }).expect(200);
    const directeur = await accountIdFor(h.db, 'directeur@juspol.test');
    await clerk.post(`/api/dossiers/${dossier.id}/submit`).send({ reviewerAccountId: directeur, version: await version(dossier.id) }).expect(200);
    const { agent: dir } = await signIn(h.app, 'directeur@juspol.test');
    await dir.post(`/api/dossiers/${dossier.id}/approve`).send({ version: await version(dossier.id) }).expect(200);
    await dir.post(`/api/dossiers/${dossier.id}/finalise`).send({ version: await version(dossier.id) }).expect(200);
    await dir.post(`/api/dossiers/${dossier.id}/dossier-state/close`).send({ version: await version(dossier.id), reason: 'Afgehandeld' }).expect(200);
    return { dossier, item };
  }

  it('maintains the file plan and places a matter in it, audited', async () => {
    const { agent: rm } = await signIn(h.app, recordsManagerEmail);
    const parent = (await rm.post('/api/casefiles/categories').send({ code: '1', name: 'Wetgeving en beleid' }).expect(201)).body;
    const cat = (
      await rm
        .post('/api/casefiles/categories')
        .send({ code: '1.2', name: 'Parlementaire vragen', parentId: parent.id, retentionYears: 10, retentionAction: 'TRANSFER', handlingWorkingDays: 21 })
        .expect(201)
    ).body;
    expect(cat.parentId).toBe(parent.id);
    await rm.post('/api/casefiles/categories').send({ code: '1.2', name: 'Dubbel' }).expect(409);
    await rm.post('/api/casefiles/categories').send({ code: '9', name: 'Zonder actie', retentionYears: 5 }).expect(400);
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    await clerk.post('/api/casefiles/categories').send({ code: 'X', name: 'x' }).expect(403);
    const dossier = (await clerk.post('/api/dossiers').send({ subject: 'Vragen over gevangeniswezen' }).expect(201)).body;
    await clerk.post(`/api/dossiers/${dossier.id}/category`).send({ categoryId: cat.id }).expect(200);
    await expectAuditEvent(h.db, 'DOSSIER_CATEGORISED', 'Parlementaire vragen');
    const list = (await clerk.get('/api/casefiles/categories').expect(200)).body;
    expect(list.find((c: { code: string }) => c.code === '1.2').dossierCount).toBe(1);
  });

  it('relates matters to each other, both ways, once', async () => {
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    const a = (await clerk.post('/api/dossiers').send({ subject: 'Hoofdzaak' }).expect(201)).body;
    const b = (await clerk.post('/api/dossiers').send({ subject: 'Vervolgzaak' }).expect(201)).body;
    await clerk.post(`/api/dossiers/${a.id}/relations`).send({ relatedDossierId: b.id, relation: 'FOLLOW_UP', note: 'Vervolg op klacht' }).expect(201);
    await clerk.post(`/api/dossiers/${b.id}/relations`).send({ relatedDossierId: a.id, relation: 'RELATED' }).expect(409);
    await clerk.post(`/api/dossiers/${a.id}/relations`).send({ relatedDossierId: a.id, relation: 'RELATED' }).expect(400);
    const fromB = (await clerk.get(`/api/dossiers/${b.id}/relations`).expect(200)).body;
    expect(fromB[0].dossierIdentity).toBe(a.dossierIdentity);
    expect(fromB[0].outgoing).toBe(false);
  });

  it('freezes the category of a closed matter', async () => {
    const { agent: rm } = await signIn(h.app, recordsManagerEmail);
    const cat = (await rm.post('/api/casefiles/categories').send({ code: '2', name: 'Klachten', retentionYears: 0, retentionAction: 'DESTROY' }).expect(201)).body;
    const { dossier } = await closedMatter('Gesloten klacht', cat.id);
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    await clerk.post(`/api/dossiers/${dossier.id}/category`).send({ categoryId: null }).expect(400);
    // Even directly in the database.
    await expect(h.db.query(`UPDATE dossier SET category_id = NULL WHERE id = $1`, [dossier.id])).rejects.toThrow(/closed/);
  });

  it('lists a closed matter for review when its retention ends, and blocks destruction under legal hold', async () => {
    const { agent: rm } = await signIn(h.app, recordsManagerEmail);
    const cat = (await rm.post('/api/casefiles/categories').send({ code: '3', name: 'Tijdelijk', retentionYears: 0, retentionAction: 'DESTROY' }).expect(201)).body;
    const { dossier } = await closedMatter('Kort te bewaren', cat.id);
    const due = (await rm.get('/api/casefiles/retention?filter=due').expect(200)).body;
    expect(due.map((d: { id: string }) => d.id)).toContain(dossier.id);
    const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
    await minister.post(`/api/dossiers/${dossier.id}/legal-hold`).send({ action: 'SET', reason: 'Lopende rechtszaak' }).expect(200);
    // The records manager sees it in the list of holds, with the reason and who set it.
    const holds = (await rm.get('/api/casefiles/legal-holds').expect(200)).body;
    expect(holds.find((x: { id: string }) => x.id === dossier.id)).toMatchObject({ holdReason: 'Lopende rechtszaak', heldByName: 'R. Dijkstra', state: 'CLOSED' });
    const { agent: staff } = await signIn(h.app, 'assistant1@juspol.test');
    await staff.get('/api/casefiles/legal-holds').expect(403);
    await rm.post(`/api/dossiers/${dossier.id}/retention`).send({ decision: 'DESTROY', reason: 'Termijn verstreken' }).expect(400);
    // The database refuses it too.
    await expect(h.db.query(`UPDATE dossier SET retention_state = 'DESTROYED' WHERE id = $1`, [dossier.id])).rejects.toThrow(/legal hold/);
    await minister.post(`/api/dossiers/${dossier.id}/legal-hold`).send({ action: 'RELEASED', reason: 'Zaak afgerond' }).expect(200);
    // Support staff cannot take the decision.
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    await clerk.post(`/api/dossiers/${dossier.id}/retention`).send({ decision: 'DESTROY', reason: 'x' }).expect(403);
    const result = (await rm.post(`/api/dossiers/${dossier.id}/retention`).send({ decision: 'DESTROY', reason: 'Termijn verstreken, geen archiefwaarde' }).expect(200)).body;
    expect(result.retentionState).toBe('DESTROYED');
    expect(result.decisions).toHaveLength(1);
    expect(result.holds.map((x: { action: string }) => x.action)).toEqual(['SET', 'RELEASED']);
    await rm.post(`/api/dossiers/${dossier.id}/retention`).send({ decision: 'RETAIN', reason: 'x' }).expect(400);
    await expectAuditEvent(h.db, 'RETENTION_DECIDED', 'DESTROY');
    const timeline = (await minister.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    expect(timeline.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['LEGAL_HOLD_SET', 'LEGAL_HOLD_RELEASED']));
  });

  it('exports a signed archive package whose files match their fingerprints, then allows the transfer', async () => {
    const { agent: rm } = await signIn(h.app, recordsManagerEmail);
    const cat = (await rm.post('/api/casefiles/categories').send({ code: '4', name: 'Naar het archief', retentionYears: 0, retentionAction: 'TRANSFER' }).expect(201)).body;
    const { dossier } = await closedMatter('Blijvend te bewaren', cat.id);
    await rm.post(`/api/dossiers/${dossier.id}/retention`).send({ decision: 'TRANSFER', reason: 'Overdracht' }).expect(400);
    const response = await rm.get(`/api/dossiers/${dossier.id}/archive-package`).buffer(true).parse(binary as never).expect(200);
    const bytes: Buffer = response.body;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(response.headers['x-package-sha256']);
    const zip = await JSZip.loadAsync(bytes);
    const manifestText = await zip.file('manifest.json')!.async('string');
    const signature = await zip.file('manifest.sig')!.async('string');
    const pem = await zip.file('publieke-sleutel.pem')!.async('string');
    expect(verify(null, Buffer.from(manifestText), createPublicKey(pem), Buffer.from(signature, 'base64'))).toBe(true);
    const manifest = JSON.parse(manifestText);
    expect(manifest.dossier.identity).toBe(dossier.dossierIdentity);
    expect(manifest.records).toHaveLength(1);
    expect(manifest.decisions.map((d: { event: string }) => d.event)).toEqual(['SUBMITTED', 'APPROVED', 'FINALISED']);
    for (const f of manifest.files) {
      const content = await zip.file(f.path)!.async('nodebuffer');
      expect(createHash('sha256').update(content).digest('hex')).toBe(f.sha256);
    }
    // A tampered manifest no longer verifies.
    expect(verify(null, Buffer.from(manifestText.replace(dossier.dossierIdentity, 'DOS-FAKE')), createPublicKey(pem), Buffer.from(signature, 'base64'))).toBe(false);
    await expectAuditEvent(h.db, 'ARCHIVE_PACKAGE_EXPORTED', dossier.dossierIdentity);
    const done = (await rm.post(`/api/dossiers/${dossier.id}/retention`).send({ decision: 'TRANSFER', reason: 'Overgedragen aan het Nationaal Archief' }).expect(200)).body;
    expect(done.retentionState).toBe('TRANSFERRED');
    expect(done.transfers).toHaveLength(1);
  });

  it('exports the timeline as a PDF, audited', async () => {
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (await clerk.post('/api/dossiers').send({ subject: 'Tijdlijn als PDF' }).expect(201)).body;
    const response = await clerk.get(`/api/dossiers/${dossier.id}/timeline/export.pdf`).buffer(true).parse(binary as never).expect(200);
    const file = join(mkdtempSync(join(tmpdir(), 'tl-')), 't.pdf');
    writeFileSync(file, response.body);
    const text = execFileSync('pdftotext', [file, '-']).toString();
    expect(text).toContain(`Tijdlijn ${dossier.dossierIdentity}`);
    expect(text).toContain('Zaak geopend'); // the PDF is in Dutch, also for headlines stored in English
    await expectAuditEvent(h.db, 'TIMELINE_PDF_EXPORTED', dossier.dossierIdentity);
  });
});
