import {
  Archive,
  BarChart3,
  Bell,
  BookOpen,
  CheckSquare,
  ClipboardCheck,
  Compass,
  Contrast,
  FolderKanban,
  FolderOpen,
  Gauge,
  HelpCircle,
  Home,
  Inbox,
  Languages,
  LogOut,
  Menu,
  Moon,
  Repeat,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Type,
  User,
  Users,
} from 'lucide-react';
import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { ROLE } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Avatar, Mark, useOutside } from '../ui';
import { ChatPanel } from './ChatPanel';
import { useAssistant } from './context';
import { Tour } from './Tour';

interface Counts {
  openTasks: number;
  awaitingMyDecision: number;
  adviceToGive: number;
  draftsToRegister: number;
  unreadNotifications: number;
  projectDecisions?: number;
}

export function Layout({ children }: { children: ReactNode }) {
  const { t, language } = usePrefs();
  const session = useSession();
  const { user, has, business, manager, pub, authority } = session;
  const assistant = useAssistant();
  const location = useLocation();
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [tour, setTour] = useState(false);

  const loadCounts = useCallback(async () => {
    if (!business) {
      const n = await api.get<{ unread: number }>('/api/notifications').catch(() => null);
      setCounts(n ? { openTasks: 0, awaitingMyDecision: 0, adviceToGive: 0, draftsToRegister: 0, unreadNotifications: n.unread } : null);
      return;
    }
    const w = await api.get<{ summary: Counts }>('/api/my-work').catch(() => null);
    if (w) setCounts(w.summary);
  }, [business]);

  useEffect(() => {
    void loadCounts();
    setRailOpen(false);
  }, [location.pathname, loadCounts]);
  useEffect(() => {
    const timer = setInterval(() => void loadCounts(), 60_000);
    const onChange = () => void loadCounts();
    window.addEventListener('juspol:changed', onChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener('juspol:changed', onChange);
    };
  }, [loadCounts]);
  useEffect(() => {
    try {
      if (business && !localStorage.getItem('juspol.tour.done')) setTour(true);
    } catch {
      /* no storage: no automatic tour */
    }
  }, [business]);
  useEffect(() => {
    const start = () => setTour(true);
    window.addEventListener('juspol:tour', start);
    return () => window.removeEventListener('juspol:tour', start);
  }, []);

  const delegated = authority.filter((a) => a.viaDelegationFrom);
  const reviews = (counts?.awaitingMyDecision ?? 0) + (counts?.adviceToGive ?? 0);
  const roleNames = (user?.roles ?? []).map((r) => (ROLE[r.code] ? ROLE[r.code][language === 'en' ? 1 : 0] : r.name));

  const nav: { group?: string; to: string; icon: ReactNode; label: string; count?: number; show: boolean; tour?: string }[] = [
    { to: '/', icon: <Home size={19} />, label: t('Mijn werk', 'My work'), show: business, tour: 'mywork' },
    { to: '/post', icon: <Inbox size={19} />, label: t('Post', 'Mail'), count: counts?.draftsToRegister, show: business, tour: 'post' },
    { to: '/zaken', icon: <FolderOpen size={19} />, label: t('Zaken', 'Matters'), show: business },
    { to: '/taken', icon: <CheckSquare size={19} />, label: t('Taken', 'Tasks'), count: counts?.openTasks, show: business },
    { to: '/projecten', icon: <FolderKanban size={19} />, label: t('Projecten', 'Projects'), count: counts?.projectDecisions, show: business, tour: 'projects' },
    { to: '/goedkeuringen', icon: <ClipboardCheck size={19} />, label: t('Beoordelen', 'Review'), count: reviews, show: business },
    { to: '/zoeken', icon: <Search size={19} />, label: t('Zoeken', 'Search'), show: business },
    { group: t('Leiding', 'Management'), to: '/overzicht', icon: <Gauge size={19} />, label: t('Bestuurlijk overzicht', 'Management overview'), show: manager, tour: 'overview' },
    { to: '/rapporten', icon: <BarChart3 size={19} />, label: t('Rapporten', 'Reports'), show: manager },
    { group: t('Assistent', 'Assistant'), to: '/assistent', icon: <Sparkles size={19} />, label: t('Assistent', 'Assistant'), show: business, tour: 'assistant' },
    { group: t('Archief en toezicht', 'Records and oversight'), to: '/archief', icon: <Archive size={19} />, label: t('Archief', 'Archive'), show: has('RECORDS_MANAGER', 'MINISTER', 'DIRECTEUR', 'AUDITOR') },
    { to: '/logboek', icon: <ShieldCheck size={19} />, label: t('Logboek en integriteit', 'Audit and integrity'), show: has('AUDITOR', 'MINISTER', 'SYS_ADMIN') },
    { to: '/uitwisseling', icon: <Repeat size={19} />, label: t('Uitwisseling', 'Exchange'), show: business || has('SYS_ADMIN') },
    { group: t('Organisatie', 'Organisation'), to: '/delegaties', icon: <Users size={19} />, label: t('Delegaties', 'Delegations'), show: business },
    { to: '/beheer', icon: <Settings size={19} />, label: t('Beheer', 'Administration'), show: has('SYS_ADMIN') },
    { to: '/help', icon: <HelpCircle size={19} />, label: t('Help', 'Help'), show: true },
  ];

  const branding = pub?.branding;
  return (
    <>
      <a className="skip-link" href="#content">
        {t('Naar de inhoud', 'Skip to content')}
      </a>
      <div className="shell">
        <aside className={`rail${railOpen ? ' open' : ''}`} aria-label={t('Hoofdmenu', 'Main menu')}>
          <Link to="/" className="rail-brand">
            <Mark />
            <span>
              <span className="rail-brand-name">{branding?.productName ?? 'JusPol'}</span>
              <br />
              <span className="rail-brand-org">{branding?.organisationName ?? ''}</span>
            </span>
          </Link>
          <nav>
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <div key={n.to} style={{ display: 'contents' }}>
                  {n.group && <div className="rail-group">{n.group}</div>}
                  <NavLink to={n.to} end={n.to === '/'} data-tour={n.tour}>
                    {n.icon}
                    <span>{n.label}</span>
                    {n.count ? <span className="count">{n.count}</span> : null}
                  </NavLink>
                </div>
              ))}
          </nav>
          <div className="rail-foot">
            {t('Versie', 'Version')} 0.5.0
            <br />
            {branding?.tagline}
          </div>
        </aside>
        {railOpen && <div className="overlay" style={{ zIndex: 65, padding: 0 }} onClick={() => setRailOpen(false)} />}
        <div className="main">
          {pub?.training.enabled && (
            <div className="banner training" role="note">
              <BookOpen size={16} aria-hidden="true" />
              {pub.training.banner}
            </div>
          )}
          <header className="topbar">
            <button type="button" className="icon-btn mobile-only" onClick={() => setRailOpen(true)} aria-label={t('Menu openen', 'Open menu')}>
              <Menu size={22} />
            </button>
            {business && <GlobalSearch />}
            <div className="spacer" />
            {(session.ai('assistant') || (business && session.ai('chat'))) && (
              <button type="button" className="ask-btn" onClick={() => assistant.setOpen(!assistant.open)} aria-expanded={assistant.open} aria-label={t('Vraag de assistent', 'Ask the assistant')} data-tour="chat">
                <Sparkles size={18} aria-hidden="true" />
                <span className="label">{t('Vraag de assistent', 'Ask the assistant')}</span>
              </button>
            )}
            <Notifications unread={counts?.unreadNotifications ?? 0} onChange={loadCounts} />
            <UserMenu roleNames={roleNames} onTour={() => setTour(true)} />
          </header>
          {delegated.length > 0 && (
            <div className="banner acting" role="note">
              <Users size={16} aria-hidden="true" />
              {t(
                `U hebt gedelegeerde bevoegdheid van ${[...new Set(delegated.map((d) => d.viaDelegationFrom))].join(', ')}. Wat u daarmee doet, wordt met beide namen vastgelegd.`,
                `You hold delegated authority from ${[...new Set(delegated.map((d) => d.viaDelegationFrom))].join(', ')}. What you do with it is recorded with both names.`,
              )}
            </div>
          )}
          <main id="content" className="content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      {business && (
        <nav className="bottom-nav" aria-label={t('Snelmenu', 'Quick menu')}>
          <NavLink to="/" end>
            <Home size={20} />
            {t('Werk', 'Work')}
          </NavLink>
          <NavLink to="/post">
            <Inbox size={20} />
            {t('Post', 'Mail')}
          </NavLink>
          <NavLink to="/taken">
            <CheckSquare size={20} />
            {t('Taken', 'Tasks')}
          </NavLink>
          <NavLink to="/goedkeuringen">
            <ClipboardCheck size={20} />
            {t('Beoordelen', 'Review')}
          </NavLink>
          <button type="button" onClick={() => setRailOpen(true)}>
            <Menu size={20} />
            {t('Meer', 'More')}
          </button>
        </nav>
      )}
      {assistant.open && <ChatPanel onClose={() => assistant.setOpen(false)} />}
      {tour && (
        <Tour
          onDone={() => {
            setTour(false);
            try {
              localStorage.setItem('juspol.tour.done', '1');
            } catch {
              /* ignore */
            }
          }}
          navigate={navigate}
        />
      )}
    </>
  );
}

