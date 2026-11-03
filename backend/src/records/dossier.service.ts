import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadRegistrationConfig } from '../config/registration-config';
import { CorrespondenceItem, ItemState } from './correspondence-item.entity';
import { assertDossierNotClosed, Dossier, DossierLink } from './dossier.entity';
import { ResponsibilityAssignment } from './responsibility.entity';
import { Actor } from './registration.service';
import { AccessService } from '../access/access.service';
import { SettingsService } from '../settings/settings.service';
import { WorkingDaysService } from '../core/working-days.service';
import { todayInSuriname } from '../common/actor';

export interface DossierView {
  id: string;
  dossierIdentity: string;
  subject: string;
  state: string;
  processingState: string;
  dueDate: string | null;
  responsibleName: string | null;
  /** V0.3.0 */
  responsibleAccountId: string | null;
  classification: string;
  categoryId: string | null;
  legalHold: boolean;
  retentionState: string;
  retentionDueDate: string | null;
  owningUnit: string | null;
  createdAt: string;
  version: number;
  createdByName: string;
  linkedItems: {
    id: string;
    registrationIdentity: string | null;
    subject: string;
    direction: string;
    linkedAt: string;
  }[];
}

@Injectable()
export class DossierService {
  private readonly config = loadRegistrationConfig();

  constructor(
    @InjectRepository(Dossier) private readonly dossiers: Repository<Dossier>,
    @InjectRepository(ResponsibilityAssignment)
    private readonly assignments: Repository<ResponsibilityAssignment>,
    @InjectRepository(DossierLink) private readonly links: Repository<DossierLink>,
    @InjectRepository(CorrespondenceItem) private readonly items: Repository<CorrespondenceItem>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly workingDays: WorkingDaysService,
  ) {}

  async list(accountId?: string): Promise<DossierView[]> {
    let dossiers = await this.dossiers.find({
      relations: { createdBy: { person: true }, owningUnit: true },
      order: { createdAt: 'DESC' },
      take: accountId ? 1000 : 200,
    });
    if (accountId) {
      const visible = await this.access.visibleDossierIds(await this.access.profile(accountId));
      dossiers = dossiers.filter((d) => visible.has(d.id)).slice(0, 200);
    }
    const links = await this.links.find({ relations: { dossier: true, item: true } });
    const current = await this.assignments.find({
      where: { supersededAt: IsNull() },
      relations: { dossier: true, responsible: { person: true } },
    });
    return dossiers.map((dossier) => toView(dossier, links, current));
  }

