import { describe, expect, it } from 'vitest';
import { auditSummaryNl } from './auditText';

/** The stored log line stays as it is; the Dutch screen reads it in Dutch. */
describe('Audit lines in Dutch', () => {
  it('rewrites the common lines, keeping names, numbers and reasons', () => {
    expect(auditSummaryNl('T. Kromodimedjo signed in.')).toBe('T. Kromodimedjo heeft zich aangemeld.');
    expect(auditSummaryNl('M. Sardjoe (directeur@juspol.test) closed dossier DOS-2026-0001 (reason: Uitnodiging beantwoord.).')).toBe(
      'M. Sardjoe (directeur@juspol.test) sloot zaak DOS-2026-0001 af (reden: Uitnodiging beantwoord.).',
    );
    expect(auditSummaryNl('DOS-2026-0009 — Gratieverzoek J. Pinas is 1 working day(s) overdue and was escalated (level 2) to R. Dijkstra.')).toBe(
      'DOS-2026-0009 — Gratieverzoek J. Pinas is 1 werkdag over tijd en is geëscaleerd (niveau 2) naar R. Dijkstra.',
    );
  });

  it('leaves a line it does not know unchanged', () => {
    expect(auditSummaryNl('Something new happened.')).toBe('Something new happened.');
  });
});
