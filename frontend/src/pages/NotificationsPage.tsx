import { AlarmClock, Bell, CheckCheck, ClipboardCheck, FileInput, FolderKanban, Gavel, MessageSquare, ShieldAlert, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { longDate } from '../lib/format';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { Badge, Empty, Loading, PageHead, Panel, Segmented, usePager } from '../ui';

interface Item { id: string; kind: string; title: string; body: string; link: string | null; createdAt: string; readAt: string | null; forAbsentName: string | null }

function iconFor(kind: string) {
  if (kind.startsWith('DEADLINE')) return AlarmClock;
  if (kind.startsWith('TASK')) return ClipboardCheck;
  if (kind.startsWith('MATTER') || kind === 'REVIEW_REQUESTED') return Gavel;
  if (kind.startsWith('ADVICE')) return MessageSquare;
  if (kind === 'RESPONSIBILITY_ASSIGNED' || kind === 'OUT_OF_OFFICE') return UserCheck;
  if (kind === 'SECURITY_ALERT') return ShieldAlert;
  if (kind === 'INTAKE_RECEIVED') return FileInput;
  if (kind.startsWith('PROJECT') || kind.startsWith('BUSINESS_CASE')) return FolderKanban;
  return Bell;
}

export default function NotificationsPage() {
  const { t, language } = usePrefs();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread'>('unread');
  const { data, reload } = useApi<{ items: Item[]; unread: number }>(`/api/notifications?limit=200${filter === 'unread' ? '&unread=true' : ''}`);
  const changed = () => window.dispatchEvent(new CustomEvent('juspol:changed'));
  const open = async (n: Item) => {
    if (!n.readAt) await api.post(`/api/notifications/${n.id}/read`).catch(() => undefined);
    changed();
    if (n.link) navigate(n.link);
    else void reload();
  };
  const { page: pageItems, pager } = usePager(data?.items ?? [], 50);
  const days = new Map<string, Item[]>();
  for (const n of pageItems) {
    const d = new Date(new Date(n.createdAt).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    days.set(d, [...(days.get(d) ?? []), n]);
  }
  return (
    <>
      <PageHead
        title={t('Meldingen', 'Notifications')}
        lead={t('Alles wat het systeem u liet weten. Welke meldingen u ook per e-mail of telefoon krijgt, kiest u in uw profiel.', 'Everything the system told you. Which notifications you also receive by e-mail or phone, you choose in your profile.')}
        actions={
          <button
            type="button"
            className="btn"
            disabled={!data?.unread}
            onClick={async () => {
              await api.post('/api/notifications/read-all');
              changed();
              void reload();
            }}
          >
            <CheckCheck size={16} /> {t('Alles gelezen', 'Mark all read')}
          </button>
        }
      />
      <div className="row between" style={{ marginBottom: 16 }}>
        <Segmented
          label={t('Welke meldingen', 'Which notifications')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'unread', label: t(`Ongelezen${data ? ` (${data.unread})` : ''}`, `Unread${data ? ` (${data.unread})` : ''}`) },
            { value: 'all', label: t('Alle', 'All') },
          ]}
        />
      </div>
      {!data ? (
        <Loading lines={8} />
      ) : data.items.length === 0 ? (
        <Empty title={filter === 'unread' ? t('Alles gelezen', 'All read') : t('Geen meldingen', 'No notifications')}>{t('Nieuwe meldingen verschijnen hier en bij de bel bovenaan.', 'New notifications appear here and at the bell at the top.')}</Empty>
      ) : (
        <div className="stack" style={{ '--gap': '18px' } as React.CSSProperties}>
          {[...days.entries()].map(([day, items]) => (
            <Panel key={day} title={longDate(day, language)} flush>
              <ul className="list">
                {items.map((n) => {
                  const Icon = iconFor(n.kind);
                  return (
                    <li key={n.id} className={n.readAt ? undefined : 'unread'}>
                      <button type="button" className="list-link" onClick={() => void open(n)}>
                        <Icon size={18} style={{ marginTop: 3, flex: 'none', color: n.kind.includes('ESCALATION') || n.kind === 'DEADLINE_OVERDUE' || n.kind === 'SECURITY_ALERT' ? 'var(--danger)' : 'var(--muted)' }} aria-hidden="true" />
                        <span className="grow stack" style={{ gap: 2, textAlign: 'left' }}>
                          <span className="list-title">{n.title}</span>
                          <span className="small muted">{n.body}</span>
                          {n.forAbsentName && (
                            <span>
                              <Badge tone="info">{t(`voor ${n.forAbsentName}, u vervangt`, `for ${n.forAbsentName}, you are standing in`)}</Badge>
                            </span>
                          )}
                        </span>
                        <span className="xs muted nowrap">{new Date(n.createdAt).toLocaleTimeString(language === 'en' ? 'en-GB' : 'nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Paramaribo' })}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ))}
          {pager}
        </div>
      )}
    </>
  );
}
