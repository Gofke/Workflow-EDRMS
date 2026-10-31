import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { me, renderPage, server } from '../test/harness';
import { ChatPanel } from './ChatPanel';

const PEOPLE = [{ accountId: 'doekhie', personName: 'M. Doekhie', email: 'doekhie@juspol.test', jobPosition: null, unitId: 'ji', unit: 'Justitiële Inrichtingen', isEnabled: true, roles: ['SUPPORT_STAFF'], absentUntil: null }];

const GEMINI = {
  data: {
    enabled: true,
    provider: 'gemini',
    model: 'gemini-flash-latest',
    offline: false,
    external: true,
    tier: 'free',
    dataPolicy: 'metadata',
    hourlyLimit: 30,
    usedThisHour: 4,
    limits: { question: 2000, historyTurns: 30 },
    examples: ['Hoeveel open zaken heeft elke afdeling in mijn directoraat?', 'Wie werkt er bij Juridische Zaken?'],
  },
};

const answer = (data: Record<string, unknown>) => ({
  success: true,
  message: 'ok',
  data: { toolsUsed: [], cards: [], suggestions: [], conversationId: 'c1', messageId: `m-${Math.random()}`, engine: { provider: 'gemini', model: 'gemini-flash-latest', offline: false }, notice: null, pending: null, ...data },
});

const input = () => screen.getByLabelText('Vraag aan de assistent');

