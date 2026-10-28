import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, createPublicKey, randomUUID } from 'crypto';
import JSZip from 'jszip';
import { DataSource } from 'typeorm';
import { AccessService } from '../access/access.service';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { DECISION_ROLES } from '../common/actor';
import { canonicalJson, SealService } from '../core/seal.service';
import { DocumentsService } from '../documents/documents.service';
import { Actor, RegistrationService } from '../records/registration.service';
import { SettingsService } from '../settings/settings.service';

export const EXCHANGE_FORMAT = 'juspol-exchange/1';

interface ManifestDocument {
  path: string;
  filename: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
}

interface ManifestItem {
  registrationIdentity: string;
  direction: string;
  subject: string;
  party: string | null;
  documentDate: string | null;
  senderReference: string | null;
  classification: string;
  documents: ManifestDocument[];
}

export interface Manifest {
  format: string;
  id: string;
  from: { code: string; name: string; keyId: string };
  to: { code: string; name: string };
  createdAt: string;
  createdBy: string;
  dossier: { identity: string; subject: string; classification: string } | null;
  items: ManifestItem[];
}

/**
 * Exchanging records with another ministry or government body.
 *
 * A package is a ZIP with a manifest describing the letters and their
 * documents, the SHA-256 of every file, and the ministry's Ed25519 signature
 * over the manifest. The receiving system checks the signature against the
 * sender's registered key and every file against its hash before it takes
 * anything in — a changed file, a changed manifest or an unknown sender is
 * refused as a whole. Imported letters arrive as drafts, to be registered by a
 * clerk; a package is never imported twice.
 *
 * Secret matters are never exchanged this way. Confidential ones only by a
 * decision-maker.
 */
