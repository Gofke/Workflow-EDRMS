import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadRegistrationConfig } from '../config/registration-config';
import { CorrespondenceItem, ItemState } from './correspondence-item.entity';
import { CreateDraftDto, ItemView, UpdateDraftDto } from './records.dto';
import { AccessService } from '../access/access.service';
import { newTrackingCode } from '../common/codes';
import { SettingsService } from '../settings/settings.service';

export interface Actor {
  accountId: string;
  description: string;
  /** Set only when acting under delegated authority (FR-DEL-003). */
  onBehalfOfAccountId?: string;
  representedAuthority?: string;
}

@Injectable()
export class RegistrationService {
  private readonly config = loadRegistrationConfig();

  constructor(
    @InjectRepository(CorrespondenceItem) private readonly items: Repository<CorrespondenceItem>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The newest records. V0.3.0: filtered by the record-level evaluator when the
   * caller is known, so a classified record never appears in someone's list.
   */
  async list(accountId?: string, limit = 200): Promise<ItemView[]> {
    const items = await this.items.find({
      relations: { createdBy: { person: true }, owningUnit: true },
      order: { createdAt: 'DESC' },
      take: accountId ? Math.max(limit, 500) : limit,
    });
    if (!accountId) return items.slice(0, limit).map(toView);
    const visible = await this.access.visibleItemIds(await this.access.profile(accountId));
    return items.filter((i) => visible.has(i.id)).slice(0, limit).map(toView);
  }

  async findOne(id: string): Promise<ItemView> {
    return toView(await this.load(id));
  }

  /** Creates preparatory material. This is not yet an official record. */
  async createDraft(actor: Actor, dto: CreateDraftDto, source = 'MANUAL'): Promise<ItemView> {
    this.assertMandatoryFields(dto);
    const classification = dto.classification ?? (await this.settings.get('classification')).defaultLevel;
    if (classification === 'SECRET') {
      const profile = await this.access.profile(actor.accountId);
      if (!profile.secret) {
        throw new BadRequestException('Only a person cleared for Secret may create a Secret record.');
      }
    }

    // The row and its audit event are one transaction: no authoritative change
    // without its evidence, even for preparatory material.
    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO correspondence_item (direction, subject, party, document_date, state,
           created_by_account_id, owning_unit_id, classification, sender_reference, reply_requested_by, source)
         VALUES ($1, $2, $3, $4, 'DRAFT', $5,
                 (SELECT organisational_unit_id FROM account WHERE id = $5), $6, $7, $8, $9) RETURNING id`,
        [
          dto.direction,
          dto.subject,
          dto.party ?? null,
          dto.documentDate ?? null,
          actor.accountId,
          classification,
          dto.senderReference?.trim() || null,
          dto.replyRequestedBy ?? null,
          source,
        ],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.DRAFT_CREATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `draft: ${dto.subject}`,
        summary: `${actor.description} created a draft ${dto.direction.toLowerCase()} item: ${dto.subject}.`,
      });
      return row.id as string;
    });

    return toView(await this.load(id));
  }

  /**
   * Edits a draft. The version the client read must match the stored version;
   * otherwise the edit is refused so the other person's change is not silently
   * lost (DEC-05, optimistic version check).
   */
  async updateDraft(actor: Actor, id: string, dto: UpdateDraftDto): Promise<ItemView> {
    const item = await this.load(id);
    if (item.state !== ItemState.DRAFT) {
      throw new BadRequestException('A registered record cannot be edited here.');
    }
    this.assertMandatoryFields(dto);

    const result = await this.items
      .createQueryBuilder()
      .update(CorrespondenceItem)
      .set({
        subject: dto.subject,
        direction: dto.direction,
        party: dto.party ?? null,
        documentDate: dto.documentDate ?? null,
        senderReference: dto.senderReference?.trim() || null,
        replyRequestedBy: dto.replyRequestedBy ?? null,
        version: () => '"version" + 1',
      })
      .where('id = :id AND version = :version', { id, version: dto.version })
      .execute();

    if (result.affected === 0) {
      throw new ConflictException(
        'Someone else changed this item while you were editing it. Reload and apply your change again.',
      );
    }
    return toView(await this.load(id));
  }

  /**
   * Registration: the act that turns preparatory material into an official
   * record. The identity and the timestamp are produced here, server-side, in
   * one transaction. Nothing the client sends can influence either.
   */
  async register(actor: Actor, id: string, version: number): Promise<ItemView> {
    const item = await this.load(id);
    if (item.state === ItemState.REGISTERED) {
      throw new BadRequestException('This item is already registered.');
    }
    this.assertMandatoryFields(item);

    const identity = await this.dataSource.transaction(async (manager) => {
      const registeredSubject = item.subject;
      const [{ nextval }] = await manager.query(
        `SELECT nextval('registration_sequence') AS nextval`,
      );
      const assigned = this.buildIdentity(item.direction, Number(nextval));

      const outcome = await manager
        .createQueryBuilder()
        .update(CorrespondenceItem)
        .set({
          registrationIdentity: assigned,
          state: ItemState.REGISTERED,
          registeredAt: () => 'now()',
          version: () => '"version" + 1',
        })
        .where('id = :id AND version = :version AND state = :state', {
          id,
          version,
          state: ItemState.DRAFT,
        })
        .execute();

      if (outcome.affected === 0) {
        throw new ConflictException(
          'This item changed while you were registering it. Reload and try again.',
        );
      }
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ITEM_REGISTERED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${assigned} — ${registeredSubject}`,
        previousValue: 'draft',
        newValue: `registered as ${assigned}`,
        summary: `${actor.description} registered ${item.direction.toLowerCase()} item ${assigned}: ${registeredSubject}.`,
      });
      return assigned;
    });

    void identity;
    // V0.3.0: an incoming letter gets a tracking code for its sender.
    if (item.direction === 'INCOMING') {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const inserted = await this.dataSource
          .query(`INSERT INTO item_tracking (item_id, tracking_code) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING item_id`, [id, newTrackingCode()])
          .catch(() => []);
        if (inserted.length) break;
      }
    }
    return toView(await this.load(id));
  }

  /**
   * Applies the configured pattern. The syntax is configuration, not policy:
   * DEC-01 is open, so nothing here asserts what a Ministry reference should
   * look like.
   */
  private buildIdentity(direction: string, sequence: number): string {
    return this.config.identityPattern
      .replace('{DIRECTION}', this.config.directionMarkers[direction] ?? direction)
      .replace('{YEAR}', String(new Date().getFullYear()))
      .replace('{SEQ}', String(sequence).padStart(this.config.sequencePadding, '0'));
  }

  /** Enforces the configured mandatory set (DEC-08), never a set of its own. */
  private assertMandatoryFields(candidate: object): void {
    const values = candidate as Record<string, unknown>;
    const missing = this.config.mandatoryFields.filter((field) => {
      const value = values[field];
      return value === undefined || value === null || String(value).trim() === '';
    });
    if (missing.length > 0) {
      throw new BadRequestException(
        `These details are required before this can be saved or registered: ${missing.join(', ')}.`,
      );
    }
  }

  private async load(id: string): Promise<CorrespondenceItem> {
    const item = await this.items.findOne({
      where: { id },
      relations: { createdBy: { person: true }, owningUnit: true },
    });
    if (!item) throw new NotFoundException('Unknown item.');
    return item;
  }
}

function toView(item: CorrespondenceItem): ItemView {
  return {
    id: item.id,
    registrationIdentity: item.registrationIdentity,
    state: item.state,
    direction: item.direction,
    subject: item.subject,
    party: item.party,
    documentDate: item.documentDate,
    registeredAt: item.registeredAt ? item.registeredAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
    version: item.version,
    createdByName: item.createdBy?.person?.fullName ?? 'unknown',
    owningUnit: item.owningUnit?.name ?? null,
    classification: item.classification,
    source: item.source,
    senderReference: item.senderReference,
    replyRequestedBy: item.replyRequestedBy,
  };
}
