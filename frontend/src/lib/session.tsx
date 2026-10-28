import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';

export interface User {
  accountId: string;
  personName: string;
  email: string;
  jobPosition: string | null;
  organisationalUnit: string | null;
  roles: { code: string; name: string }[];
  mfaSetupRequired?: boolean;
}

export interface Branding {
  organisationName: string;
  productName: string;
  tagline: string;
  primaryColor: string;
  accentColor: string;
  logoDataUrl: string | null;
  letterheadLines: string[];
  signatoryTitle: string;
}

export interface PublicSettings {
  branding: Branding;
  language: { default: 'nl' | 'en' };
  training: { enabled: boolean; banner: string };
  publicTracking: { enabled: boolean };
}

export interface ClientSettings {
  ai: { provider: string; model: string; features: Record<string, boolean> };
  tasks: { requireChecklistForCompletion: boolean; requireSubtasksForCompletion: boolean };
  workflow: { blockSubmitWithOpenAdvice: boolean };
  notifications: { pushEnabled: boolean; smsEnabled: boolean };
  classification: { defaultLevel: string };
}

export const BUSINESS = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER', 'RECORDS_MANAGER'];
export const DECISION = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'];
export const ASSIGNERS = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'];

interface Session {
  status: 'loading' | 'out' | 'in';
  user: User | null;
  pub: PublicSettings | null;
  client: ClientSettings | null;
  authority: { action: string; viaDelegationFrom: string | null }[];
  has: (...roles: string[]) => boolean;
  business: boolean;
  decision: boolean;
  manager: boolean;
  ai: (feature: string) => boolean;
  signIn: (email: string, password: string) => Promise<{ mfaRequired?: boolean }>;
  verifyMfa: (code: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Session['status']>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [pub, setPub] = useState<PublicSettings | null>(null);
  const [client, setClient] = useState<ClientSettings | null>(null);
  const [authority, setAuthority] = useState<Session['authority']>([]);

  const loadSignedIn = useCallback(async (me: User) => {
    setUser(me);
    const roles = me.roles.map((r) => r.code);
    const [c, a] = await Promise.all([
      api.get<ClientSettings>('/api/settings/client').catch(() => null),
      roles.some((r) => BUSINESS.includes(r)) ? api.get<Session['authority']>('/api/delegations/my-authority').catch(() => []) : Promise.resolve([]),
    ]);
    setClient(c);
    setAuthority(a);
    setStatus('in');
  }, []);

  const refresh = useCallback(async () => {
    const p = await api.get<PublicSettings>('/api/settings/public').catch(() => null);
    setPub(p);
    try {
      const me = await api.get<User>('/api/auth/me');
      await loadSignedIn(me);
    } catch {
      setUser(null);
      setStatus('out');
    }
  }, [loadSignedIn]);

  useEffect(() => {
    void refresh();
    const out = () => {
      setUser(null);
      setStatus('out');
    };
    window.addEventListener('juspol:signed-out', out);
    return () => window.removeEventListener('juspol:signed-out', out);
  }, [refresh]);

  // The ministry's colour, set by the administrator, carries through the light theme.
  useEffect(() => {
    const c = pub?.branding.primaryColor;
    if (c && /^#[0-9a-f]{6}$/i.test(c)) {
      document.documentElement.style.setProperty('--brand-custom', c);
    }
  }, [pub]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const r = await api.post<User & { mfaRequired?: boolean }>('/api/auth/login', { email, password });
      if (r.mfaRequired) return { mfaRequired: true };
      await loadSignedIn(r);
      return {};
    },
    [loadSignedIn],
  );

  const verifyMfa = useCallback(
    async (code: string) => {
      const me = await api.post<User>('/api/auth/mfa', { code });
      await loadSignedIn(me);
    },
    [loadSignedIn],
  );

  const signOut = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setUser(null);
    setStatus('out');
  }, []);

  const value = useMemo<Session>(() => {
    const roles = user?.roles.map((r) => r.code) ?? [];
    const has = (...wanted: string[]) => roles.some((r) => wanted.includes(r));
    return {
      status,
      user,
      pub,
      client,
      authority,
      has,
      business: has(...BUSINESS),
      decision: has(...DECISION),
      manager: has('MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'),
      ai: (feature: string) => Boolean(client?.ai.features[feature]),
      signIn,
      verifyMfa,
      signOut,
      refresh,
    };
  }, [status, user, pub, client, authority, signIn, verifyMfa, signOut, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const v = useContext(SessionContext);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}
