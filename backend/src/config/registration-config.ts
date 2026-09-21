/**
 * Parameters that the frozen baseline leaves open. Nothing here is a Suriname
 * policy value: each is configuration, and each names the decision it waits on.
 *
 * DEC-01 — registration numbering scheme. OPEN. The pattern below is a neutral
 * default so the PoC can run; it is NOT a proposed scheme. Tokens:
 *   {DIRECTION} incoming / outgoing / internal marker
 *   {YEAR}      four-digit year of registration, server time
 *   {SEQ}       zero-padded sequence, unique per the scope configured below
 *
 * DEC-08 — minimum mandatory metadata set per direction. OPEN. Whatever is
 * listed is enforced; the application asserts nothing about what ought to be
 * listed.
 *
 * DEC-11 — dossier identity scheme. OPEN. Same treatment as DEC-01: a neutral
 * default so the PoC runs, and no proposed scheme.
 *
 * DEC-12 — which due-date changes require a reason. OPEN. 'change' (the
 * default) asks for a reason when an existing official deadline moves or is
 * removed, but not when one is first set. 'always' and 'never' are the other
 * two positions. This is a placeholder, not a recommendation.
 */
export interface RegistrationConfig {
  identityPattern: string;
  sequencePadding: number;
  directionMarkers: Record<string, string>;
  mandatoryFields: string[];
  dossierIdentityPattern: string;
  dossierSequencePadding: number;
  dueDateReasonRequiredOn: 'always' | 'change' | 'never';
}

export function loadRegistrationConfig(): RegistrationConfig {
  return {
    identityPattern: process.env.REGISTRATION_IDENTITY_PATTERN ?? '{DIRECTION}-{YEAR}-{SEQ}',
    sequencePadding: Number(process.env.REGISTRATION_SEQUENCE_PADDING ?? 5),
    directionMarkers: {
      INCOMING: process.env.REGISTRATION_MARKER_INCOMING ?? 'IN',
      OUTGOING: process.env.REGISTRATION_MARKER_OUTGOING ?? 'UIT',
      INTERNAL: process.env.REGISTRATION_MARKER_INTERNAL ?? 'INT',
    },
    // Default set deliberately minimal: subject and direction only. Extend via
    // REGISTRATION_MANDATORY_FIELDS once DEC-08 is decided.
    mandatoryFields: (process.env.REGISTRATION_MANDATORY_FIELDS ?? 'subject')
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean),
    dossierIdentityPattern: process.env.DOSSIER_IDENTITY_PATTERN ?? 'DOS-{YEAR}-{SEQ}',
    dossierSequencePadding: Number(process.env.DOSSIER_SEQUENCE_PADDING ?? 4),
    dueDateReasonRequiredOn: (process.env.DUE_DATE_REASON_REQUIRED_ON ??
      'change') as RegistrationConfig['dueDateReasonRequiredOn'],
  };
}
