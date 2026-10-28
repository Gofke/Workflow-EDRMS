import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, renderPage, server } from '../test/harness';
import { draftItem, ITEM_ID, ME } from '../test/fixtures';
import PostDetailPage from './PostDetailPage';

const DOC = [{ id: 'doc-1', originalFilename: 'brief.pdf', mediaType: 'application/pdf', byteSize: 1200, contentHash: 'ab'.repeat(32), capturedAt: '2026-10-28T12:00:00Z', capturedByName: 'L. Amatredjo' }];
const INTAKE = {
  interactionId: 'ai-1',
  engine: { provider: 'builtin', model: 'juspol-assistent 1.0 (ingebouwd)', local: true },
  readable: true,
  proposals: {
    language: 'nl',
    subject: { value: 'Verzoek om overplaatsing gedetineerde R. Pinas', confidence: 0.95, basis: 'Betreft: Verzoek om overplaatsing gedetineerde R. Pinas' },
    party: { value: 'Advocatenkantoor Venetiaan', confidence: 0.75, basis: 'Advocatenkantoor Venetiaan' },
    documentDate: { value: '2026-10-20', confidence: 0.85, basis: 'datum bovenaan de brief' },
    senderReference: null,
    deadlines: [{ phrase: 'binnen 10 werkdagen', dueDate: '2026-11-03', kind: 'RELATIVE_WORKING_DAYS', confidence: 0.8 }],
    classification: null,
    requests: [],
    wordCount: 80,
  },
  routing: null,
  category: null,
  duplicates: [],
};

const open = () => renderPage(<PostDetailPage />, { path: `/post/${ITEM_ID}`, route: '/post/:id' });

/** Registering post: the assistant proposes, the person decides; a probable duplicate is shown before the number is given. */
describe('Registering a draft letter', () => {
  it('shows the assistant’s proposal without changing any field until the person accepts it', async () => {
    const s = server(me(['SUPPORT_STAFF'], ME), {
      [`GET /api/records/${ITEM_ID}`]: draftItem(),
      [`GET /api/records/${ITEM_ID}/documents`]: DOC,
      [`GET /api/records/${ITEM_ID}/context`]: { dossiers: [], replies: [], inReplyTo: null, tasks: 0, versions: 0 },
      [`POST /api/ai/items/${ITEM_ID}/intake`]: INTAKE,
    });
    open();
    await userEvent.click(await screen.findByTestId('propose'));
    expect(await screen.findByText('Verzoek om overplaatsing gedetineerde R. Pinas')).toBeInTheDocument();
    expect(screen.getByText(/Op grond van: “Betreft: Verzoek om overplaatsing/)).toBeInTheDocument();
    // Nothing is filled in yet.
    expect(screen.getByLabelText('Onderwerp')).toHaveValue('Nieuw poststuk');
    expect(screen.getByLabelText('Afzender')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: /Overnemen/ }));
    expect(screen.getByLabelText('Onderwerp')).toHaveValue('Verzoek om overplaatsing gedetineerde R. Pinas');
    expect(screen.getByLabelText('Afzender')).toHaveValue('Advocatenkantoor Venetiaan');
    expect(screen.getByLabelText('Antwoord gevraagd vóór')).toHaveValue('2026-11-03');
    // The acceptance is recorded, but nothing is saved or registered by it.
    await waitFor(() => expect(s.posted('/api/ai/interactions/ai-1/feedback')[0].body).toMatchObject({ outcome: 'ACCEPTED' }));
    expect(s.calls.some((c) => c.method === 'PUT' || c.path.endsWith('/register'))).toBe(false);
  });

  it('warns about a probable duplicate before registering, and registers only when the person confirms', async () => {
    const s = server(me(['SUPPORT_STAFF'], ME), {
      [`GET /api/records/${ITEM_ID}`]: draftItem({ subject: 'Gratieverzoek J. Pinas', party: 'Advocatenkantoor Venetiaan' }),
      [`GET /api/records/${ITEM_ID}/documents`]: DOC,
      [`GET /api/records/${ITEM_ID}/context`]: { dossiers: [], replies: [], inReplyTo: null, tasks: 0, versions: 0 },
      [`GET /api/records/${ITEM_ID}/possible-duplicates`]: [{ itemId: 'old-1', registrationIdentity: 'IN-2026-00412', subject: 'Gratieverzoek J. Pinas', party: 'Advocatenkantoor Venetiaan', score: 1, reasons: ['zelfde onderwerp en afzender'] }],
      [`POST /api/ai/items/${ITEM_ID}/duplicates`]: { candidates: [] },
      [`POST /api/records/${ITEM_ID}/register`]: draftItem({ state: 'REGISTERED', registrationIdentity: 'IN-2026-00470' }),
    });
    open();
    await userEvent.click(await screen.findByTestId('register'));
    const dialog = await screen.findByRole('dialog', { name: /Mogelijk een dubbel stuk/ });
    expect(within(dialog).getByText('IN-2026-00412')).toBeInTheDocument();
    expect(s.posted(`/api/records/${ITEM_ID}/register`)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Toch registreren' }));
    await waitFor(() => expect(s.posted(`/api/records/${ITEM_ID}/register`)).toHaveLength(1));
  });

  it('registers straight away when nothing resembles it', async () => {
    const s = server(me(['SUPPORT_STAFF'], ME), {
      [`GET /api/records/${ITEM_ID}`]: draftItem({ subject: 'Uitnodiging opening politiepost' }),
      [`GET /api/records/${ITEM_ID}/documents`]: [],
      [`GET /api/records/${ITEM_ID}/context`]: { dossiers: [], replies: [], inReplyTo: null, tasks: 0, versions: 0 },
      [`GET /api/records/${ITEM_ID}/possible-duplicates`]: [],
      [`POST /api/ai/items/${ITEM_ID}/duplicates`]: { candidates: [] },
      [`POST /api/records/${ITEM_ID}/register`]: draftItem({ state: 'REGISTERED', registrationIdentity: 'IN-2026-00471' }),
    });
    open();
    await userEvent.click(await screen.findByTestId('register'));
    await waitFor(() => expect(s.posted(`/api/records/${ITEM_ID}/register`)).toHaveLength(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText(/Geregistreerd als IN-2026-00471/)).toBeInTheDocument();
  });
});
