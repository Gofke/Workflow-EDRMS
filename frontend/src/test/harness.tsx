import { render } from '@testing-library/react';
import { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { PrefsProvider } from '../lib/prefs';
import { SessionProvider } from '../lib/session';
import { AssistantProvider } from '../shell/context';
import { ToastProvider } from '../ui';
import { forgetPeople } from '../ui/people';

/**
 * A fake server behind window.fetch. The screens run with the real API client,
 * the real hooks and the real session; only the network answers from here. The
 * question these tests answer is "given this state, does the screen offer the
 * right controls to the right person, and does it send what the person chose" —
 * what the server itself permits is covered by the backend integration suite.
 */
export type Handler = (body: unknown, url: URL) => unknown | Promise<unknown>;
export interface Call { method: string; path: string; body: unknown }

export const ROLE_NAMES: Record<string, string> = {
  MINISTER: 'Minister',
  DIRECTEUR: 'Directeur',
  ONDER_DIRECTEUR: 'Onder-Directeur',
  SUPPORT_STAFF: 'Assistant / support staff',
  SYS_ADMIN: 'Pilot System Administrator',
  AUDITOR: 'Auditor',
  RECORDS_MANAGER: 'Records manager',
};

export function me(roles: string[], accountId = 'me-0000-0000-0000-000000000001', personName = 'T. Tester') {
  return { accountId, personName, email: 'tester@juspol.test', jobPosition: null, organisationalUnit: 'Directoraat Justitie', roles: roles.map((code) => ({ code, name: ROLE_NAMES[code] ?? code })) };
}

export const CLIENT = {
  ai: { provider: 'builtin', model: 'juspol-assistent 1.0 (ingebouwd)', features: { chat: true, intake: true, summary: true, draftReply: true, deadlines: true, duplicates: true, routing: true, risk: true, translate: true, meetingNotes: true, ask: true } },
  tasks: { requireChecklistForCompletion: true, requireSubtasksForCompletion: true },
  workflow: { blockSubmitWithOpenAdvice: false },
  notifications: { pushEnabled: true, smsEnabled: false },
  classification: { defaultLevel: 'INTERNAL' },
};

const PUBLIC = {
  branding: { organisationName: 'Ministerie van Justitie en Politie', productName: 'JusPol EDRMS', tagline: '', primaryColor: '#15325b', accentColor: '#c9a227', logoDataUrl: null, letterheadLines: [], signatoryTitle: '' },
  language: { default: 'nl' },
  training: { enabled: false, banner: '' },
  publicTracking: { enabled: true },
};

export function server(user: ReturnType<typeof me> | null, routes: Record<string, unknown | Handler>) {
  const calls: Call[] = [];
  forgetPeople();
  const table: Record<string, unknown | Handler> = {
    'GET /api/settings/public': PUBLIC,
    'GET /api/settings/client': CLIENT,
    'GET /api/delegations/my-authority': [],
    'GET /api/my-work': { counts: {} },
    'GET /api/notifications': { items: [], unread: 0 },
    'GET /api/org/people': [],
    'GET /api/tasks': { data: [], total: 0 },
    ...routes,
  };
  if (user) table['GET /api/auth/me'] = user;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? null);
    calls.push({ method, path: url.pathname + url.search, body });
    const keyFull = `${method} ${url.pathname}${url.search}`;
    const keyPath = `${method} ${url.pathname}`;
    const hit = keyFull in table ? table[keyFull] : keyPath in table ? table[keyPath] : undefined;
    if (hit === undefined) {
      if (url.pathname === '/api/auth/me') return new Response(JSON.stringify({ message: 'Not signed in.' }), { status: 401, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(method === 'GET' ? [] : {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const value = typeof hit === 'function' ? await (hit as Handler)(body, url) : hit;
    if (value && typeof value === 'object' && '__status' in (value as object)) {
      const v = value as { __status: number; message: string };
      return new Response(JSON.stringify({ message: v.message }), { status: v.__status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(value ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, posted: (path: string) => calls.filter((c) => c.method !== 'GET' && c.path.startsWith(path)) };
}

export function fail(status: number, message: string) {
  return { __status: status, message };
}

/** Renders a page inside the real providers, at a route, in Dutch unless asked. */
export function renderPage(element: ReactElement, { path = '/', route = '/', language = 'nl' }: { path?: string; route?: string; language?: 'nl' | 'en' } = {}) {
  localStorage.setItem('juspol.lang', language);
  localStorage.setItem('juspol.tour.done', '1');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PrefsProvider>
        <SessionProvider>
          <ToastProvider>
            <AssistantProvider>
              <Routes>
                <Route path={route} element={element} />
              </Routes>
            </AssistantProvider>
          </ToastProvider>
        </SessionProvider>
      </PrefsProvider>
    </MemoryRouter>,
  );
}
