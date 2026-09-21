import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { RequireRoles } from '../auth/require-roles.decorator';
import { timelineToCsv } from './timeline-export';
import { DEFAULT_PAGE, TimelineEntry, TimelinePage, TimelineService } from './timeline.service';

/**
 * Reading a matter's history is business work, so every business role may do
 * it. SYS_ADMIN is absent: the timeline is record content in chronological
 * form, and administrative power confers no access to it (FR-SEC-010).
 */
const BUSINESS_ROLES = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'];

@Controller('api/dossiers')
export class TimelineController {
  constructor(
    private readonly timeline: TimelineService,
    private readonly audit: AuditService,
  ) {}

  /** The whole account. Unchanged since V0.1.12; the tester packs rely on it. */
  @Get(':id/timeline')
  @RequireRoles(...BUSINESS_ROLES)
  forDossier(@Param('id') id: string): Promise<TimelineEntry[]> {
    return this.timeline.forDossier(id);
  }

  /** One page, oldest first. Follow nextCursor for the next page. */
  @Get(':id/timeline/page')
  @RequireRoles(...BUSINESS_ROLES)
  page(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<TimelinePage> {
    return this.timeline.page(id, cursor ?? null, limit ? Number(limit) : DEFAULT_PAGE);
  }

  /**
   * The whole account as a CSV file.
   *
   * Reading on screen writes nothing, but an export is different: it hands the
   * account to someone outside the system, so it is recorded (who exported
   * which matter, and how many entries). Nothing about the matter changes.
   */
  @Get(':id/timeline/export')
  @RequireRoles(...BUSINESS_ROLES)
  async export(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    const dossier = await this.timeline.dossierFor(id);
    const entries = await this.timeline.forDossier(id);
    const user = request.authenticatedUser;
    const exportedBy = user ? `${user.personName} (${user.email})` : 'unknown';

    await this.audit.record({
      eventType: AuditEventType.TIMELINE_EXPORTED,
      actorAccountId: user?.accountId ?? null,
      actorDescription: exportedBy,
      subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
      newValue: `${entries.length} entries, CSV`,
      summary: `${exportedBy} exported the timeline of ${dossier.dossierIdentity} (${entries.length} entries).`,
    });

    const csv = timelineToCsv(entries, {
      dossierIdentity: dossier.dossierIdentity,
      subject: dossier.subject,
      exportedBy,
      exportedAt: new Date(),
    });
    const filename = `${dossier.dossierIdentity}-timeline.csv`.replace(/[^A-Za-z0-9._-]/g, '_');
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.end(csv);
  }
}
