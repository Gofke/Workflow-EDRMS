import { readableDate } from '../common/actor';
import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { footer, letterhead, newPdf, pdfBuffer, table, surinameDateTime } from '../core/pdf';
import { Actor } from '../records/registration.service';
import { SettingsService } from '../settings/settings.service';
import { DashboardService } from './dashboard.service';

export type ReportName = 'departments' | 'workload' | 'trends' | 'overview';

interface Sheet {
  title: string;
  columns: { key: string; label: string; width: number }[];
  rows: Record<string, unknown>[];
}

/**
 * The management reports as Excel workbooks and PDF documents. Each export is
 * audited: a report leaves the system.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private async sheets(accountId: string, name: ReportName): Promise<{ title: string; sheets: Sheet[] }> {
    if (name === 'departments') {
      return {
        title: 'Prestaties per afdeling (laatste 90 dagen)',
        sheets: [
          {
            title: 'Afdelingen',
            columns: [
              { key: 'name', label: 'Afdeling', width: 34 },
              { key: 'registered', label: 'Geregistreerd', width: 13 },
              { key: 'finalised', label: 'Afgerond', width: 11 },
              { key: 'open', label: 'Open zaken', width: 11 },
              { key: 'overdue', label: 'Over termijn', width: 12 },
              { key: 'onTimePct', label: 'Op tijd %', width: 10 },
              { key: 'avgHandlingDays', label: 'Gem. dagen', width: 11 },
              { key: 'openTasks', label: 'Open taken', width: 11 },
              { key: 'overdueTasks', label: 'Taken te laat', width: 12 },
            ],
            rows: await this.dashboard.departments(90),
          },
        ],
      };
    }
    if (name === 'workload') {
      return {
        title: 'Werkverdeling per persoon',
        sheets: [
          {
            title: 'Werkverdeling',
            columns: [
              { key: 'name', label: 'Naam', width: 26 },
              { key: 'unit', label: 'Afdeling', width: 30 },
              { key: 'openTasks', label: 'Open taken', width: 11 },
              { key: 'overdueTasks', label: 'Te laat', width: 9 },
              { key: 'dueThisWeek', label: 'Deze week', width: 10 },
              { key: 'completed30d', label: 'Afgerond 30 d', width: 13 },
              { key: 'responsibleMatters', label: 'Zaken', width: 8 },
              { key: 'openAdvice', label: 'Adviezen', width: 9 },
            ],
            rows: await this.dashboard.workload(),
          },
        ],
      };
    }
    if (name === 'trends') {
      const t = await this.dashboard.trends(12);
      return {
        title: 'Trends (12 maanden)',
        sheets: [
          {
            title: 'Per maand',
            columns: [
              { key: 'month', label: 'Maand', width: 10 },
              { key: 'incoming', label: 'Inkomend', width: 10 },
              { key: 'outgoing', label: 'Uitgaand', width: 10 },
              { key: 'internal', label: 'Intern', width: 9 },
              { key: 'finalised', label: 'Zaken afgerond', width: 14 },
              { key: 'tasksCompleted', label: 'Taken afgerond', width: 14 },
            ],
            rows: t.months,
          },
          {
            title: 'Afzenders',
            columns: [
              { key: 'name', label: 'Afzender', width: 50 },
              { key: 'letters', label: 'Stukken', width: 10 },
            ],
            rows: t.topSenders,
          },
        ],
      };
    }
    if (name === 'overview') {
      const o = await this.dashboard.overview(accountId);
      const labels: Record<string, string> = {
        openMatters: 'Open zaken',
        overdueMatters: 'Zaken over termijn',
        dueThisWeek: 'Termijn deze week',
        underReview: 'Ter beoordeling',
        awaitingMinister: 'Wacht op de Minister',
        registeredThisMonth: 'Geregistreerd deze maand',
        finalisedThisMonth: 'Afgerond deze maand',
        openTasks: 'Open taken',
        overdueTasks: 'Taken te laat',
        draftsWaiting: 'Concepten te registreren',
        openAdvice: 'Open adviesaanvragen',
      };
      return {
        title: 'Bestuurlijk overzicht',
        sheets: [
          {
            title: 'Kerncijfers',
            columns: [
              { key: 'label', label: 'Kerncijfer', width: 34 },
              { key: 'value', label: 'Waarde', width: 12 },
            ],
            rows: [
              ...Object.entries(o.counts).map(([k, v]) => ({ label: labels[k] ?? k, value: v })),
              { label: 'Op tijd afgerond (90 d) %', value: o.onTime.percentage ?? '—' },
              { label: 'Gemiddelde doorlooptijd (dagen)', value: o.averageHandlingDays ?? '—' },
            ],
          },
          {
            title: 'Over termijn',
            columns: [
              { key: 'dossierIdentity', label: 'Zaak', width: 20 },
              { key: 'subject', label: 'Onderwerp', width: 42 },
              { key: 'dueDate', label: 'Termijn', width: 15 },
              { key: 'workingDaysLate', label: 'Werkdagen te laat', width: 13 },
              { key: 'responsibleName', label: 'Verantwoordelijk', width: 20 },
            ],
            rows: o.overdue,
          },
        ],
      };
    }
    throw new BadRequestException('Unknown report.');
  }

  async excel(actor: Actor, name: ReportName): Promise<{ bytes: Buffer; filename: string }> {
    const { title, sheets } = await this.sheets(actor.accountId, name);
    const branding = await this.settings.get('branding');
    const wb = new ExcelJS.Workbook();
    wb.creator = branding.productName;
    wb.created = new Date();
    for (const sheet of sheets) {
      const ws = wb.addWorksheet(sheet.title);
      ws.addRow([`${branding.organisationName} — ${title}`]).font = { bold: true, size: 13 };
      ws.addRow([`Gemaakt ${surinameDateTime(new Date())} door ${actor.description}`]).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
      ws.addRow([]);
      const header = ws.addRow(sheet.columns.map((c) => c.label));
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${branding.primaryColor.slice(1)}` } };
      });
      sheet.columns.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
      for (const row of sheet.rows) {
        // Values are written as values, never as formulas, whatever they start with.
        ws.addRow(sheet.columns.map((c) => sanitise(row[c.key])));
      }
      ws.views = [{ state: 'frozen', ySplit: 4 }];
    }
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    await this.record(actor, title, 'Excel');
    return { bytes, filename: `${name}-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }

  async pdf(actor: Actor, name: ReportName): Promise<{ bytes: Buffer; filename: string }> {
    const { title, sheets } = await this.sheets(actor.accountId, name);
    const branding = await this.settings.get('branding');
    const doc = newPdf({ title, size: 'A4' });
    letterhead(doc, branding);
    doc.font('Bold').fontSize(16).fillColor(branding.primaryColor).text(title);
    doc.font('Body').fontSize(8.5).fillColor('#6b7280').text(`Gemaakt ${surinameDateTime(new Date())} door ${actor.description}`);
    doc.moveDown(0.8);
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    for (const sheet of sheets) {
      doc.font('Bold').fontSize(11.5).fillColor('#111827').text(sheet.title);
      doc.moveDown(0.3);
      const total = sheet.columns.reduce((a, c) => a + c.width, 0);
      table(
        doc,
        sheet.columns.map((c) => ({ label: c.label, width: (c.width / total) * usable })),
        sheet.rows.map((r) => sheet.columns.map((c) => {
          const v = r[c.key];
          // Dates as a person writes them; everything else as is.
          return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? readableDate(v) : String(v ?? '—');
        })),
        branding.primaryColor,
      );
      doc.moveDown(0.6);
    }
    footer(doc, `${branding.organisationName}, ${title}`);
    const bytes = await pdfBuffer(doc);
    await this.record(actor, title, 'PDF');
    return { bytes, filename: `${name}-${new Date().toISOString().slice(0, 10)}.pdf` };
  }

  private async record(actor: Actor, title: string, format: string) {
    await this.audit.recordStrict({
      eventType: AuditEventType.REPORT_EXPORTED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `report: ${title}`.slice(0, 260),
      newValue: format,
      summary: `${actor.description} exported the report "${title}" as ${format}.`,
    });
  }
}

function sanitise(value: unknown): unknown {
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value ?? '';
}
