import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { hashPassword, verifyPassword } from '../auth/password';
import { Actor } from '../records/registration.service';

export interface IntegrationClient {
  id: string;
  name: string;
  kind: 'WIJSAMEN' | 'MAIL_GATEWAY';
  actAsAccountId: string;
  actAsDescription: string;
}

/**
 * Keys for systems that deliver into this one: the WijSamen app and the
 * ministry's mail server. A key is shown once, when it is made, and stored only
 * as a hash; it can be revoked at any time. Everything an integration delivers
 * is attributed to the account it acts as, with the integration named.
 */
@Injectable()
export class IntegrationKeysService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.dataSource.query(
      `SELECT c.id, c.name, c.kind, c.key_prefix AS "keyPrefix", c.created_at AS "createdAt", c.revoked_at AS "revokedAt",
              c.last_used_at AS "lastUsedAt", p.full_name AS "actAsName", c.act_as_account_id AS "actAsAccountId"
         FROM integration_client c LEFT JOIN account a ON a.id = c.act_as_account_id LEFT JOIN person p ON p.id = a.person_id
        ORDER BY c.created_at DESC`,
    );
  }

  async create(actor: Actor, input: { name: string; kind: 'WIJSAMEN' | 'MAIL_GATEWAY'; actAsAccountId: string }) {
    if (!['WIJSAMEN', 'MAIL_GATEWAY'].includes(input.kind)) throw new BadRequestException('Unknown integration kind.');
    const [account] = await this.dataSource.query(
      `SELECT a.id FROM account a JOIN role_assignment ra ON ra.account_id = a.id AND ra.revoked_at IS NULL
         JOIN functional_role r ON r.id = ra.functional_role_id
        WHERE a.id = $1 AND a.is_enabled AND r.code IN ('SUPPORT_STAFF','DIRECTEUR','ONDER_DIRECTEUR','MINISTER') LIMIT 1`,
      [input.actAsAccountId],
    );
    if (!account) throw new BadRequestException('The integration must act as an active account that may register post.');
    const prefix = randomBytes(6).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const key = `jp_${prefix}_${secret}`;
    const hash = await hashPassword(key);
    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO integration_client (name, kind, key_prefix, key_hash, created_by_account_id, act_as_account_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.name.trim(), input.kind, prefix, hash, actor.accountId, input.actAsAccountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.INTEGRATION_KEY_CREATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `integration: ${input.name.trim()}`,
        newValue: `${input.kind}, key ${prefix}…`,
        summary: `${actor.description} created an integration key for ${input.name.trim()} (${input.kind}).`,
      });
      return row.id as string;
    });
    return { id, key, keyPrefix: prefix, note: 'This key is shown once. Store it in the other system now.' };
  }

  async revoke(actor: Actor, id: string) {
    const [client] = await this.dataSource.query(`SELECT name FROM integration_client WHERE id = $1 AND revoked_at IS NULL`, [id]);
    if (!client) throw new NotFoundException('Unknown or already revoked key.');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE integration_client SET revoked_at = now() WHERE id = $1`, [id]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.INTEGRATION_KEY_REVOKED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `integration: ${client.name}`,
        summary: `${actor.description} revoked the integration key for ${client.name}.`,
      });
    });
    return { revoked: true };
  }

  /** Checks a presented key. The refusal never says which part was wrong. */
  async authenticate(presented: string | undefined, kind: 'WIJSAMEN' | 'MAIL_GATEWAY'): Promise<IntegrationClient> {
    const match = /^jp_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/.exec(presented ?? '');
    if (!match) throw new UnauthorizedException('Invalid integration key.');
    const [row] = await this.dataSource.query(
      `SELECT c.*, p.full_name, a.email FROM integration_client c
         JOIN account a ON a.id = c.act_as_account_id JOIN person p ON p.id = a.person_id
        WHERE c.key_prefix = $1 AND c.revoked_at IS NULL AND a.is_enabled`,
      [match[1]],
    );
    if (!row || row.kind !== kind || !(await verifyPassword(presented as string, row.key_hash))) {
      throw new UnauthorizedException('Invalid integration key.');
    }
    await this.dataSource.query(`UPDATE integration_client SET last_used_at = now() WHERE id = $1`, [row.id]);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      actAsAccountId: row.act_as_account_id,
      actAsDescription: `${row.full_name} (${row.email}) via ${row.name}`,
    };
  }
}
