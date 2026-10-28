/**
 * The API client. Every call carries the session cookie; every failure becomes
 * an ApiError with the server's own message, which the screens show as is.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function handle<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json().catch(() => null) : await response.text().catch(() => null);
  if (!response.ok) {
    const raw = body && typeof body === 'object' ? (body as { message?: unknown }).message : null;
    const message = Array.isArray(raw) ? String(raw[0]) : typeof raw === 'string' ? raw : `The server answered ${response.status}.`;
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('juspol:signed-out'));
  return handle<T>(response);
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => call<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown = {}) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),

  async upload<T>(path: string, field: string, file: File | Blob, filename?: string): Promise<T> {
    const form = new FormData();
    form.append(field, file, filename ?? (file as File).name ?? 'bestand');
    const response = await fetch(path, { method: 'POST', credentials: 'include', body: form });
    return handle<T>(response);
  },

  /** Fetches a file and hands it to the browser as a download. */
  async download(path: string, fallbackName: string, init?: { method?: string; body?: unknown }): Promise<void> {
    const response = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers: init?.body ? { 'Content-Type': 'application/json' } : {},
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) await handle(response);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  async blob(path: string): Promise<Blob> {
    const response = await fetch(path, { credentials: 'include' });
    if (!response.ok) await handle(response);
    return response.blob();
  },
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
