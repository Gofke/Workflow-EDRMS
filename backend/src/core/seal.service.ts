import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { keysDir } from './delivery';

export interface SealResult {
  id: string;
  keyId: string;
  signature: string;
  payloadHash: string;
  sealedAt: string;
}

/**
 * The system seal: an Ed25519 signature over a canonical description of what
 * is being sealed — a document's SHA-256 with its registration and approval
 * facts, an archive package's manifest, an exchange package.
 *
 * The private key lives in KEYS_DIR on the server, outside the database, so a
 * copy of the database alone cannot forge a seal. The public key is published,
 * so anyone can verify a seal without trusting this server's word for it.
 *
 * A seal proves that this system produced that exact content and that it has
 * not changed since. It is not a qualified electronic signature of a person.
 */
@Injectable()
export class SealService implements OnModuleInit {
  private privateKey: KeyObject | null = null;
  private publicPem = '';
  private keyIdValue = '';

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    this.load();
    // On a database that has not been migrated yet the table is missing; the
    // key is registered again before every seal, so nothing depends on this.
    await this.dataSource
      .query(`INSERT INTO seal_key (key_id, public_key_pem) VALUES ($1, $2) ON CONFLICT (key_id) DO NOTHING`, [this.keyIdValue, this.publicPem])
      .catch(() => undefined);
  }

  private load(): void {
    if (this.privateKey) return;
    const file = join(keysDir(), 'seal-ed25519.pem');
    if (!existsSync(file)) {
      const { privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 });
    }
    this.privateKey = createPrivateKey(readFileSync(file, 'utf8'));
    const publicKey = createPublicKey(this.privateKey);
    this.publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    this.keyIdValue = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  }

  get keyId(): string {
    this.load();
    return this.keyIdValue;
  }

  get publicKeyPem(): string {
    this.load();
    return this.publicPem;
  }

  /** Signs bytes with the server's key. Used for exchange packages. */
  signBytes(bytes: Buffer): string {
    this.load();
    return sign(null, bytes, this.privateKey as KeyObject).toString('base64');
  }

  static verifyBytes(bytes: Buffer, signature: string, publicPem: string): boolean {
    try {
      return verify(null, bytes, createPublicKey(publicPem), Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }

  async seal(subjectType: 'DOCUMENT' | 'DOSSIER' | 'PACKAGE', subjectId: string, payload: Record<string, unknown>, sealedBy: string): Promise<SealResult> {
    this.load();
    // The ministry key must be registered before a seal may reference it.
    await this.dataSource.query(
      `INSERT INTO seal_key (key_id, public_key_pem) VALUES ($1, $2) ON CONFLICT (key_id) DO NOTHING`,
      [this.keyIdValue, this.publicPem],
    );
    const canonical = canonicalJson(payload);
    const payloadHash = createHash('sha256').update(canonical).digest('hex');
    const signature = sign(null, Buffer.from(canonical), this.privateKey as KeyObject).toString('base64');
    const [row] = await this.dataSource.query(
      `INSERT INTO document_seal (subject_type, subject_id, payload, payload_hash, signature, key_id, sealed_by_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, sealed_at`,
      [subjectType, subjectId, canonical, payloadHash, signature, this.keyIdValue, sealedBy],
    );
    return { id: row.id, keyId: this.keyIdValue, signature, payloadHash, sealedAt: new Date(row.sealed_at).toISOString() };
  }

  /** Checks a seal against its published key. Says why when it fails. */
  async verifySeal(sealId: string): Promise<{
    valid: boolean;
    reason: string | null;
    payload: Record<string, unknown>;
    keyId: string;
    sealedAt: string;
    sealedByName: string;
  }> {
    if (!/^[0-9a-f-]{36}$/i.test(sealId)) throw new NotFoundException('Unknown seal.');
    const [row] = await this.dataSource.query(
      `SELECT s.*, k.public_key_pem, k.retired_at, p.full_name AS sealed_by_name
         FROM document_seal s JOIN seal_key k ON k.key_id = s.key_id
         JOIN account a ON a.id = s.sealed_by_account_id JOIN person p ON p.id = a.person_id
        WHERE s.id = $1`,
      [sealId],
    );
    if (!row) throw new NotFoundException('Unknown seal.');
    const canonical = canonicalJson(row.payload);
    const hashOk = createHash('sha256').update(canonical).digest('hex') === row.payload_hash;
    const sigOk = SealService.verifyBytes(Buffer.from(canonical), row.signature, row.public_key_pem);
    return {
      valid: hashOk && sigOk,
      reason: !hashOk ? 'The sealed description has been altered.' : !sigOk ? 'The signature does not match the ministry key.' : null,
      payload: row.payload,
      keyId: row.key_id,
      sealedAt: new Date(row.sealed_at).toISOString(),
      sealedByName: row.sealed_by_name,
    };
  }
}

/** JSON with keys in a fixed order, so the same content always signs the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