function GlobalSearch() {
  const { t } = usePrefs();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // "/" jumps to the search box, unless the person is typing somewhere.
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(`/zoeken?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    <form className="topbar-search" role="search" onSubmit={submit} data-tour="search">
      <Search size={18} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('Zoek brieven, zaken, taken en tekst in documenten', 'Search letters, matters, tasks and document text')}
        aria-label={t('Zoeken', 'Search')}
      />
    </form>
  );
}

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

function Notifications({ unread, onChange }: { unread: number; onChange: () => void }) {
  const { t, language } = usePrefs();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (open) api.get<{ items: NotificationItem[] }>('/api/notifications').then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [open]);
  const go = async (n: NotificationItem) => {
    if (!n.readAt) await api.post(`/api/notifications/${n.id}/read`).catch(() => undefined);
    setOpen(false);
    onChange();
    if (n.link) navigate(n.link);
  };
  const readAll = async () => {
    await api.post('/api/notifications/read-all').catch(() => undefined);
    setItems((xs) => xs?.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })) ?? null);
    onChange();
  };
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button type="button" className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t(`Meldingen, ${unread} ongelezen`, `Notifications, ${unread} unread`)}>
        <Bell size={20} />
        {unread > 0 && <span className="dot">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label={t('Meldingen', 'Notifications')}>
          <div className="row between" style={{ padding: '14px 16px 8px' }}>
            <h2 style={{ fontSize: '1.05rem' }}>{t('Meldingen', 'Notifications')}</h2>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn sm ghost" onClick={readAll}>
                {t('Alles gelezen', 'Mark all read')}
              </button>
              <Link className="btn sm ghost" to="/meldingen" onClick={() => setOpen(false)}>
                {t('Alle', 'All')}
              </Link>
            </div>
          </div>
          <ul className="list" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {items === null && <li className="muted">{t('Laden…', 'Loading…')}</li>}
            {items?.length === 0 && <li className="muted">{t('Geen meldingen.', 'No notifications.')}</li>}
            {items?.slice(0, 15).map((n) => (
              <li key={n.id} style={{ background: n.readAt ? undefined : 'var(--info-soft)' }}>
                <button type="button" onClick={() => go(n)} className="list-link" style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', width: '100%' }}>
                  <span className="grow">
                    <span className="list-title">{n.title}</span>
                    <span className="small muted" style={{ display: 'block' }}>
                      {n.body}
                    </span>
                    <span className="xs faint">{ago(n.createdAt, language)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserMenu({ roleNames, onTour }: { roleNames: string[]; onTour: () => void }) {
  const { t, language, setLanguage, theme, setTheme, textSize, setTextSize } = usePrefs();
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  if (!user) return null;
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button type="button" className="user-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <Avatar name={user.personName} />
        <span className="who">
          <strong>{user.personName}</strong>
          <br />
          <span className="role">{roleNames.join(', ')}</span>
        </span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-label">{user.email}</div>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), navigate('/profiel'))}>
            <User size={17} /> {t('Mijn profiel en beveiliging', 'My profile and security')}
          </button>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onTour())}>
            <Compass size={17} /> {t('Rondleiding', 'Guided tour')}
          </button>
          <hr />
          <div className="menu-label">{t('Weergave', 'Display')}</div>
          <button type="button" role="menuitemradio" aria-checked={language === 'nl'} onClick={() => setLanguage(language === 'nl' ? 'en' : 'nl')}>
            <Languages size={17} /> {language === 'nl' ? 'English' : 'Nederlands'}
          </button>
          <button type="button" role="menuitem" onClick={() => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'contrast' : 'light')}>
            {theme === 'light' ? <Moon size={17} /> : theme === 'dark' ? <Contrast size={17} /> : <Sun size={17} />}
            {theme === 'light' ? t('Donker thema', 'Dark theme') : theme === 'dark' ? t('Hoog contrast', 'High contrast') : t('Licht thema', 'Light theme')}
          </button>
          <button type="button" role="menuitem" onClick={() => setTextSize(textSize === 'normal' ? 'large' : textSize === 'large' ? 'larger' : 'normal')}>
            <Type size={17} /> {textSize === 'normal' ? t('Grotere tekst', 'Larger text') : textSize === 'large' ? t('Nog grotere tekst', 'Even larger text') : t('Normale tekst', 'Normal text')}
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={() => void signOut().then(() => navigate('/'))}>
            <LogOut size={17} /> {t('Afmelden', 'Sign out')}
          </button>
        </div>
      )}
    </div>
  );
}