describe('Assistant panel (V0.4.0, GPT-style)', () => {
  it('shows the model, the free-tier privacy note and the examples for the role', async () => {
    server(me(['DIRECTEUR']), { 'GET /api/v1/ai/status': GEMINI });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    expect(await screen.findByText('gemini-flash-latest')).toBeInTheDocument();
    expect(screen.getByText(/nog 26 van 30 vragen dit uur/)).toBeInTheDocument();
    expect(screen.getByText(/Gratis Gemini: naar Google gaan alleen kenmerken/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wie werkt er bij Juridische Zaken?' })).toBeInTheDocument();
  });

  it('renders the answer as safe Markdown: formatting yes, HTML and unsafe links no', async () => {
    server(me(['DIRECTEUR']), {
      'GET /api/v1/ai/status': GEMINI,
      'POST /api/v1/ai/query': answer({
        answer: 'Er zijn **3** open zaken.\n\n- JZ: 2\n- VZ: 1\n\n<img src=x onerror="alert(1)"> [klik](javascript:alert(1)) [Zaken](/zaken)',
        toolsUsed: ['count_records'],
      }),
    });
    const { container } = renderPage(<ChatPanel onClose={vi.fn()} />);
    await userEvent.type(input(), 'Hoeveel open zaken?{enter}');
    const strong = await screen.findByText('3');
    expect(strong.tagName).toBe('STRONG');
    expect(screen.getByText('JZ: 2').tagName).toBe('LI');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'klik' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Zaken' })).toHaveAttribute('href', '/zaken');
    expect(screen.getByText(/Gemini, gebruikt: telling/)).toBeInTheDocument();
  });

  it('sends the conversation as history (the person and the model only), and the open page', async () => {
    let n = 0;
    const s = server(me(['DIRECTEUR']), {
      'GET /api/v1/ai/status': GEMINI,
      'POST /api/v1/ai/query': () => {
        n += 1;
        return n === 1
          ? answer({ answer: 'Hoe kan ik helpen?', engine: { provider: 'builtin', model: 'builtin', offline: true } })
          : n === 2
            ? answer({ answer: 'Twee zaken.' })
            : answer({ answer: 'Klaar.' });
      },
    });
    renderPage(<ChatPanel onClose={vi.fn()} />, { path: '/zaken', route: '/zaken' });
    await userEvent.type(input(), 'hallo{enter}');
    await screen.findByText('Hoe kan ik helpen?');
    await userEvent.type(input(), 'hoeveel zaken{enter}');
    await screen.findByText('Twee zaken.');
    await userEvent.type(input(), 'en taken{enter}');
    await screen.findByText('Klaar.');
    const posts = s.posted('/api/v1/ai/query');
    expect(posts[0].body).toMatchObject({ question: 'hallo', history: [], lang: 'nl', page: '/zaken' });
    // The built-in (offline) answer is not passed on to the model; the model's own answer is.
    expect((posts[2].body as { history: unknown }).history).toEqual([
      { role: 'user', content: 'hallo' },
      { role: 'user', content: 'hoeveel zaken' },
      { role: 'assistant', content: 'Twee zaken.' },
    ]);
    expect((posts[2].body as { conversationId: string }).conversationId).toBe('c1');
    expect(JSON.stringify(posts)).not.toContain('"system"');
  });

  it('shows the server’s reason when the hourly limit is reached', async () => {
    server(me(['SUPPORT_STAFF']), {
      'GET /api/v1/ai/status': GEMINI,
      'POST /api/v1/ai/query': { __status: 429, message: 'U hebt het maximum aantal vragen per uur bereikt. Probeer het later opnieuw.' },
    });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    await userEvent.type(input(), 'nog een vraag{enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('maximum aantal vragen per uur');
  });

  it('says it is the built-in assistant when no language model is configured, with a notice when it took over', async () => {
    server(me(['SUPPORT_STAFF']), {
      'GET /api/v1/ai/status': { data: { ...GEMINI.data, provider: 'builtin', model: 'juspol-assistent', offline: true, external: false } },
      'POST /api/v1/ai/query': answer({ answer: 'U hebt 2 open taken.', engine: { provider: 'builtin', model: 'juspol', offline: true }, notice: 'Het taalmodel is nu niet bereikbaar. De ingebouwde assistent heeft geantwoord.' }),
    });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    expect(await screen.findByText(/Ingebouwde assistent, offline/)).toBeInTheDocument();
    expect(screen.queryByText(/Gratis Gemini/)).toBeNull();
    await userEvent.type(input(), 'mijn werk{enter}');
    expect(await screen.findByText(/niet bereikbaar. De ingebouwde assistent heeft geantwoord/)).toBeInTheDocument();
  });

  it('is closed for input when the administrator switched it off', async () => {
    server(me(['SUPPORT_STAFF']), { 'GET /api/v1/ai/status': { data: { ...GEMINI.data, enabled: false } } });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    expect(await screen.findByText('Uitgezet door de beheerder')).toBeInTheDocument();
    expect(input()).toBeDisabled();
  });

  it('prepares a task but creates nothing until the person chooses “Taak aanmaken”', async () => {
    const s = server(me(['DIRECTEUR']), {
      'GET /api/v1/ai/status': GEMINI,
      'GET /api/org/people': PEOPLE,
      'POST /api/v1/ai/query': answer({
        answer: 'Ik heb een taak voor u klaargezet. Controleer hem en kies Taak aanmaken.',
        engine: { provider: 'builtin', model: 'juspol', offline: true },
        pending: { kind: 'TASKS', interactionId: 'ai-task-1' },
        cards: [{ kind: 'TASK_PROPOSAL', title: 'Voorgestelde taak', task: { title: 'Bezoekregeling Santo Boma nagaan', assigneeAccountId: 'doekhie', assigneeName: 'M. Doekhie', dueDate: '2026-11-04', priority: 'MEDIUM', dossierId: null, dossierIdentity: null } }],
      }),
      'POST /api/ai/interactions/ai-task-1/feedback': { applied: { tasks: [{ id: 't9', reference: 'TAAK-2026-0031' }] } },
    });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    await userEvent.type(input(), 'Maak een taak voor Doekhie: bezoekregeling Santo Boma nagaan voor woensdag{enter}');
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
      'GET /api/v1/ai/status': GEMINI,
      'GET /api/org/people': PEOPLE,
      'POST /api/v1/ai/query': answer({
        answer: 'Voorstel:',
        engine: { provider: 'builtin', model: 'juspol', offline: true },
        pending: { kind: 'TASKS', interactionId: 'ai-task-2' },
        cards: [{ kind: 'TASK_PROPOSAL', title: 'Voorgestelde taak', task: { title: 'X nagaan', assigneeAccountId: 'doekhie', assigneeName: 'M. Doekhie', dueDate: null, priority: 'MEDIUM', dossierId: null, dossierIdentity: null } }],
      }),
      'POST /api/ai/interactions/ai-task-2/feedback': { applied: {} },
    });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    await userEvent.type(input(), 'taak{enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Niet nodig' }));
    await waitFor(() => expect(s.posted('/api/ai/interactions/ai-task-2/feedback')[0].body).toEqual({ outcome: 'REJECTED' }));
    expect(await screen.findByText('Voorstel afgewezen. Er is niets aangemaakt.')).toBeInTheDocument();
  });

  it('shows the summary itself in the card when the model answered, and the note about confidential records', async () => {
    server(me(['DIRECTEUR']), {
      'GET /api/v1/ai/status': GEMINI,
      'POST /api/v1/ai/query': answer({
        answer: 'Zie de kaart hieronder.',
        toolsUsed: ['summarise_record'],
        cards: [
          { kind: 'SUMMARY', title: 'Gratieverzoek J. Pinas', bullets: ['Verzoek ingediend door de advocaat', 'Advies van JZ gevraagd'], keySentences: [], link: '/zaken/d9' },
          { kind: 'NOTE', title: 'Alleen voor u', body: '1 vertrouwelijke zaak die u mag zien, staat niet in het antwoord hierboven.' },
        ],
      }),
    });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    await userEvent.type(input(), 'Vat DOS-2026-0009 samen{enter}');
    expect(await screen.findByText('Gratieverzoek J. Pinas')).toBeInTheDocument();
    expect(screen.getByText('Advies van JZ gevraagd')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('1 vertrouwelijke zaak');
  });

  it('shows record cards built by the server, with links to the record', async () => {
    server(me(['DIRECTEUR']), {
      'GET /api/v1/ai/status': GEMINI,
      'POST /api/v1/ai/query': answer({
        answer: 'Zie de kaart hieronder.',
        toolsUsed: ['list_records'],
        cards: [{ kind: 'LIST', title: 'Zaken: te laat', count: 1, rows: [{ type: 'DOSSIER', id: 'd1', identity: 'DOS-2026-0003', title: 'Wetsvoorstel kinderbescherming', meta: 'in behandeling, 2 werkdagen te laat', date: '2026-10-28', link: '/zaken/d1' }] }],
      }),
    });
    renderPage(<ChatPanel onClose={vi.fn()} />);
    await userEvent.type(input(), 'welke zaken zijn te laat{enter}');
    const card = (await screen.findByText('Zaken: te laat')).closest('.mini-card') as HTMLElement;
    expect(within(card).getByText(/Wetsvoorstel kinderbescherming/)).toBeInTheDocument();
  });
});
