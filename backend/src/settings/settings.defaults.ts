/**
 * Every setting an administrator may change from the screen, with its default.
 *
 * Secrets are deliberately absent. SMTP passwords, SMS gateway tokens and AI
 * API keys stay in the server's environment file, where they are read by the
 * server and never returned to a browser.
 *
 * Where a setting stands in for an open Ministry decision, the comment names
 * the decision. The default is a placeholder to let the system run, not a
 * proposal.
 */
export interface Settings {
  branding: {
    organisationName: string;
    productName: string;
    tagline: string;
    primaryColor: string;
    accentColor: string;
    logoDataUrl: string | null;
    letterheadLines: string[];
    signatoryTitle: string;
  };
  /** DEC-01 / DEC-11. Null falls back to the environment configuration. */
  numbering: {
    registrationPattern: string | null;
    registrationPadding: number | null;
    dossierPattern: string | null;
    dossierPadding: number | null;
    taskPattern: string;
    taskPadding: number;
  };
  deadlines: {
    /** Working days before a deadline on which a reminder is sent. */
    reminderDaysBefore: number[];
    /** Working days after a missed deadline before the supervisor is told. */
    escalateAfterWorkingDays: number;
    /** Working days after the first escalation before the next level is told. */
    secondEscalationAfterWorkingDays: number;
    /** Standard handling time for an incoming letter without a category. */
    defaultIncomingWorkingDays: number;
  };
  tasks: {
    requireChecklistForCompletion: boolean;
    requireSubtasksForCompletion: boolean;
  };
  security: {
    /** Roles that must use two-step verification. */
    mfaRequiredForRoles: string[];
    lockoutThreshold: number;
    lockoutWindowMinutes: number;
    lockoutMinutes: number;
    passwordMinLength: number;
  };
  /** DEC-02 is open. These clearances are placeholders until it is decided. */
  classification: {
    defaultLevel: 'OPEN' | 'INTERNAL' | 'CONFIDENTIAL' | 'SECRET';
    confidentialRoles: string[];
    secretRoles: string[];
    unitSeesConfidential: boolean;
  };
  ai: {
    /** builtin: runs inside this server, free, no data leaves it. */
    provider: 'builtin' | 'ollama' | 'openai-compatible' | 'anthropic';
    baseUrl: string;
    model: string;
    /** Must be true before a provider outside this server may be used. */
    externalProviderAcknowledged: boolean;
    features: {
      chat: boolean;
      intake: boolean;
      summary: boolean;
      draftReply: boolean;
      deadlines: boolean;
      duplicates: boolean;
      routing: boolean;
      risk: boolean;
      translate: boolean;
      meetingNotes: boolean;
      ask: boolean;
    };
  };
  notifications: {
    emailEnabled: boolean;
    smsEnabled: boolean;
    pushEnabled: boolean;
    digestHour: number;
    weeklyReportWeekday: number;
    weeklyReportHour: number;
  };
  workflow: {
    blockSubmitWithOpenAdvice: boolean;
  };
  publicTracking: {
    enabled: boolean;
  };
  training: {
    enabled: boolean;
    banner: string;
  };
  language: {
    default: 'nl' | 'en';
  };
}

export type SettingKey = keyof Settings;

export const SETTING_DEFAULTS: Settings = {
  branding: {
    organisationName: 'Ministerie van Justitie en Politie',
    productName: 'JusPol EDRMS',
    tagline: 'Digitaal dossier- en werkstroombeheer',
    primaryColor: '#15325b',
    accentColor: '#c9a227',
    logoDataUrl: null,
    letterheadLines: ['Ministerie van Justitie en Politie', 'Paramaribo, Suriname'],
    signatoryTitle: 'De Minister van Justitie en Politie',
  },
  numbering: {
    registrationPattern: null,
    registrationPadding: null,
    dossierPattern: null,
    dossierPadding: null,
    taskPattern: 'TAAK-{YEAR}-{SEQ}',
    taskPadding: 4,
  },
  deadlines: {
    reminderDaysBefore: [5, 2, 1],
    escalateAfterWorkingDays: 1,
    secondEscalationAfterWorkingDays: 5,
    defaultIncomingWorkingDays: 15,
  },
  tasks: {
    requireChecklistForCompletion: true,
    requireSubtasksForCompletion: true,
  },
  security: {
    mfaRequiredForRoles: [],
    lockoutThreshold: 5,
    lockoutWindowMinutes: 15,
    lockoutMinutes: 15,
    passwordMinLength: 12,
  },
  classification: {
    defaultLevel: 'INTERNAL',
    confidentialRoles: ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'],
    secretRoles: ['MINISTER'],
    unitSeesConfidential: true,
  },
  ai: {
    provider: 'builtin',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1:8b',
    externalProviderAcknowledged: false,
    features: {
      chat: false,
      intake: false,
      summary: false,
      draftReply: false,
      deadlines: false,
      duplicates: false,
      routing: false,
      risk: false,
      translate: false,
      meetingNotes: false,
      ask: false,
    },
  },
  notifications: {
    emailEnabled: true,
    smsEnabled: false,
    pushEnabled: true,
    digestHour: 7,
    weeklyReportWeekday: 1,
    weeklyReportHour: 7,
  },
  workflow: {
    blockSubmitWithOpenAdvice: false,
  },
  publicTracking: {
    enabled: true,
  },
  training: {
    enabled: false,
    banner: 'Oefenomgeving — dit zijn geen echte gegevens.',
  },
  language: {
    default: 'nl',
  },
};

/** Settings any signed-out visitor may see: the sign-in page needs them. */
export const PUBLIC_SETTING_KEYS: SettingKey[] = ['branding', 'language', 'training', 'publicTracking'];
