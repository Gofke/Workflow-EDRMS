export const DOSSIER_ID = '11111111-1111-4111-8111-111111111111';
export const ITEM_ID = '22222222-2222-4222-8222-222222222222';
export const ME = 'me-0000-0000-0000-000000000001';

export function dossier(overrides: Record<string, unknown> = {}) {
  return {
    id: DOSSIER_ID,
    dossierIdentity: 'DOS-2026-0009',
    subject: 'Gratieverzoek J. Pinas',
    state: 'OPEN',
    processingState: 'ACTIVE',
    dueDate: '2026-11-20',
    responsibleName: 'S. Hiwat',
    responsibleAccountId: 'other-account',
    classification: 'INTERNAL',
    categoryId: null,
    legalHold: false,
    retentionState: 'ACTIVE',
    retentionDueDate: null,
    owningUnit: 'Juridische Zaken en Wetgeving',
    createdAt: '2026-10-01T12:00:00Z',
    version: 4,
    createdByName: 'L. Amatredjo',
    linkedItems: [],
    ...overrides,
  };
}

export function route(currentReviewerAccountId: string) {
  return {
    id: 'r1',
    name: 'Ministeriële beslissing',
    steps: [
      { index: 0, role: 'ONDER_DIRECTEUR', label: 'Paraaf Onder-Directeur', status: 'DONE' },
      { index: 1, role: 'DIRECTEUR', label: 'Advies Directeur', status: 'CURRENT' },
      { index: 2, role: 'MINISTER', label: 'Besluit Minister', status: 'PENDING' },
    ],
    currentStep: 1,
    currentReviewerAccountId,
    currentReviewerName: currentReviewerAccountId === ME ? 'T. Tester' : 'M. Sardjoe',
    decisions: [{ stepIndex: 0, stepLabel: 'Paraaf Onder-Directeur', actorName: 'A. Boldewijn', occurredAt: '2026-10-20T12:00:00Z', note: null, nextReviewerName: 'M. Sardjoe' }],
    completedAt: null,
    endedReason: null,
  };
}

export function draftItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    registrationIdentity: null,
    state: 'DRAFT',
    direction: 'INCOMING',
    subject: 'Nieuw poststuk',
    party: null,
    documentDate: null,
    senderReference: null,
    replyRequestedBy: null,
    classification: 'INTERNAL',
    source: 'MANUAL',
    version: 1,
    createdAt: '2026-10-28T12:00:00Z',
    registeredAt: null,
    ...overrides,
  };
}
