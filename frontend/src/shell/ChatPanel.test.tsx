import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { me, renderPage, server } from '../test/harness';
import { ChatPanel } from './ChatPanel';

const PEOPLE = [{ accountId: 'doekhie', personName: 'M. Doekhie', email: 'doekhie@juspol.test', jobPosition: null, unitId: 'ji', unit: 'Justitiële Inrichtingen', isEnabled: true, roles: ['SUPPORT_STAFF'], absentUntil: null }];

/** The chat assistant proposes; nothing happens in the system until the person confirms in the card. */
describe('Chat assistant', () => {
  it('prepares a task but creates nothing until the person chooses “Taak aanmaken”', async () => {
    const s = server(me(['DIRECTEUR']), {
      'GET /api/org/people': PEOPLE,
      'POST /api/ai/chat': {
        conversationId: 'c1',
        message: {
          id: 'm1',
          role: 'assistant',
          content: 'Ik heb een taak voor u klaargezet. Controleer hem en kies Taak aanmaken.',
          interactionId: 'ai-task-1',
          cards: [{ kind: 'TASK_PROPOSAL', title: 'Voorgestelde taak', task: { title: 'Bezoekregeling Santo Boma nagaan', assigneeAccountId: 'doekhie', assigneeName: 'M. Doekhie', dueDate: '2026-11-04', priority: 'MEDIUM', dossierId: null, dossierIdentity: null } }],
        },
      },
      'POST /api/ai/interactions/ai-task-1/feedback': { applied: { tasks: [{ id: 't9', reference: 'TAAK-2026-0031' }] } },
    });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Bericht aan de assistent'), 'Maak een taak voor Doekhie: bezoekregeling Santo Boma nagaan voor woensdag{enter}');
    expect(await screen.findByText(/Ik heb een taak voor u klaargezet/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bezoekregeling Santo Boma nagaan')).toBeInTheDocument();
    expect(s.posted('/api/ai/interactions')).toHaveLength(0);
    expect(s.posted('/api/tasks')).toHaveLength(0);
    await screen.findByRole('option', { name: /M. Doekhie/ });
    await userEvent.click(screen.getByRole('button', { name: 'Taak aanmaken' }));
    await waitFor(() => expect(s.posted('/api/ai/interactions/ai-task-1/feedback')).toHaveLength(1));
    expect(s.posted('/api/ai/interactions/ai-task-1/feedback')[0].body).toMatchObject({ outcome: 'ACCEPTED', apply: { tasks: [{ title: 'Bezoekregeling Santo Boma nagaan', assigneeAccountId: 'doekhie', dueDate: '2026-11-04' }] } });
    expect(await screen.findByText('TAAK-2026-0031')).toBeInTheDocument();
  });

  it('records a declined proposal and creates nothing', async () => {
    const s = server(me(['DIRECTEUR']), {
      'GET /api/org/people': PEOPLE,
      'POST /api/ai/chat': { conversationId: 'c2', message: { id: 'm2', role: 'assistant', content: 'Voorstel:', interactionId: 'ai-task-2', cards: [{ kind: 'TASK_PROPOSAL', title: 'Voorgestelde taak', task: { title: 'X nagaan', assigneeAccountId: 'doekhie', assigneeName: 'M. Doekhie', dueDate: null, priority: 'MEDIUM', dossierId: null, dossierIdentity: null } }] } },
      'POST /api/ai/interactions/ai-task-2/feedback': { applied: {} },
    });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Bericht aan de assistent'), 'taak{enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Niet nodig' }));
    await waitFor(() => expect(s.posted('/api/ai/interactions/ai-task-2/feedback')[0].body).toEqual({ outcome: 'REJECTED' }));
    expect(await screen.findByText('Voorstel afgewezen. Er is niets aangemaakt.')).toBeInTheDocument();
  });
});
