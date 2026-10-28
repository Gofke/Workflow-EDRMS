import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, renderPage, server } from '../test/harness';
import { dossier, DOSSIER_ID, ME, route } from '../test/fixtures';
import DossierDetailPage from './DossierDetailPage';

const open = () => renderPage(<DossierDetailPage />, { path: `/zaken/${DOSSIER_ID}?tab=besluit`, route: '/zaken/:id' });

/**
 * Who may decide, and when. The server refuses a wrong decision anyway; these
 * tests make sure the screen never offers one, because a control that is shown
 * and then refused is how people lose trust in a system.
 */
describe('Matter decision controls', () => {
  it('offers Approve and Return to the reviewer whose step it is, and only after a next reviewer is chosen', async () => {
    server(me(['DIRECTEUR'], ME), {
      [`GET /api/dossiers/${DOSSIER_ID}`]: dossier({ processingState: 'UNDER_REVIEW' }),
      [`GET /api/dossiers/${DOSSIER_ID}/route`]: route(ME),
      'GET /api/org/people': [{ accountId: 'min-1', personName: 'R. Dijkstra', email: 'minister@juspol.test', jobPosition: 'Minister', unitId: null, unit: 'Kabinet', isEnabled: true, roles: ['MINISTER'], absentUntil: null }],
    });
    open();
    const approve = await screen.findByTestId('approve');
    expect(approve).toHaveTextContent('Akkoord en doorsturen');
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: /Terugsturen/ })).toBeEnabled();
    await screen.findByRole('option', { name: /R. Dijkstra/ });
    await userEvent.selectOptions(screen.getByLabelText(/Volgende stap: Besluit Minister/), 'min-1');
    expect(approve).toBeEnabled();
  });

  it('shows someone else’s step as information only, without decision buttons', async () => {
    server(me(['DIRECTEUR'], ME), {
      [`GET /api/dossiers/${DOSSIER_ID}`]: dossier({ processingState: 'UNDER_REVIEW' }),
      [`GET /api/dossiers/${DOSSIER_ID}/route`]: route('someone-else'),
    });
    open();
    expect(await screen.findByText(/Alleen de aangewezen beoordelaar kan beslissen/)).toBeInTheDocument();
    expect(screen.queryByTestId('approve')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Terugsturen/ })).not.toBeInTheDocument();
  });

  it('offers nothing to change on a closed file except reopening, and only to a decision-maker', async () => {
    server(me(['SUPPORT_STAFF'], ME), {
      [`GET /api/dossiers/${DOSSIER_ID}`]: dossier({ state: 'CLOSED', processingState: 'FINALISED' }),
      [`GET /api/dossiers/${DOSSIER_ID}/route`]: null,
    });
    open();
    expect(await screen.findByText(/Het dossier is gesloten/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dossier heropenen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Route starten|Indienen|Afronden/ })).not.toBeInTheDocument();
  });

  it('offers Finalise on an approved matter to a decision-maker, never to support staff', async () => {
    server(me(['SUPPORT_STAFF'], ME), { [`GET /api/dossiers/${DOSSIER_ID}`]: dossier({ processingState: 'APPROVED' }), [`GET /api/dossiers/${DOSSIER_ID}/route`]: null });
    open();
    expect(await screen.findByText(/Goedgekeurd. Afronden legt de beslissing vast/)).toBeInTheDocument();
    expect(screen.queryByTestId('finalise')).not.toBeInTheDocument();
  });

  it('asks for confirmation before approving, and sends the matter’s version with the decision', async () => {
    const s = server(me(['MINISTER'], ME), {
      [`GET /api/dossiers/${DOSSIER_ID}`]: dossier({ processingState: 'UNDER_REVIEW', version: 7 }),
      [`GET /api/dossiers/${DOSSIER_ID}/route`]: null,
      'GET /api/dossiers/review-queue': [{ dossierId: DOSSIER_ID }],
    });
    open();
    await userEvent.click(await screen.findByTestId('approve'));
    const dialog = await screen.findByRole('dialog');
    expect(s.posted(`/api/dossiers/${DOSSIER_ID}`)).toHaveLength(0);
    await userEvent.click(within(dialog).getAllByRole('button').slice(-1)[0]);
    await waitFor(() => expect(s.posted(`/api/dossiers/${DOSSIER_ID}/approve`)).toHaveLength(1));
    expect(s.posted(`/api/dossiers/${DOSSIER_ID}/approve`)[0].body).toMatchObject({ version: 7 });
  });
});
