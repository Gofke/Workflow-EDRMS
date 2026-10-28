import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, renderPage, server } from '../test/harness';
import { ME } from '../test/fixtures';
import AssistantPage from './AssistantPage';

const PEOPLE = [
  { accountId: 'sabajo', personName: 'R. Sabajo', email: 'sabajo@juspol.test', jobPosition: null, unitId: 'ji', unit: 'Justitiële Inrichtingen', isEnabled: true, roles: ['SUPPORT_STAFF'], absentUntil: null },
  { accountId: 'ramdin', personName: 'S. Ramdin', email: 'ramdin@juspol.test', jobPosition: null, unitId: 'fz', unit: 'Financiële Zaken', isEnabled: true, roles: ['SUPPORT_STAFF'], absentUntil: null },
];

const PROPOSALS = {
  interactionId: 'notes-1',
  engine: { provider: 'builtin', model: 'juspol-assistent 1.0 (ingebouwd)', local: true },
  proposals: [
    { line: 3, original: '- Sabajo levert vóór vrijdag de cijfers aan', title: 'Sabajo levert de cijfers aan', assignee: { accountId: 'sabajo', name: 'R. Sabajo' }, assigneeText: 'Sabajo', dueDate: '2026-10-30', priority: 'MEDIUM', confidence: 0.9 },
    { line: 4, original: '- Actie Ramdin: overzicht meerkosten', title: 'Overzicht meerkosten', assignee: { accountId: 'ramdin', name: 'S. Ramdin' }, assigneeText: 'Ramdin', dueDate: null, priority: 'MEDIUM', confidence: 0.85 },
    { line: 6, original: '- Iemand belt de Korpschef', title: 'Iemand belt de Korpschef', assignee: null, assigneeText: null, dueDate: null, priority: 'MEDIUM', confidence: 0.5 },
  ],
  dossierId: null,
};

/** Meeting notes become tasks only as the person sends them: what was unticked or had no one, stays out. */
describe('Notes into tasks', () => {
  it('creates only the ticked action items that have someone to do them, with the person’s edits', async () => {
    const s = server(me(['DIRECTEUR'], ME), {
      'GET /api/org/people': PEOPLE,
      'GET /api/ai/status': { provider: 'builtin', model: 'x', local: true, free: true, features: { meetingNotes: true }, canSeeEverything: true },
      'POST /api/ai/meeting-notes': PROPOSALS,
      'POST /api/ai/interactions/notes-1/feedback': { applied: { tasks: [{ id: 't1' }] } },
    });
    renderPage(<AssistantPage />, { path: '/assistent?tab=notulen', route: '/assistent' });
    await userEvent.type(await screen.findByLabelText(/Plak de notulen/), '- Sabajo levert vóór vrijdag de cijfers aan');
    await userEvent.click(screen.getByRole('button', { name: /Actiepunten herkennen/ }));
    expect(await screen.findByText('3 actiepunten gevonden')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox', { name: 'Dit actiepunt gebruiken' });
    // The line without a person is not ticked; untick Ramdin's too.
    expect(boxes[2]).not.toBeChecked();
    await userEvent.click(boxes[1]);
    const title = screen.getAllByRole('textbox', { name: 'Titel van de taak' })[0];
    await userEvent.clear(title);
    await userEvent.type(title, 'Bezettingscijfers Santo Boma aanleveren');
    await userEvent.click(screen.getByRole('button', { name: /1 taken aanmaken/ }));
    await waitFor(() => expect(s.posted('/api/ai/interactions/notes-1/feedback')).toHaveLength(1));
    const body = s.posted('/api/ai/interactions/notes-1/feedback')[0].body as { outcome: string; apply: { tasks: { title: string; assigneeAccountId: string }[] } };
    expect(body.outcome).toBe('EDITED');
    expect(body.apply.tasks).toEqual([expect.objectContaining({ title: 'Bezettingscijfers Santo Boma aanleveren', assigneeAccountId: 'sabajo', dueDate: '2026-10-30' })]);
  });

  it('does not offer translation as working when only the built-in assistant runs', async () => {
    server(me(['DIRECTEUR'], ME), { 'GET /api/ai/status': { provider: 'builtin', model: 'x', local: true, free: true, features: { translate: true }, canSeeEverything: true } });
    renderPage(<AssistantPage />, { path: '/assistent?tab=vertalen', route: '/assistent' });
    expect(await screen.findByText('Vertalen vraagt een taalmodel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Vertalen$/ })).toBeDisabled();
  });
});
