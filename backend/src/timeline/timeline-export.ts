import { TimelineEntry } from './timeline.service';

/**
 * The timeline as CSV (V0.1.14).
 *
 * Every field is quoted. A field that a spreadsheet would read as a formula —
 * starting with =, +, -, @, tab or carriage return — is prefixed with an
 * apostrophe, so a reason typed into the system cannot execute when someone
 * opens the export (CSV injection). The prefix is visible, which is the point:
 * the export must not quietly differ from what was recorded.
 *
 * The header lines state what the file is, who produced it and when, by server
 * time, so a printed or forwarded copy carries its own provenance.
 */
export function timelineToCsv(
  entries: TimelineEntry[],
  context: { dossierIdentity: string; subject: string; exportedBy: string; exportedAt: Date },
): string {
  const lines = [
    row(['Dossier', context.dossierIdentity]),
    row(['Subject', context.subject]),
    row(['Exported by', context.exportedBy]),
    row(['Exported at (UTC)', context.exportedAt.toISOString()]),
    row(['Entries', String(entries.length)]),
    '',
    row(['Occurred at (UTC)', 'What happened', 'By', 'On behalf of', 'Detail', 'Source']),
    ...entries.map((entry) =>
      row([
        entry.occurredAt,
        entry.headline,
        entry.actorName,
        entry.onBehalfOfName ?? '',
        entry.detail ?? '',
        entry.source,
      ]),
    ),
  ];
  // BOM so Excel reads names such as "Pawironadi" or accented text as UTF-8.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function row(fields: string[]): string {
  return fields.map(cell).join(',');
}

function cell(value: string): string {
  const neutralised = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${neutralised.replace(/"/g, '""')}"`;
}
