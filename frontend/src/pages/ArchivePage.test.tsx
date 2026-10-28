import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, renderPage, server } from '../test/harness';
import ArchivePage from './ArchivePage';

const ROW = { id: 'd1', dossierIdentity: 'DOS-2026-0001', subject: 'Uitnodiging opening politiepost Lelydorp', legalHold: false, retentionState: 'ACTIVE', categoryCode: 'KAB', categoryName: 'Uitnodigingen en representatie', retentionYears: 0, retentionAction: 'DESTROY', closedOn: '2026-01-10', retentionEndsOn: '2026-01-10' };

/** Retention decisions: only the records manager decides, always with a reason, never over a legal hold. */
describe('Retention decisions', () => {
  it('needs a reason before a destruction is recorded, and sends the decision with it', async () => {
    const s = server(me(['RECORDS_MANAGER']), { 'GET /api/casefiles/retention': [ROW], 'POST /api/dossiers/d1/retention': {} });
    renderPage(<ArchivePage />, { path: '/archief', route: '/archief' });
    await userEvent.click(await screen.findByRole('button', { name: 'Besluiten' }));
    const dialog = await screen.findByRole('dialog');
    const record = within(dialog).getByRole('button', { name: 'Besluit vastleggen' });
    expect(within(dialog).getByRole('radio', { name: /Vernietigen/ })).toBeChecked();
    expect(record).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reden/), 'Uitnodiging afgehandeld; geen blijvende waarde.');
    await userEvent.click(record);
    await waitFor(() => expect(s.posted('/api/dossiers/d1/retention')).toHaveLength(1));
    expect(s.posted('/api/dossiers/d1/retention')[0].body).toEqual({ decision: 'DESTROY', reason: 'Uitnodiging afgehandeld; geen blijvende waarde.' });
  });

  it('refuses destruction and transfer while a legal hold is on, but allows keeping it', async () => {
    server(me(['RECORDS_MANAGER']), { 'GET /api/casefiles/retention': [{ ...ROW, legalHold: true }] });
    renderPage(<ArchivePage />, { path: '/archief', route: '/archief' });
    await userEvent.click(await screen.findByRole('button', { name: 'Besluiten' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Reden/), 'Rechtszaak loopt');
    expect(within(dialog).getByText(/valt onder juridische bewaarplicht/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Besluit vastleggen' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Blijvend bewaren/ }));
    expect(within(dialog).getByRole('button', { name: 'Besluit vastleggen' })).toBeEnabled();
  });

  it('shows the list to the Minister without a decision button', async () => {
    server(me(['MINISTER']), { 'GET /api/casefiles/retention': [ROW] });
    renderPage(<ArchivePage />, { path: '/archief', route: '/archief' });
    expect(await screen.findByText('Uitnodiging opening politiepost Lelydorp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Besluiten' })).not.toBeInTheDocument();
  });
});