  /**
   * Creates the workspace for a matter. The identity is assigned server-side
   * from a sequence; the creation time is the database's own.
   */
  async create(actor: Actor, subject: string, options: { categoryId?: string; classification?: string } = {}): Promise<DossierView> {
    if (!subject || subject.trim() === '') {
      throw new BadRequestException('A subject is required.');
    }
    let category: { id: string; default_classification: string; code: string; handling_working_days: number | null } | null = null;
    if (options.categoryId) {
      [category] = await this.dataSource.query(
        `SELECT id, default_classification, code, handling_working_days FROM dossier_category WHERE id = $1 AND is_active`,
        [options.categoryId],
      );
      if (!category) throw new BadRequestException('Unknown or inactive category.');
    }
    const classification =
      options.classification ?? category?.default_classification ?? (await this.settings.get('classification')).defaultLevel;
    if (classification === 'SECRET' && !(await this.access.profile(actor.accountId)).secret) {
      throw new BadRequestException('Only a person cleared for Secret may open a Secret dossier.');
    }
    const numbering = await this.settings.get('numbering');
    const pattern = numbering.dossierPattern ?? this.config.dossierIdentityPattern;
    const padding = numbering.dossierPadding ?? this.config.dossierSequencePadding;

    // The category's handling time gives the first deadline, in working days
    // (weekends and holidays skipped). A manager can change it later, with a reason.
    const due = category?.handling_working_days ? await this.workingDays.addWorkingDays(todayInSuriname(), category.handling_working_days) : null;
    const created = await this.dataSource.transaction(async (manager) => {
      const [{ nextval }] = await manager.query(`SELECT nextval('dossier_sequence') AS nextval`);
      const identity = pattern
        .replace('{YEAR}', String(new Date().getFullYear()))
        .replace('{CATEGORY}', category?.code ?? 'ALG')
        .replace('{SEQ}', String(nextval).padStart(padding, '0'));

      const [row] = await manager.query(
        `INSERT INTO dossier (dossier_identity, subject, created_by_account_id, owning_unit_id, classification, category_id, due_date)
         VALUES ($1, $2, $3, (SELECT organisational_unit_id FROM account WHERE id = $3), $4, $5, $6) RETURNING id`,
        [identity, subject.trim(), actor.accountId, classification, category?.id ?? null, due],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.DOSSIER_CREATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${identity} — ${subject.trim()}`,
        newValue: due ? `${identity}, deadline ${due} (from the file plan)` : identity,
        summary: `${actor.description} created dossier ${identity}: ${subject.trim()}${due ? `; deadline ${due} from the file plan category` : ''}.`,
      });
      return { id: row.id as string, identity };
    });

    return this.load(created.id);
  }

  /**
   * Links a registered record to a dossier (BR-004).
   *
   * Only a registered record may be linked. A draft is preparatory material,
   * and placing it in a matter file would let it be mistaken for official
   * evidence of that matter.
   *
   * The item is linked, never copied. One record may belong to several
   * dossiers; the same pair cannot be linked twice.
   */
  async link(actor: Actor, dossierId: string, itemId: string): Promise<DossierView> {
    const dossier = await this.dossiers.findOne({ where: { id: dossierId } });
    if (!dossier) throw new NotFoundException('Unknown dossier.');

    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Unknown correspondence item.');
    if (item.state !== ItemState.REGISTERED) {
      throw new BadRequestException(
        'Only a registered record can be linked to a dossier. Register it first.',
      );
    }

    assertDossierNotClosed(dossier);
    if (dossier.processingState === 'FINALISED') {
      throw new BadRequestException(
        'This matter is finalised. Reopen it before adding records to it.',
      );
    }

    const existing = await this.links.findOne({
      where: { dossier: { id: dossierId }, item: { id: itemId } },
    });
    if (existing) {
      throw new BadRequestException('That record is already linked to this dossier.');
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO dossier_link (dossier_id, correspondence_item_id, linked_by_account_id)
         VALUES ($1, $2, $3)`,
        [dossierId, itemId, actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.RECORD_LINKED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${item.registrationIdentity} → ${dossier.dossierIdentity}`,
        newValue: `linked to ${dossier.dossierIdentity}`,
        summary: `${actor.description} linked record ${item.registrationIdentity} to dossier ${dossier.dossierIdentity}.`,
      });
    });

    return this.load(dossierId);
  }

  /** One dossier, as returned after a change. */
  async recordOpened(accountId: string, view: DossierView): Promise<void> {
    await this.access.recordView(accountId, 'DOSSIER', view.id, `${view.dossierIdentity} — ${view.subject}`);
  }

  find(id: string): Promise<DossierView> {
    return this.load(id);
  }

  private async load(id: string): Promise<DossierView> {
    const dossier = await this.dossiers.findOne({
      where: { id },
      relations: { createdBy: { person: true }, owningUnit: true },
    });
    if (!dossier) throw new NotFoundException('Unknown dossier.');
    const links = await this.links.find({
      where: { dossier: { id } },
      relations: { dossier: true, item: true },
    });
    const current = await this.assignments.find({
      where: { dossier: { id }, supersededAt: IsNull() },
      relations: { dossier: true, responsible: { person: true } },
    });
    return toView(dossier, links, current);
  }
}

function toView(
  dossier: Dossier,
  links: DossierLink[],
  current: ResponsibilityAssignment[],
): DossierView {
  const owner = current.find((a) => a.dossier.id === dossier.id);
  return {
    id: dossier.id,
    dossierIdentity: dossier.dossierIdentity,
    subject: dossier.subject,
    state: dossier.state,
    processingState: dossier.processingState,
    dueDate: dossier.dueDate,
    responsibleName: owner?.responsible?.person?.fullName ?? null,
    responsibleAccountId: owner?.responsible?.id ?? null,
    classification: dossier.classification,
    categoryId: dossier.categoryId,
    legalHold: dossier.legalHold,
    retentionState: dossier.retentionState,
    retentionDueDate: dossier.retentionDueDate,
    owningUnit: dossier.owningUnit?.name ?? null,
    createdAt: dossier.createdAt.toISOString(),
    version: dossier.version,
    createdByName: dossier.createdBy?.person?.fullName ?? 'unknown',
    linkedItems: links
      .filter((link) => link.dossier.id === dossier.id)
      .map((link) => ({
        id: link.item.id,
        registrationIdentity: link.item.registrationIdentity,
        subject: link.item.subject,
        direction: link.item.direction,
        linkedAt: link.linkedAt.toISOString(),
      })),
  };
}
