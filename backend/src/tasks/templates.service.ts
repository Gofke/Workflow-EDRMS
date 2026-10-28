import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { todayInSuriname } from '../common/actor';
import { WorkingDaysService } from '../core/working-days.service';
import { Actor } from '../records/registration.service';
import { TasksService, TaskView } from './tasks.service';

export interface TemplateInput {
  name: string;
  description?: string;
  titleTemplate: string;
  defaultPriority?: string;
  defaultDueWorkingDays?: number | null;
  checklist?: string[];
  subtasks?: { title: string; dueOffsetWorkingDays?: number | null }[];
  isActive?: boolean;
}

/**
 * Standard procedures as reusable task templates — "answer a parliamentary
 * question", "prepare a ministerial letter" — with their checklist and their
 * standard subtasks, so the same work is done the same way every time.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
    private readonly workingDays: WorkingDaysService,
  ) {}

  list(includeInactive = false) {
    return this.dataSource.query(
      `SELECT id, name, description, title_template AS "titleTemplate", default_priority AS "defaultPriority",
              default_due_working_days AS "defaultDueWorkingDays", checklist, subtasks, is_active AS "isActive",
              updated_at AS "updatedAt"
         FROM task_template WHERE ($1::boolean OR is_active) ORDER BY name`,
      [includeInactive],
    );
  }

  async save(actor: Actor, id: string | null, input: TemplateInput) {
    validate(input);
    const exists = await this.dataSource.query(
      `SELECT id FROM task_template WHERE lower(name) = lower($1) AND is_active AND ($2::uuid IS NULL OR id <> $2)`,
      [input.name.trim(), id],
    );
    if (exists.length) throw new ConflictException('A template with this name already exists.');
    const saved = await this.dataSource.transaction(async (manager) => {
      let rowId = id;
      if (id) {
        const result = await manager.query(
          `UPDATE task_template SET name = $2, description = $3, title_template = $4, default_priority = $5,
             default_due_working_days = $6, checklist = $7, subtasks = $8, is_active = $9, updated_at = now()
           WHERE id = $1`,
          [id, input.name.trim(), input.description?.trim() ?? '', input.titleTemplate.trim(), input.defaultPriority ?? 'MEDIUM',
            input.defaultDueWorkingDays ?? null, JSON.stringify(input.checklist ?? []), JSON.stringify(input.subtasks ?? []), input.isActive ?? true],
        );
        if (result[1] === 0) throw new NotFoundException('Unknown template.');
      } else {
        const [row] = await manager.query(
          `INSERT INTO task_template (name, description, title_template, default_priority, default_due_working_days,
             checklist, subtasks, created_by_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [input.name.trim(), input.description?.trim() ?? '', input.titleTemplate.trim(), input.defaultPriority ?? 'MEDIUM',
            input.defaultDueWorkingDays ?? null, JSON.stringify(input.checklist ?? []), JSON.stringify(input.subtasks ?? []), actor.accountId],
        );
        rowId = row.id;
      }
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.TASK_TEMPLATE_SAVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `template: ${input.name.trim()}`.slice(0, 260),
        summary: `${actor.description} ${id ? 'updated' : 'created'} the task template "${input.name.trim()}".`,
      });
      return rowId as string;
    });
    return (await this.list(true)).find((t: { id: string }) => t.id === saved);
  }

  /**
   * Creates the task the template describes, with its checklist and subtasks.
   * Placeholders in the title: {subject} and {reference} of the linked matter
   * or letter.
   */
  async apply(
    actor: Actor,
    templateId: string,
    input: { assigneeAccountId: string; dossierId?: string | null; itemId?: string | null; dueDate?: string | null; title?: string },
  ): Promise<TaskView> {
    const [template] = await this.dataSource.query(`SELECT * FROM task_template WHERE id = $1 AND is_active`, [templateId]);
    if (!template) throw new NotFoundException('Unknown template.');
    let subject = '';
    let reference = '';
    if (input.dossierId) {
      const [d] = await this.dataSource.query(`SELECT subject, dossier_identity FROM dossier WHERE id = $1`, [input.dossierId]);
      subject = d?.subject ?? '';
      reference = d?.dossier_identity ?? '';
    } else if (input.itemId) {
      const [i] = await this.dataSource.query(`SELECT subject, registration_identity FROM correspondence_item WHERE id = $1`, [input.itemId]);
      subject = i?.subject ?? '';
      reference = i?.registration_identity ?? '';
    }
    const today = todayInSuriname();
    const due =
      input.dueDate ??
      (template.default_due_working_days ? await this.workingDays.addWorkingDays(today, template.default_due_working_days) : null);
    const title = (input.title?.trim() || template.title_template.replace('{subject}', subject).replace('{reference}', reference)).slice(0, 200);
    const parent = await this.tasks.create(actor, {
      title,
      description: template.description,
      assigneeAccountId: input.assigneeAccountId,
      dueDate: due,
      priority: template.default_priority,
      dossierId: input.dossierId ?? null,
      itemId: input.itemId ?? null,
      checklist: template.checklist,
      source: 'TEMPLATE',
      templateId,
    });
    for (const sub of (template.subtasks ?? []) as { title: string; dueOffsetWorkingDays?: number | null }[]) {
      const subDue = sub.dueOffsetWorkingDays ? await this.workingDays.addWorkingDays(today, sub.dueOffsetWorkingDays) : due;
      await this.tasks.create(actor, {
        title: sub.title.replace('{subject}', subject).replace('{reference}', reference).slice(0, 200),
        assigneeAccountId: input.assigneeAccountId,
        dueDate: subDue && due && subDue > due ? due : subDue,
        parentTaskId: parent.id,
        source: 'TEMPLATE',
        templateId,
      });
    }
    return parent;
  }
}

function validate(input: TemplateInput): void {
  if (!input.name?.trim() || input.name.length > 200) throw new BadRequestException('A template needs a name.');
  if (!input.titleTemplate?.trim() || input.titleTemplate.length > 200) throw new BadRequestException('A template needs a task title.');
  if (input.defaultPriority && !['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(input.defaultPriority)) {
    throw new BadRequestException('Unknown priority.');
  }
  if (input.defaultDueWorkingDays !== undefined && input.defaultDueWorkingDays !== null && (!Number.isInteger(input.defaultDueWorkingDays) || input.defaultDueWorkingDays < 0 || input.defaultDueWorkingDays > 365)) {
    throw new BadRequestException('The standard handling time is out of range.');
  }
  if ((input.checklist ?? []).length > 30 || (input.subtasks ?? []).length > 15) throw new BadRequestException('Too many items in the template.');
}