@Injectable()
export class ExchangeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly seals: SealService,
    private readonly documents: DocumentsService,
    private readonly registration: RegistrationService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  code(): string {
    return (process.env.EXCHANGE_ORG_CODE ?? 'JUSPOL').toUpperCase();
  }

  async identity() {
    const branding = await this.settings.get('branding');
    return { code: this.code(), name: branding.organisationName, keyId: this.seals.keyId, publicKeyPem: this.seals.publicKeyPem, format: EXCHANGE_FORMAT };
  }

  partners() {
    return this.dataSource.query(
      `SELECT id, code, name, is_active AS "isActive", created_at AS "createdAt", public_key_pem AS "publicKeyPem" FROM exchange_partner ORDER BY name`,
    );
  }

  async savePartner(actor: Actor, input: { code: string; name: string; publicKeyPem: string; isActive?: boolean }) {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,40}$/.test(code)) throw new BadRequestException('A partner code is 2–40 letters, digits or hyphens.');
    try {
      const key = createPublicKey(input.publicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
    } catch {
      throw new BadRequestException('The public key must be an Ed25519 key in PEM format.');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO exchange_partner (code, name, public_key_pem, is_active) VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, public_key_pem = EXCLUDED.public_key_pem, is_active = EXCLUDED.is_active`,
        [code, input.name.trim(), input.publicKeyPem.trim(), input.isActive ?? true],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.EXCHANGE_PARTNER_SAVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `exchange partner: ${code}`,
        newValue: `${input.name.trim()}${input.isActive === false ? ' (inactive)' : ''}, key ${createHash('sha256').update(createPublicKey(input.publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)}`,
        summary: `${actor.description} saved the exchange partner ${input.name.trim()} (${code}).`,
      });
    });
    return this.partners();
  }

  async export(actor: Actor, dossierId: string, input: { partnerCode: string; itemIds?: string[] }) {
    const profile = await this.access.assertDossier(actor.accountId, dossierId);
    const [partner] = await this.dataSource.query(`SELECT code, name FROM exchange_partner WHERE code = $1 AND is_active`, [input.partnerCode?.toUpperCase()]);
    if (!partner) throw new BadRequestException('Unknown or inactive exchange partner.');
    const [d] = await this.dataSource.query(`SELECT dossier_identity, subject, classification FROM dossier WHERE id = $1`, [dossierId]);
    if (d.classification === 'SECRET') throw new BadRequestException('Secret matters are not exchanged electronically.');
    if (d.classification === 'CONFIDENTIAL' && !profile.roles.some((r) => DECISION_ROLES.includes(r))) {
      throw new ForbiddenException('Only a decision-maker may send a confidential matter to another organisation.');
    }
    const ip = this.access.itemPredicate(profile, 'ci', 2);
    const items: { id: string; registration_identity: string; direction: string; subject: string; party: string | null; document_date: string | null; sender_reference: string | null; classification: string }[] =
      await this.dataSource.query(
        `SELECT ci.id, ci.registration_identity, ci.direction, ci.subject, ci.party, to_char(ci.document_date, 'YYYY-MM-DD') AS document_date,
                ci.sender_reference, ci.classification
           FROM dossier_link dl JOIN correspondence_item ci ON ci.id = dl.correspondence_item_id
          WHERE dl.dossier_id = $1 AND ci.state = 'REGISTERED' AND ci.classification <> 'SECRET' AND ${ip.sql}
          ORDER BY ci.registered_at`,
        [dossierId, ...ip.params],
      );
    const chosen = input.itemIds?.length ? items.filter((i) => input.itemIds!.includes(i.id)) : items;
    if (!chosen.length) throw new BadRequestException('There are no registered records in this matter to send.');
    const zip = new JSZip();
    const manifestItems: ManifestItem[] = [];
    let n = 0;
    for (const item of chosen) {
      const docs: { id: string }[] = await this.dataSource.query(`SELECT id FROM captured_document WHERE correspondence_item_id = $1 ORDER BY captured_at`, [item.id]);
      const documents: ManifestDocument[] = [];
      for (const doc of docs) {
        const { bytes, document } = await this.documents.bytesOf(doc.id);
        n += 1;
        const path = `files/${String(n).padStart(3, '0')}-${document.originalFilename.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
        zip.file(path, bytes);
        documents.push({ path, filename: document.originalFilename, mediaType: document.mediaType, sha256: document.contentHash, byteSize: bytes.length });
      }
      manifestItems.push({
        registrationIdentity: item.registration_identity,
        direction: item.direction,
        subject: item.subject,
        party: item.party,
        documentDate: item.document_date,
        senderReference: item.sender_reference,
        classification: item.classification,
        documents,
      });
    }
    const me = await this.identity();
    const manifest: Manifest = {
      format: EXCHANGE_FORMAT,
      id: randomUUID(),
      from: { code: me.code, name: me.name, keyId: me.keyId },
      to: { code: partner.code, name: partner.name },
      createdAt: new Date().toISOString(),
      createdBy: actor.description,
      dossier: { identity: d.dossier_identity, subject: d.subject, classification: d.classification },
      items: manifestItems,
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
    zip.file('manifest.json', manifestBytes);
    zip.file('manifest.sig', this.seals.signBytes(manifestBytes));
    zip.file('afzender-sleutel.pem', me.publicKeyPem);
    zip.file(
      'LEESMIJ.txt',
      [
        `Uitwisselingspakket ${manifest.id}`,
        `Van: ${me.name} (${me.code})  Aan: ${partner.name} (${partner.code})`,
        `Zaak: ${d.dossier_identity} — ${d.subject}`,
        `Stukken: ${manifestItems.length}, bestanden: ${n}`,
        '',
        'manifest.json beschrijft de stukken en bevat de SHA-256 van elk bestand.',
        'manifest.sig is de Ed25519-handtekening van het ministerie over manifest.json.',
        'Controleer de handtekening met de geregistreerde sleutel van de afzender, niet alleen met de meegestuurde.',
      ].join('\r\n'),
    );
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const packageHash = createHash('sha256').update(bytes).digest('hex');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO exchange_log (direction, partner_code, dossier_id, package_hash, manifest, actor_account_id) VALUES ('EXPORTED', $1, $2, $3, $4, $5)`,
        [partner.code, dossierId, packageHash, canonicalJson({ ...manifest, items: manifest.items.map((i) => ({ registrationIdentity: i.registrationIdentity, documents: i.documents.length })) }), actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.EXCHANGE_EXPORTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${d.dossier_identity} — ${d.subject}`.slice(0, 260),
        newValue: `to ${partner.code}: ${manifestItems.length} record(s), ${n} file(s), sha256 ${packageHash.slice(0, 16)}…`,
        summary: `${actor.description} sent ${manifestItems.length} record(s) of ${d.dossier_identity} to ${partner.name} as a signed exchange package.`.slice(0, 600),
      });
    });
    return { bytes, filename: `uitwisseling-${d.dossier_identity}-${partner.code}.zip`, packageHash, manifestId: manifest.id };
  }

  /** Checks a package completely before taking anything in. */
  async verify(bytes: Buffer): Promise<{ manifest: Manifest; partner: { code: string; name: string }; zip: JSZip; packageHash: string }> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new BadRequestException('This is not a valid exchange package.');
    }
    const manifestFile = zip.file('manifest.json');
    const sigFile = zip.file('manifest.sig');
    if (!manifestFile || !sigFile) throw new BadRequestException('The package has no signed manifest.');
    const manifestBytes = await manifestFile.async('nodebuffer');
    const signature = (await sigFile.async('string')).trim();
    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new BadRequestException('The manifest cannot be read.');
    }
    if (manifest.format !== EXCHANGE_FORMAT) throw new BadRequestException(`Unsupported package format ${manifest.format}.`);
    const [partner] = await this.dataSource.query(`SELECT code, name, public_key_pem FROM exchange_partner WHERE code = $1 AND is_active`, [manifest.from?.code]);
    if (!partner) throw new BadRequestException(`The sender ${manifest.from?.code ?? '?'} is not a registered exchange partner.`);
    // Checked against the key registered here — never the one inside the package.
    if (!SealService.verifyBytes(manifestBytes, signature, partner.public_key_pem)) {
      throw new BadRequestException('The signature does not match the sender’s registered key: the package was altered or not sent by them.');
    }
    if (manifest.to?.code !== this.code()) throw new BadRequestException('This package is addressed to another organisation.');
    for (const item of manifest.items ?? []) {
      for (const doc of item.documents ?? []) {
        const file = zip.file(doc.path);
        if (!file) throw new BadRequestException(`The file ${doc.filename} is missing from the package.`);
        const content = await file.async('nodebuffer');
        if (createHash('sha256').update(content).digest('hex') !== doc.sha256) {
          throw new BadRequestException(`The file ${doc.filename} does not match its fingerprint: it was altered.`);
        }
      }
    }
    return { manifest, partner: { code: partner.code, name: partner.name }, zip, packageHash: createHash('sha256').update(bytes).digest('hex') };
  }

  async import(actor: Actor, bytes: Buffer) {
    const { manifest, partner, zip, packageHash } = await this.verify(bytes);
    const [already] = await this.dataSource.query(`SELECT occurred_at FROM exchange_log WHERE direction = 'IMPORTED' AND package_hash = $1`, [packageHash]);
    if (already) throw new ConflictException('This package was already taken in.');
    const created: { id: string; subject: string; documents: number }[] = [];
    for (const item of manifest.items) {
      const draft = await this.registration.createDraft(
        actor,
        {
          direction: 'INCOMING' as never,
          subject: item.subject.slice(0, 400),
          party: partner.name.slice(0, 300),
          documentDate: item.documentDate ?? undefined,
          senderReference: item.registrationIdentity?.slice(0, 120),
          classification: item.classification === 'CONFIDENTIAL' ? 'CONFIDENTIAL' : undefined,
        },
        'EXCHANGE',
      );
      for (const doc of item.documents) {
        const content = await zip.file(doc.path)!.async('nodebuffer');
        await this.documents.capture(actor, draft.id, { originalname: doc.filename, mimetype: doc.mediaType, size: content.length, buffer: content });
      }
      created.push({ id: draft.id, subject: draft.subject, documents: item.documents.length });
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO exchange_log (direction, partner_code, package_hash, manifest, actor_account_id) VALUES ('IMPORTED', $1, $2, $3, $4)`,
        [partner.code, packageHash, canonicalJson({ id: manifest.id, from: manifest.from, dossier: manifest.dossier, items: manifest.items.map((i) => i.registrationIdentity) }), actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.EXCHANGE_IMPORTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `exchange package from ${partner.code}`,
        newValue: `${created.length} draft(s), sha256 ${packageHash.slice(0, 16)}…`,
        summary: `${actor.description} took in a signed exchange package from ${partner.name} [${partner.code}] (${manifest.dossier?.identity ?? 'no matter'}): ${created.length} draft incoming item(s).`.slice(0, 600),
      });
    });
    return { from: partner, manifestId: manifest.id, dossier: manifest.dossier, items: created };
  }

  log() {
    return this.dataSource.query(
      `SELECT l.id, l.direction, l.partner_code AS "partnerCode", ep.name AS "partnerName", l.package_hash AS "packageHash", l.occurred_at AS "occurredAt",
              p.full_name AS "actorName", l.manifest->'dossier'->>'identity' AS "dossierIdentity",
              coalesce(jsonb_array_length(l.manifest->'items'), 0) AS "items"
         FROM exchange_log l LEFT JOIN exchange_partner ep ON ep.code = l.partner_code
         JOIN account a ON a.id = l.actor_account_id JOIN person p ON p.id = a.person_id
        ORDER BY l.occurred_at DESC LIMIT 100`,
    );
  }

  ensure(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
  }
}
