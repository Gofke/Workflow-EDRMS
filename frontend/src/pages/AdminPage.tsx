import { CalendarPlus, Check, KeyRound, Pencil, Play, Plus, RefreshCw, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { date, dateTime } from '../lib/format';
import { useApi } from '../lib/hooks';
import { AI_FEATURE, CLASSIFICATION, PRIORITY, ROLE } from '../lib/labels';
import { auditSummaryNl } from '../lib/auditText';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, Confirm, Dialog, Empty, ErrorNote, Field, Loading, Notice, PageHead, Panel, Segmented, Tabs, useToast } from '../ui';
import { forgetPeople, PersonRow, PersonSelect } from '../ui/people';

type Tab = 'medewerkers' | 'afdelingen' | 'instellingen' | 'assistent' | 'feestdagen' | 'sjablonen' | 'koppelingen' | 'berichten' | 'beveiliging';
const ROLES = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SUPPORT_STAFF', 'RECORDS_MANAGER', 'AUDITOR', 'SYS_ADMIN'];

export default function AdminPage() {
  const { t } = usePrefs();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'medewerkers';
  return (
    <>
      <PageHead
        title={t('Beheer', 'Administration')}
        lead={t(
          'Accounts, afdelingen en instellingen van het systeem. Beheerders zien geen inhoud van stukken; elke wijziging hier staat in het logboek.',
          'Accounts, departments and system settings. Administrators do not see record content; every change here is in the log.',
        )}
      />
      <Tabs
        label={t('Beheer', 'Administration')}
        value={tab}
        onChange={(v) => setParams(v === 'medewerkers' ? {} : { tab: v }, { replace: true })}
        tabs={[
          { value: 'medewerkers', label: t('Medewerkers', 'People') },
          { value: 'afdelingen', label: t('Afdelingen', 'Departments') },
          { value: 'instellingen', label: t('Instellingen', 'Settings') },
          { value: 'assistent', label: t('Assistent', 'Assistant') },
          { value: 'feestdagen', label: t('Feestdagen', 'Holidays') },
          { value: 'sjablonen', label: t('Sjablonen en routes', 'Templates and routes') },
          { value: 'koppelingen', label: t('Koppelingen', 'Integrations') },
          { value: 'berichten', label: t('Berichten en taken', 'Messages and jobs') },
          { value: 'beveiliging', label: t('Beveiliging', 'Security') },
        ]}
      />
      <div style={{ marginTop: 20 }}>
        {tab === 'medewerkers' && <AccountsTab />}
        {tab === 'afdelingen' && <UnitsTab />}
        {tab === 'instellingen' && <SettingsTab />}
        {tab === 'assistent' && <AssistantTab />}
        {tab === 'feestdagen' && <HolidaysTab />}
        {tab === 'sjablonen' && <TemplatesTab />}
        {tab === 'koppelingen' && <KeysTab />}
        {tab === 'berichten' && <MessagesTab />}
        {tab === 'beveiliging' && <SecurityTab />}
      </div>
    </>
  );
}

const roleName = (t: (a: string, b: string) => string, r: string) => (ROLE[r] ? t(ROLE[r][0], ROLE[r][1]) : r);

// ------------------------------------------------------------------ accounts

interface Unit { id: string; code: string; name: string; kind: string; isActive: boolean; parentUnitId: string | null; headAccountId: string | null; headName: string | null; memberCount: number }

function AccountsTab() {
  const { t } = usePrefs();
  const toast = useToast();
  const { user } = useSession();
  const { data, error, reload } = useApi<PersonRow[]>('/api/admin/accounts/directory');
  const units = useApi<Unit[]>('/api/org/units');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<PersonRow | 'new' | null>(null);
  const [resetting, setResetting] = useState<PersonRow | null>(null);
  const [toggling, setToggling] = useState<PersonRow | null>(null);
  const rows = (data ?? []).filter((p) => !q.trim() || `${p.personName} ${p.email} ${p.unit ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const changed = () => {
    forgetPeople();
    void reload();
  };
  return (
    <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="row between">
        <input className="input" style={{ maxWidth: 320 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Zoek op naam, e-mail of afdeling', 'Search by name, e-mail or department')} aria-label={t('Zoeken', 'Search')} />
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          <UserPlus size={16} /> {t('Nieuwe medewerker', 'New person')}
        </button>
      </div>
      <ErrorNote error={error} />
      <Panel flush>
        {!data ? (
          <Loading lines={8} />
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>{t('Naam', 'Name')}</th>
                <th>{t('Afdeling', 'Department')}</th>
                <th>{t('Rollen', 'Roles')}</th>
                <th>{t('Status', 'Status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.accountId} style={p.isEnabled ? undefined : { opacity: 0.65 }}>
                  <td>
                    <strong>{p.personName}</strong>
                    <div className="xs muted">
                      {p.jobPosition ? `${p.jobPosition}, ` : ''}
                      {p.email}
                    </div>
                  </td>
                  <td className="small">{p.unit ?? '—'}</td>
                  <td>
                    <div className="chips">
                      {p.roles.map((r) => (
                        <Badge key={r} tone={r === 'SYS_ADMIN' || r === 'AUDITOR' ? 'info' : 'neutral'}>
                          {roleName(t, r)}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td>
                    {p.isEnabled ? <Badge tone="ok">{t('Actief', 'Active')}</Badge> : <Badge tone="danger">{t('Uitgeschakeld', 'Disabled')}</Badge>}
                    {p.absentUntil && (
                      <div className="xs muted">
                        {t('afwezig tot', 'away until')} {date(p.absentUntil)}
                      </div>
                    )}
                  </td>
                  <td className="nowrap">
                    <button type="button" className="icon-btn" aria-label={t(`${p.personName} wijzigen`, `Edit ${p.personName}`)} onClick={() => setEditing(p)}>
                      <Pencil size={16} />
                    </button>
                    <button type="button" className="icon-btn" aria-label={t('Nieuw wachtwoord', 'New password')} title={t('Nieuw wachtwoord', 'New password')} onClick={() => setResetting(p)}>
                      <KeyRound size={16} />
                    </button>
                    {p.accountId !== user?.accountId && (
                      <button type="button" className="btn sm ghost" onClick={() => setToggling(p)}>
                        {p.isEnabled ? t('Uitschakelen', 'Disable') : t('Inschakelen', 'Enable')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {editing && <AccountDialog person={editing === 'new' ? null : editing} units={units.data ?? []} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), changed())} />}
      {resetting && <ResetDialog person={resetting} onClose={() => setResetting(null)} />}
      {toggling && (
        <Confirm
          title={toggling.isEnabled ? t(`${toggling.personName} uitschakelen?`, `Disable ${toggling.personName}?`) : t(`${toggling.personName} weer inschakelen?`, `Enable ${toggling.personName} again?`)}
          confirmLabel={toggling.isEnabled ? t('Uitschakelen', 'Disable') : t('Inschakelen', 'Enable')}
          danger={toggling.isEnabled}
          onClose={() => setToggling(null)}
          onConfirm={async () => {
            await api.post(`/api/admin/accounts/${toggling.isEnabled ? 'disable' : 'enable'}`, { accountId: toggling.accountId });
            toast(toggling.isEnabled ? t('Account uitgeschakeld; open sessies zijn beëindigd', 'Account disabled; open sessions ended') : t('Account ingeschakeld', 'Account enabled'));
            setToggling(null);
            changed();
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            {toggling.isEnabled ? t('De medewerker kan niet meer aanmelden. Alles wat hij of zij deed, blijft bewaard.', 'The person can no longer sign in. Everything they did is kept.') : t('De medewerker kan weer aanmelden met de bestaande rollen.', 'The person can sign in again with the existing roles.')}
          </p>
        </Confirm>
      )}
    </div>
  );
}

function AccountDialog({ person, units, onClose, onSaved }: { person: PersonRow | null; units: Unit[]; onClose: () => void; onSaved: () => void }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [fullName, setFullName] = useState(person?.personName ?? '');
  const [job, setJob] = useState(person?.jobPosition ?? '');
  const [email, setEmail] = useState(person?.email ?? '');
  const [unitId, setUnitId] = useState(person?.unitId ?? '');
  const [roles, setRoles] = useState<string[]>(person?.roles ?? ['SUPPORT_STAFF']);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!person) {
        await api.post('/api/admin/accounts', { fullName, jobPosition: job || undefined, email, unitId: unitId || undefined, roles, initialPassword: password });
      } else {
        await api.put(`/api/admin/accounts/${person.accountId}`, { fullName, jobPosition: job || null, unitId: unitId || null });
        for (const r of roles.filter((r) => !person.roles.includes(r))) await api.post('/api/admin/roles/assign', { accountId: person.accountId, roleCode: r });
        for (const r of person.roles.filter((r) => !roles.includes(r))) await api.post('/api/admin/roles/revoke', { accountId: person.accountId, roleCode: r });
      }
      toast(t('Opgeslagen', 'Saved'));
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      wide
      title={person ? person.personName : t('Nieuwe medewerker', 'New person')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || fullName.trim().length < 2 || (!person && (password.length < 12 || !email.includes('@')))} onClick={() => void save()}>
            {t('Opslaan', 'Save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('Naam', 'Name')}>
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label={t('Functie', 'Position')}>
            <input className="input" value={job} onChange={(e) => setJob(e.target.value)} />
          </Field>
          <Field label={t('E-mail (aanmeldnaam)', 'E-mail (sign-in name)')}>
            <input className="input" type="email" value={email} disabled={!!person} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t('Afdeling', 'Department')}>
            <select className="select" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">{t('Geen', 'None')}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          {!person && (
            <Field label={t('Eerste wachtwoord', 'First password')} hint={t('Minstens 12 tekens. Geef het persoonlijk door; de medewerker wijzigt het na aanmelden.', 'At least 12 characters. Hand it over in person; the person changes it after signing in.')}>
              <input className="input" type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          )}
        </div>
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: 8 }}>{t('Rollen', 'Roles')}</legend>
          <div className="role-grid">
            {ROLES.map((r) => (
              <label key={r} className="check">
                <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles((rs) => (e.target.checked ? [...rs, r] : rs.filter((x) => x !== r)))} />
                {roleName(t, r)}
              </label>
            ))}
          </div>
          <p className="xs muted" style={{ marginBottom: 0 }}>
            {t('De rollen Systeembeheerder en Auditor geven geen toegang tot de inhoud van stukken.', 'The System administrator and Auditor roles give no access to record content.')}
          </p>
        </fieldset>
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}

function ResetDialog({ person, onClose }: { person: PersonRow; onClose: () => void }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={t(`Nieuw wachtwoord voor ${person.personName}`, `New password for ${person.personName}`)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={pw.length < 12}
            onClick={async () => {
              try {
                await api.post(`/api/admin/accounts/${person.accountId}/reset-password`, { newPassword: pw });
                toast(t('Wachtwoord ingesteld; open sessies zijn beëindigd', 'Password set; open sessions ended'));
                onClose();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('Instellen', 'Set')}
          </button>
        </>
      }
    >
      <Field label={t('Nieuw wachtwoord', 'New password')} hint={t('Minstens 12 tekens. Het wordt nergens getoond of bewaard, alleen als versleutelde controlewaarde.', 'At least 12 characters. It is never shown or stored, only as an encrypted check value.')}>
        <input className="input" type="text" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
    </Dialog>
  );
}

// ------------------------------------------------------------------ units

const KINDS: Record<string, [string, string]> = {
  CABINET: ['Kabinet', 'Cabinet'],
  DIRECTORATE: ['Directoraat', 'Directorate'],
  DEPARTMENT: ['Afdeling', 'Department'],
  DISTRICT: ['District', 'District'],
  OFFICE: ['Bureau', 'Office'],
  SERVICE: ['Dienst', 'Service'],
};

function UnitsTab() {
  const { t } = usePrefs();
  const { data, error, reload } = useApi<Unit[]>('/api/org/units');
  const [editing, setEditing] = useState<Unit | 'new' | null>(null);
  const byId = new Map((data ?? []).map((u) => [u.id, u]));
  return (
    <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: '68ch' }}>
          {t('De afdelingen bepalen wie wat ziet, wie de leiding heeft voor escalaties, en waar de assistent post naartoe voorstelt.', 'Departments decide who sees what, who leads for escalations, and where the assistant suggests post should go.')}
        </p>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={16} /> {t('Nieuwe afdeling', 'New department')}
        </button>
      </div>
      <ErrorNote error={error} />
      <Panel flush>
        {!data ? (
          <Loading />
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>{t('Afdeling', 'Department')}</th>
                <th>{t('Valt onder', 'Part of')}</th>
                <th>{t('Hoofd', 'Head')}</th>
                <th>{t('Medewerkers', 'People')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id} style={u.isActive ? undefined : { opacity: 0.6 }}>
                  <td>
                    <strong>{u.name}</strong> <span className="stamp">{u.code}</span>
                    <div className="xs muted">{KINDS[u.kind] ? t(KINDS[u.kind][0], KINDS[u.kind][1]) : u.kind}</div>
                  </td>
                  <td className="small">{u.parentUnitId ? byId.get(u.parentUnitId)?.name ?? '—' : '—'}</td>
                  <td className="small">{u.headName ?? <span className="muted">{t('niet ingesteld', 'not set')}</span>}</td>
                  <td>{u.memberCount}</td>
                  <td>
                    <button type="button" className="icon-btn" aria-label={t(`${u.name} wijzigen`, `Edit ${u.name}`)} onClick={() => setEditing(u)}>
                      <Pencil size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {editing && <UnitDialog unit={editing === 'new' ? null : editing} units={data ?? []} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), forgetPeople(), void reload())} />}
    </div>
  );
}

function UnitDialog({ unit, units, onClose, onSaved }: { unit: Unit | null; units: Unit[]; onClose: () => void; onSaved: () => void }) {
  const { t } = usePrefs();
  const [code, setCode] = useState(unit?.code ?? '');
  const [name, setName] = useState(unit?.name ?? '');
  const [kind, setKind] = useState(unit?.kind ?? 'DEPARTMENT');
  const [parent, setParent] = useState(unit?.parentUnitId ?? '');
  const [head, setHead] = useState(unit?.headAccountId ?? '');
  const [active, setActive] = useState(unit?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      if (unit) await api.put(`/api/org/units/${unit.id}`, { name, kind, parentUnitId: parent || null, headAccountId: head || null, isActive: active });
      else await api.post('/api/org/units', { code, name, kind, ...(parent ? { parentUnitId: parent } : {}) });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Dialog
      title={unit ? unit.name : t('Nieuwe afdeling', 'New department')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={name.trim().length < 2 || (!unit && code.trim().length < 2)} onClick={() => void save()}>
            {t('Opslaan', 'Save')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('Code', 'Code')}>
          <input className="input" value={code} disabled={!!unit} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label={t('Naam', 'Name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('Soort', 'Kind')}>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KINDS).map(([k, [nl, en]]) => (
              <option key={k} value={k}>
                {t(nl, en)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Valt onder', 'Part of')}>
          <select className="select" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">{t('Niets (hoogste niveau)', 'Nothing (top level)')}</option>
            {units
              .filter((u) => u.id !== unit?.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </Field>
        {unit && (
          <Field label={t('Hoofd', 'Head')}>
            <PersonSelect value={head} onChange={setHead} placeholder={t('Niet ingesteld', 'Not set')} />
          </Field>
        )}
        {unit && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('Actief', 'Active')}
          </label>
        )}
      </div>
      <ErrorNote error={error} />
    </Dialog>
  );
}

// ------------------------------------------------------------------ settings

type Settings = Record<string, Record<string, unknown>>;

function useSetting<K extends string>(all: Settings | null, key: K) {
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (all) setValue(structuredClone(all[key]));
  }, [all, key]);
  return [value, setValue] as const;
}

function SettingSection({ title, keyName, all, onSaved, children, describe }: { title: string; keyName: string; all: Settings; onSaved: () => void; children: (v: Record<string, unknown>, set: (patch: Record<string, unknown>) => void) => ReactNode; describe?: string }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [v, setV] = useSetting(all, keyName);
  const [error, setError] = useState<string | null>(null);
  if (!v) return null;
  const dirty = JSON.stringify(v) !== JSON.stringify(all[keyName]);
  return (
    <Panel
      title={title}
      actions={
        <button
          type="button"
          className="btn sm primary"
          disabled={!dirty}
          onClick={async () => {
            setError(null);
            try {
              await api.put(`/api/settings/${keyName}`, { value: v });
              toast(t('Instelling opgeslagen', 'Setting saved'));
              onSaved();
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          <Check size={14} /> {t('Opslaan', 'Save')}
        </button>
      }
    >
      {describe && (
        <p className="small muted" style={{ margin: '0 0 14px' }}>
          {describe}
        </p>
      )}
      {children(v, (patch) => setV({ ...v, ...patch }))}
      <ErrorNote error={error} />
    </Panel>
  );
}

const num = (s: string) => (s === '' ? 0 : Number(s));

function SettingsTab() {
  const { t } = usePrefs();
  const { refresh } = useSession();
  const { data, error, reload } = useApi<Settings>('/api/settings');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading lines={8} />;
  const saved = () => {
    void reload();
    void refresh();
  };
  return (
    <div className="settings-grid">
      <SettingSection title={t('Huisstijl', 'Branding')} keyName="branding" all={data} onSaved={saved} describe={t('Naam en kleuren op het scherm, op brieven, etiketten en rapporten.', 'Name and colours on screen, on letters, labels and reports.')}>
        {(v, set) => (
          <div className="form-grid">
            <Field label={t('Organisatie', 'Organisation')}>
              <input className="input" value={String(v.organisationName ?? '')} onChange={(e) => set({ organisationName: e.target.value })} />
            </Field>
            <Field label={t('Naam van het systeem', 'System name')}>
              <input className="input" value={String(v.productName ?? '')} onChange={(e) => set({ productName: e.target.value })} />
            </Field>
            <Field label={t('Ondertitel', 'Tagline')} className="wide">
              <input className="input" value={String(v.tagline ?? '')} onChange={(e) => set({ tagline: e.target.value })} />
            </Field>
            <Field label={t('Hoofdkleur', 'Main colour')}>
              <span className="row" style={{ gap: 8 }}>
                <input type="color" value={String(v.primaryColor)} onChange={(e) => set({ primaryColor: e.target.value })} aria-label={t('Hoofdkleur', 'Main colour')} />
                <input className="input mono" value={String(v.primaryColor)} onChange={(e) => set({ primaryColor: e.target.value })} />
              </span>
            </Field>
            <Field label={t('Accentkleur', 'Accent colour')}>
              <span className="row" style={{ gap: 8 }}>
                <input type="color" value={String(v.accentColor)} onChange={(e) => set({ accentColor: e.target.value })} aria-label={t('Accentkleur', 'Accent colour')} />
                <input className="input mono" value={String(v.accentColor)} onChange={(e) => set({ accentColor: e.target.value })} />
              </span>
            </Field>
            <Field label={t('Briefhoofd (elke regel apart)', 'Letterhead (each line separately)')} className="wide">
              <textarea className="textarea" rows={3} value={((v.letterheadLines as string[]) ?? []).join('\n')} onChange={(e) => set({ letterheadLines: e.target.value.split('\n').slice(0, 6) })} />
            </Field>
            <Field label={t('Ondertekening', 'Signatory')} className="wide">
              <input className="input" value={String(v.signatoryTitle ?? '')} onChange={(e) => set({ signatoryTitle: e.target.value })} />
            </Field>
          </div>
        )}
      </SettingSection>
      <SettingSection title={t('Termijnen', 'Deadlines')} keyName="deadlines" all={data} onSaved={saved} describe={t('Herinneringen en escalaties tellen in werkdagen; weekenden en feestdagen tellen niet mee.', 'Reminders and escalations count working days; weekends and holidays do not count.')}>
        {(v, set) => (
          <div className="form-grid">
            <Field label={t('Herinneren, werkdagen vooraf', 'Remind, working days before')} hint={t('Gescheiden door komma’s', 'Separated by commas')}>
              <input className="input" value={((v.reminderDaysBefore as number[]) ?? []).join(', ')} onChange={(e) => set({ reminderDaysBefore: e.target.value.split(/[,\s]+/).filter(Boolean).map(Number) })} />
            </Field>
            <Field label={t('Escaleren na (werkdagen te laat)', 'Escalate after (working days late)')}>
              <input className="input" type="number" min={0} value={String(v.escalateAfterWorkingDays)} onChange={(e) => set({ escalateAfterWorkingDays: num(e.target.value) })} />
            </Field>
            <Field label={t('Tweede escalatie na nog (werkdagen)', 'Second escalation after another (working days)')}>
              <input className="input" type="number" min={1} value={String(v.secondEscalationAfterWorkingDays)} onChange={(e) => set({ secondEscalationAfterWorkingDays: num(e.target.value) })} />
            </Field>
            <Field label={t('Standaard afhandeltermijn post (werkdagen)', 'Standard handling time for post (working days)')}>
              <input className="input" type="number" min={1} value={String(v.defaultIncomingWorkingDays)} onChange={(e) => set({ defaultIncomingWorkingDays: num(e.target.value) })} />
            </Field>
          </div>
        )}
      </SettingSection>
      <SettingSection title={t('Aanmelden en wachtwoorden', 'Sign-in and passwords')} keyName="security" all={data} onSaved={saved}>
        {(v, set) => (
          <div className="stack">
            <div className="form-grid">
              <Field label={t('Minimale wachtwoordlengte', 'Minimum password length')}>
                <input className="input" type="number" min={8} max={64} value={String(v.passwordMinLength)} onChange={(e) => set({ passwordMinLength: num(e.target.value) })} />
              </Field>
              <Field label={t('Blokkeren na mislukte pogingen', 'Lock after failed attempts')}>
                <input className="input" type="number" min={3} max={20} value={String(v.lockoutThreshold)} onChange={(e) => set({ lockoutThreshold: num(e.target.value) })} />
              </Field>
              <Field label={t('Account geblokkeerd voor (minuten)', 'Account locked for (minutes)')}>
                <input className="input" type="number" min={1} value={String(v.lockoutMinutes)} onChange={(e) => set({ lockoutMinutes: num(e.target.value) })} />
              </Field>
            </div>
            <RolePicker label={t('Tweestapsverificatie verplicht voor', 'Two-step verification required for')} value={(v.mfaRequiredForRoles as string[]) ?? []} onChange={(r) => set({ mfaRequiredForRoles: r })} />
          </div>
        )}
      </SettingSection>
      <SettingSection title={t('Vertrouwelijkheid', 'Confidentiality')} keyName="classification" all={data} onSaved={saved} describe={t('Wie vertrouwelijke en geheime stukken mag zien, naast wie er uitdrukkelijk toegang toe krijgt.', 'Who may see confidential and secret records, besides those explicitly granted access.')}>
        {(v, set) => (
          <div className="stack">
            <Field label={t('Standaard voor nieuwe stukken', 'Default for new records')}>
              <select className="select" style={{ maxWidth: 260 }} value={String(v.defaultLevel)} onChange={(e) => set({ defaultLevel: e.target.value })}>
                {['OPEN', 'INTERNAL', 'CONFIDENTIAL'].map((c) => (
                  <option key={c} value={c}>
                    {t(CLASSIFICATION[c][0], CLASSIFICATION[c][1])}
                  </option>
                ))}
              </select>
            </Field>
            <RolePicker label={t('Vertrouwelijk: zichtbaar voor', 'Confidential: visible to')} exclude={['SYS_ADMIN', 'AUDITOR']} value={(v.confidentialRoles as string[]) ?? []} onChange={(r) => set({ confidentialRoles: r })} />
            <RolePicker label={t('Geheim: zichtbaar voor', 'Secret: visible to')} exclude={['SYS_ADMIN', 'AUDITOR']} value={(v.secretRoles as string[]) ?? []} onChange={(r) => set({ secretRoles: r })} />
            <label className="check">
              <input type="checkbox" checked={Boolean(v.unitSeesConfidential)} onChange={(e) => set({ unitSeesConfidential: e.target.checked })} />
              {t('De behandelende afdeling ziet vertrouwelijke stukken van haar eigen zaken', 'The handling department sees confidential records of its own matters')}
            </label>
          </div>
        )}
      </SettingSection>
      <SettingSection title={t('Meldingen', 'Notifications')} keyName="notifications" all={data} onSaved={saved}>
        {(v, set) => (
          <div className="stack">
            <div className="row" style={{ gap: 18 }}>
              <label className="check">
                <input type="checkbox" checked={Boolean(v.emailEnabled)} onChange={(e) => set({ emailEnabled: e.target.checked })} /> {t('E-mail', 'E-mail')}
              </label>
              <label className="check">
                <input type="checkbox" checked={Boolean(v.smsEnabled)} onChange={(e) => set({ smsEnabled: e.target.checked })} /> SMS
              </label>
              <label className="check">
                <input type="checkbox" checked={Boolean(v.pushEnabled)} onChange={(e) => set({ pushEnabled: e.target.checked })} /> {t('Pushmeldingen', 'Push notifications')}
              </label>
            </div>
            <div className="form-grid">
              <Field label={t('Dagoverzicht om (uur)', 'Daily digest at (hour)')}>
                <input className="input" type="number" min={0} max={23} value={String(v.digestHour)} onChange={(e) => set({ digestHour: num(e.target.value) })} />
              </Field>
              <Field label={t('Weekrapport op', 'Weekly report on')}>
                <select className="select" value={String(v.weeklyReportWeekday)} onChange={(e) => set({ weeklyReportWeekday: Number(e.target.value) })}>
                  {[t('zondag', 'Sunday'), t('maandag', 'Monday'), t('dinsdag', 'Tuesday'), t('woensdag', 'Wednesday'), t('donderdag', 'Thursday'), t('vrijdag', 'Friday'), t('zaterdag', 'Saturday')].map((d, i) => (
                    <option key={i} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        )}
      </SettingSection>
      <SettingSection title={t('Volgen door burgers', 'Tracking by citizens')} keyName="publicTracking" all={data} onSaved={saved}>
        {(v, set) => (
          <label className="check">
            <input type="checkbox" checked={Boolean(v.enabled)} onChange={(e) => set({ enabled: e.target.checked })} />
            {t('Afzenders kunnen met hun volgcode de stand van hun brief opzoeken (zonder inhoud)', 'Senders can look up the status of their letter with their tracking code (without content)')}
          </label>
        )}
      </SettingSection>
      <SettingSection title={t('Oefenomgeving', 'Training environment')} keyName="training" all={data} onSaved={saved}>
        {(v, set) => (
          <div className="stack">
            <label className="check">
              <input type="checkbox" checked={Boolean(v.enabled)} onChange={(e) => set({ enabled: e.target.checked })} /> {t('Dit is een oefenomgeving: toon een balk bovenaan elk scherm', 'This is a training environment: show a bar on every screen')}
            </label>
            <Field label={t('Tekst van de balk', 'Bar text')}>
              <input className="input" value={String(v.banner ?? '')} onChange={(e) => set({ banner: e.target.value })} />
            </Field>
          </div>
        )}
      </SettingSection>
    </div>
  );
}

function RolePicker({ label, value, onChange, exclude = [] }: { label: string; value: string[]; onChange: (r: string[]) => void; exclude?: string[] }) {
  const { t } = usePrefs();
  return (
    <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: 6 }}>{label}</legend>
      <div className="role-grid">
        {ROLES.filter((r) => !exclude.includes(r)).map((r) => (
          <label key={r} className="check small">
            <input type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
            {roleName(t, r)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ assistant

function AssistantTab() {
  const { t } = usePrefs();
  const { refresh } = useSession();
  const toast = useToast();
  const { data, error, reload } = useApi<Settings>('/api/settings');
  const [v, setV] = useState<Record<string, unknown> | null>(null);
  const [check, setCheck] = useState<{ reachable: boolean; models: string[]; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (data) setV(structuredClone(data.ai));
  }, [data]);
  if (error) return <ErrorNote error={error} />;
  if (!data || !v) return <Loading />;
  const features = v.features as Record<string, boolean>;
  const provider = String(v.provider);
  const set = (patch: Record<string, unknown>) => setV({ ...v, ...patch });
  const dirty = JSON.stringify(v) !== JSON.stringify(data.ai);
  return (
    <div className="split">
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Panel title={t('Welke assistent', 'Which assistant')}>
          <div className="stack">
            <div className="provider-list" role="radiogroup" aria-label={t('Soort assistent', 'Kind of assistant')}>
              {(
                [
                  ['builtin', t('Ingebouwd (aanbevolen)', 'Built-in (recommended)'), t('Draait op deze server. Gratis, geen internet, er gaat niets naar buiten. Herkent velden, termijnen, dubbele stukken, vat samen, maakt concepten en beantwoordt vragen over het werk.', 'Runs on this server. Free, no internet, nothing leaves it. Recognises fields, deadlines, duplicates, summarises, drafts and answers questions about the work.')],
                  ['ollama', t('Open-source taalmodel op het eigen netwerk (Ollama)', 'Open-source language model on the ministry network (Ollama)'), t('Gratis. Een eigen server met bijvoorbeeld Llama of Mistral. Schrijft vloeiender en kan vertalen. Valt terug op de ingebouwde assistent als het model niet antwoordt.', 'Free. A ministry server running for example Llama or Mistral. Writes more fluently and can translate. Falls back to the built-in assistant if the model does not answer.')],
                  ['openai-compatible', t('Ander model met een OpenAI-compatibele koppeling', 'Another model with an OpenAI-compatible interface'), t('Bijvoorbeeld LM Studio of vLLM op het eigen netwerk.', 'For example LM Studio or vLLM on the ministry network.')],
                  ['anthropic', t('Externe dienst (Claude)', 'External service (Claude)'), t('Betaald en buiten het netwerk. Vertrouwelijke en geheime stukken gaan er nooit naartoe.', 'Paid and outside the network. Confidential and secret records never go there.')],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className={`provider ${provider === value ? 'on' : ''}`}>
                  <input type="radio" name="provider" checked={provider === value} onChange={() => set({ provider: value })} />
                  <span>
                    <strong>{label}</strong>
                    <span className="xs muted" style={{ display: 'block' }}>
                      {hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {provider !== 'builtin' && (
              <div className="form-grid">
                <Field label={t('Adres', 'Address')} hint={provider === 'ollama' ? 'http://ai-server.juspol.local:11434/v1' : undefined}>
                  <input className="input mono" value={String(v.baseUrl ?? '')} onChange={(e) => set({ baseUrl: e.target.value })} />
                </Field>
                <Field label={t('Model', 'Model')}>
                  <input className="input mono" value={String(v.model ?? '')} onChange={(e) => set({ model: e.target.value })} />
                </Field>
                {provider === 'anthropic' && (
                  <label className="check wide">
                    <input type="checkbox" checked={Boolean(v.externalProviderAcknowledged)} onChange={(e) => set({ externalProviderAcknowledged: e.target.checked })} />
                    {t('Ik bevestig dat tekst van interne stukken het netwerk mag verlaten. De sleutel staat in de serverconfiguratie (AI_API_KEY), niet hier.', 'I confirm that text from internal records may leave the network. The key is in the server configuration (AI_API_KEY), not here.')}
                  </label>
                )}
              </div>
            )}
          </div>
        </Panel>
        <Panel title={t('Functies', 'Features')}>
          <div className="role-grid">
            {Object.keys(features).map((f) => (
              <label key={f} className="check">
                <input type="checkbox" checked={features[f]} onChange={(e) => set({ features: { ...features, [f]: e.target.checked } })} />
                {AI_FEATURE(t, f)}
                {f === 'translate' && provider === 'builtin' && <span className="xs muted"> ({t('vraagt een taalmodel', 'needs a language model')})</span>}
              </label>
            ))}
          </div>
        </Panel>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={!dirty}
            onClick={async () => {
              setErr(null);
              try {
                await api.put('/api/settings/ai', { value: v });
                toast(t('Assistent opgeslagen', 'Assistant saved'));
                setCheck(null);
                void reload();
                void refresh();
              } catch (e) {
                setErr(errorText(e));
              }
            }}
          >
            <Check size={16} /> {t('Opslaan', 'Save')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={dirty}
            title={dirty ? t('Eerst opslaan', 'Save first') : undefined}
            onClick={async () => {
              setCheck(null);
              try {
                setCheck(await api.get('/api/ai/model-check'));
              } catch (e) {
                setErr(errorText(e));
              }
            }}
          >
            <RefreshCw size={16} /> {t('Verbinding testen', 'Test the connection')}
          </button>
        </div>
        <ErrorNote error={err} />
        {check && (
          <Notice tone={check.reachable ? 'ok' : 'danger'} title={check.reachable ? t('Bereikbaar', 'Reachable') : t('Niet bereikbaar', 'Not reachable')}>
            {check.reachable ? (check.models[0] === 'builtin' ? t('De ingebouwde assistent werkt altijd.', 'The built-in assistant always works.') : `${t('Modellen', 'Models')}: ${check.models.join(', ')}`) : check.error}
          </Notice>
        )}
      </div>
      <Panel title={t('Zo blijft het veilig', 'How it stays safe')}>
        <ul className="small stack" style={{ margin: 0, paddingLeft: 18, gap: 8 }}>
          <li>{t('De assistent ziet per medewerker alleen wat die medewerker mag zien.', 'The assistant sees, per person, only what that person may see.')}</li>
          <li>{t('Vertrouwelijke en geheime stukken gaan nooit naar een dienst buiten het netwerk; dan antwoordt de ingebouwde assistent.', 'Confidential and secret records never go to a service outside the network; the built-in assistant answers instead.')}</li>
          <li>{t('Elk voorstel en wat ermee gebeurde, staat in het logboek, met model en tijd.', 'Every suggestion and what was done with it is in the log, with model and time.')}</li>
          <li>{t('Niets wordt geregistreerd, verstuurd of beslist zonder bevestiging van een medewerker.', 'Nothing is registered, sent or decided without a person’s confirmation.')}</li>
        </ul>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ holidays

function HolidaysTab() {
  const { t, language } = usePrefs();
  const toast = useToast();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const { data, reload } = useApi<{ date: string; name: string }[]>(`/api/calendar/holidays?year=${year}`);
  const [d, setD] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const years = [0, 1, 2].map((n) => String(new Date().getFullYear() - 1 + n));
  return (
    <div className="split">
      <Panel
        title={t(`Feestdagen ${year}`, `Public holidays ${year}`)}
        flush
        actions={<Segmented label={t('Jaar', 'Year')} value={year as (typeof years)[number]} onChange={setYear} options={years.map((y) => ({ value: y, label: y }))} />}
      >
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <Empty title={t('Geen feestdagen ingevoerd', 'No holidays entered')} />
        ) : (
          <ul className="list">
            {data.map((h) => (
              <li key={h.date} className="row between">
                <span>
                  <strong className="nowrap" style={{ display: 'inline-block', minWidth: 130 }}>
                    {new Date(`${h.date}T12:00:00Z`).toLocaleDateString(language === 'en' ? 'en-GB' : 'nl-NL', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' })}
                  </strong>{' '}
                  {h.name}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t(`${h.name} verwijderen`, `Remove ${h.name}`)}
                  onClick={async () => {
                    await api.del(`/api/calendar/holidays/${h.date}`);
                    void reload();
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Panel title={t('Feestdag toevoegen', 'Add a holiday')}>
          <div className="stack">
            <p className="small muted" style={{ marginTop: 0 }}>
              {t('Islamitische en Hindoestaanse feestdagen vallen elk jaar anders. Voer ze in zodra de regering de data bekendmaakt.', 'Islamic and Hindu holidays fall differently each year. Enter them as soon as the government announces the dates.')}
            </p>
            <div className="form-grid">
              <Field label={t('Datum', 'Date')}>
                <input className="input" type="date" value={d} onChange={(e) => setD(e.target.value)} />
              </Field>
              <Field label={t('Naam', 'Name')}>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
            <div className="row">
              <button
                type="button"
                className="btn primary"
                disabled={!d || name.trim().length < 2}
                onClick={async () => {
                  setError(null);
                  try {
                    await api.post('/api/calendar/holidays', { date: d, name: name.trim() });
                    setD('');
                    setName('');
                    void reload();
                    toast(t('Feestdag toegevoegd', 'Holiday added'));
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                <CalendarPlus size={16} /> {t('Toevoegen', 'Add')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const r = await api.post<{ added: number }>('/api/calendar/holidays/load-suriname');
                  toast(t(`Vaste Surinaamse feestdagen geladen (${r.added ?? 0} nieuw)`, `Fixed Surinamese holidays loaded (${r.added ?? 0} new)`));
                  void reload();
                }}
              >
                {t('Vaste Surinaamse feestdagen laden', 'Load fixed Surinamese holidays')}
              </button>
            </div>
            <ErrorNote error={error} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ templates

interface LetterTemplate { id: string; code: string; name: string; language: string; body: string; isActive: boolean }
interface TaskTemplate { id: string; name: string; description: string | null; titleTemplate: string; defaultPriority: string; defaultDueWorkingDays: number | null; checklist: string[]; subtasks: { title: string }[]; isActive: boolean }
interface Route { id: string; name: string; description: string | null; steps: { role: string; label: string }[]; isActive: boolean }

function TemplatesTab() {
  const { t } = usePrefs();
  const letters = useApi<LetterTemplate[]>('/api/letters/templates?all=true');
  const tasks = useApi<TaskTemplate[]>('/api/task-templates?all=true');
  const routes = useApi<Route[]>('/api/approval-routes?all=true');
  const [letter, setLetter] = useState<LetterTemplate | 'new' | null>(null);
  const [route, setRoute] = useState<Route | 'new' | null>(null);
  return (
    <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
      <Panel
        title={t('Briefsjablonen', 'Letter templates')}
        flush
        actions={
          <button type="button" className="btn sm" onClick={() => setLetter('new')}>
            <Plus size={14} /> {t('Nieuw', 'New')}
          </button>
        }
      >
        <ul className="list">
          {(letters.data ?? []).map((l) => (
            <li key={l.id} className="row between">
              <span className="stack" style={{ gap: 2 }}>
                <span>
                  <strong>{l.name}</strong> <span className="stamp">{l.code}</span> {!l.isActive && <Badge>{t('niet actief', 'inactive')}</Badge>}
                </span>
                <span className="xs muted">{l.body.slice(0, 120).replace(/\n/g, ' ')}…</span>
              </span>
              <button type="button" className="icon-btn" aria-label={t(`${l.name} wijzigen`, `Edit ${l.name}`)} onClick={() => setLetter(l)}>
                <Pencil size={16} />
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      <div className="grid-2">
        <Panel
          title={t('Goedkeuringsroutes', 'Approval routes')}
          flush
          actions={
            <button type="button" className="btn sm" onClick={() => setRoute('new')}>
              <Plus size={14} /> {t('Nieuw', 'New')}
            </button>
          }
        >
          <ul className="list">
            {(routes.data ?? []).map((r) => (
              <li key={r.id} className="row between" style={{ alignItems: 'flex-start' }}>
                <span className="stack" style={{ gap: 4 }}>
                  <strong>{r.name}</strong>
                  <ol className="route-steps">
                    {r.steps.map((s, i) => (
                      <li key={i}>
                        {s.label} <span className="xs muted">({roleName(t, s.role)})</span>
                      </li>
                    ))}
                  </ol>
                </span>
                <button type="button" className="icon-btn" aria-label={t(`${r.name} wijzigen`, `Edit ${r.name}`)} onClick={() => setRoute(r)}>
                  <Pencil size={16} />
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('Takensjablonen', 'Task templates')} flush>
          <ul className="list">
            {(tasks.data ?? []).map((tt) => (
              <li key={tt.id} className="stack" style={{ gap: 3 }}>
                <span>
                  <strong>{tt.name}</strong> {!tt.isActive && <Badge>{t('niet actief', 'inactive')}</Badge>}
                </span>
                <span className="xs muted">
                  {t(PRIORITY[tt.defaultPriority]?.[0] ?? tt.defaultPriority, PRIORITY[tt.defaultPriority]?.[1] ?? tt.defaultPriority)}
                  {tt.defaultDueWorkingDays ? t(`, binnen ${tt.defaultDueWorkingDays} werkdagen`, `, within ${tt.defaultDueWorkingDays} working days`) : ''}
                  {tt.checklist.length ? t(`, ${tt.checklist.length} controlepunten`, `, ${tt.checklist.length} checklist items`) : ''}
                  {tt.subtasks.length ? t(`, ${tt.subtasks.length} deeltaken`, `, ${tt.subtasks.length} subtasks`) : ''}
                </span>
              </li>
            ))}
            {tasks.error && <li className="small muted">{tasks.error}</li>}
          </ul>
        </Panel>
      </div>
      {letter && <LetterTemplateDialog value={letter === 'new' ? null : letter} onClose={() => setLetter(null)} onSaved={() => (setLetter(null), void letters.reload())} />}
      {route && <RouteDialog value={route === 'new' ? null : route} onClose={() => setRoute(null)} onSaved={() => (setRoute(null), void routes.reload())} />}
    </div>
  );
}

function LetterTemplateDialog({ value, onClose, onSaved }: { value: LetterTemplate | null; onClose: () => void; onSaved: () => void }) {
  const { t } = usePrefs();
  const [code, setCode] = useState(value?.code ?? '');
  const [name, setName] = useState(value?.name ?? '');
  const [language, setLanguage] = useState(value?.language ?? 'nl');
  const [body, setBody] = useState(value?.body ?? '');
  const [active, setActive] = useState(value?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    const dto = { code, name, language, body, isActive: active };
    try {
      if (value) await api.put(`/api/letters/templates/${value.id}`, dto);
      else await api.post('/api/letters/templates', dto);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Dialog
      wide
      title={value ? value.name : t('Nieuw briefsjabloon', 'New letter template')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={code.length < 2 || name.length < 2 || !body.trim()} onClick={() => void save()}>
            {t('Opslaan', 'Save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('Code', 'Code')}>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </Field>
          <Field label={t('Naam', 'Name')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('Taal', 'Language')}>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="nl">Nederlands</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>
        <Field label={t('Tekst', 'Text')} hint={t('Invulvelden tussen dubbele accolades worden bij gebruik ingevuld, zoals {{afzender}}, {{onderwerp}}, {{uw_brief_datum}}, {{uw_kenmerk}}, {{ons_kenmerk}}.', 'Fields between double braces are filled in when used, such as {{afzender}}, {{onderwerp}}, {{uw_brief_datum}}, {{uw_kenmerk}}, {{ons_kenmerk}}.')}>
          <textarea className="textarea" rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('In gebruik', 'In use')}
        </label>
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}

function RouteDialog({ value, onClose, onSaved }: { value: Route | null; onClose: () => void; onSaved: () => void }) {
  const { t } = usePrefs();
  const [name, setName] = useState(value?.name ?? '');
  const [description, setDescription] = useState(value?.description ?? '');
  const [steps, setSteps] = useState(value?.steps ?? [{ role: 'ONDER_DIRECTEUR', label: t('Paraaf Onder-Directeur', 'Initials Deputy Director') }]);
  const [active, setActive] = useState(value?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    const dto = { name, description, steps, isActive: active };
    try {
      if (value) await api.put(`/api/approval-routes/${value.id}`, dto);
      else await api.post('/api/approval-routes', dto);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Dialog
      title={value ? value.name : t('Nieuwe goedkeuringsroute', 'New approval route')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={name.trim().length < 2 || steps.length === 0 || steps.some((s) => !s.label.trim())} onClick={() => void save()}>
            {t('Opslaan', 'Save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('Naam', 'Name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('Waarvoor', 'What for')}>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="stack" style={{ gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{t('Stappen, in volgorde', 'Steps, in order')}</span>
          {steps.map((s, i) => (
            <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
              <span className="step-no">{i + 1}</span>
              <select className="select" style={{ width: 190 }} value={s.role} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} aria-label={t('Rol', 'Role')}>
                {['ONDER_DIRECTEUR', 'DIRECTEUR', 'MINISTER'].map((r) => (
                  <option key={r} value={r}>
                    {roleName(t, r)}
                  </option>
                ))}
              </select>
              <input className="input" value={s.label} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={t('Omschrijving van de stap', 'Step description')} />
              <button type="button" className="icon-btn" aria-label={t('Stap verwijderen', 'Remove step')} disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {steps.length < 6 && (
            <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setSteps([...steps, { role: 'MINISTER', label: t('Besluit Minister', 'Minister’s decision') }])}>
              <Plus size={14} /> {t('Stap toevoegen', 'Add step')}
            </button>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('In gebruik', 'In use')}
        </label>
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ integration keys

interface IntegrationKey { id: string; name: string; kind: string; keyPrefix: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null; actAsName: string }

function KeysTab() {
  const { t, language } = usePrefs();
  const { data, reload } = useApi<IntegrationKey[]>('/api/admin/integrations');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<IntegrationKey | null>(null);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const kinds: Record<string, string> = { WIJSAMEN: t('WijSamen-app (meldingen van burgers)', 'WijSamen app (citizen reports)'), MAIL_GATEWAY: t('Mailserver (post per e-mail)', 'Mail server (post by e-mail)') };
  return (
    <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: '70ch' }}>
          {t('Andere systemen leveren stukken aan met een eigen sleutel. Wat ze aanleveren komt als concept binnen, op naam van een registratiemedewerker, en wordt pas na controle geregistreerd.', 'Other systems deliver records with their own key. What they deliver arrives as a draft, in the name of a registry clerk, and is registered only after a check.')}
        </p>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <KeyRound size={16} /> {t('Nieuwe sleutel', 'New key')}
        </button>
      </div>
      {created && (
        <Notice tone="warn" title={t(`Sleutel voor ${created.name} — wordt maar één keer getoond`, `Key for ${created.name} — shown only once`)}>
          <code className="mono" style={{ wordBreak: 'break-all', display: 'block', margin: '6px 0' }}>
            {created.key}
          </code>
          <span className="xs">{t('Zet hem nu in het andere systeem. Daarna kan niemand hem meer inzien; bij verlies maakt u een nieuwe.', 'Put it in the other system now. After this nobody can see it again; if lost, create a new one.')}</span>
        </Notice>
      )}
      <Panel flush>
        {!data ? (
          <Loading />
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>{t('Naam', 'Name')}</th>
                <th>{t('Soort', 'Kind')}</th>
                <th>{t('Namens', 'On behalf of')}</th>
                <th>{t('Laatst gebruikt', 'Last used')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((k) => (
                <tr key={k.id} style={k.revokedAt ? { opacity: 0.6 } : undefined}>
                  <td>
                    <strong>{k.name}</strong>
                    <div className="xs muted mono">{k.keyPrefix}…</div>
                  </td>
                  <td className="small">{kinds[k.kind] ?? k.kind}</td>
                  <td className="small">{k.actAsName}</td>
                  <td className="small">{k.lastUsedAt ? dateTime(k.lastUsedAt, language) : t('nog niet', 'not yet')}</td>
                  <td>
                    {k.revokedAt ? (
                      <Badge tone="danger">{t('ingetrokken', 'revoked')}</Badge>
                    ) : (
                      <button type="button" className="btn sm ghost" onClick={() => setRevoking(k)}>
                        {t('Intrekken', 'Revoke')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {creating && <KeyDialog onClose={() => setCreating(false)} onCreated={(k) => (setCreating(false), setCreated(k), void reload())} />}
      {revoking && (
        <Confirm
          title={t(`Sleutel “${revoking.name}” intrekken?`, `Revoke key “${revoking.name}”?`)}
          confirmLabel={t('Intrekken', 'Revoke')}
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api.post(`/api/admin/integrations/${revoking.id}/revoke`);
            setRevoking(null);
            void reload();
          }}
        >
          {t('Het andere systeem kan daarna niets meer aanleveren.', 'The other system can deliver nothing after this.')}
        </Confirm>
      )}
    </div>
  );
}

function KeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (k: { key: string; name: string }) => void }) {
  const { t } = usePrefs();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('WIJSAMEN');
  const [actAs, setActAs] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={t('Nieuwe koppelsleutel', 'New integration key')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={name.trim().length < 2 || !actAs}
            onClick={async () => {
              setError(null);
              try {
                const r = await api.post<{ key: string }>('/api/admin/integrations', { name: name.trim(), kind, actAsAccountId: actAs });
                onCreated({ key: r.key, name: name.trim() });
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('Aanmaken', 'Create')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('Naam', 'Name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('bijv. WijSamen productie', 'e.g. WijSamen production')} />
        </Field>
        <Field label={t('Soort', 'Kind')}>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="WIJSAMEN">{t('WijSamen-app', 'WijSamen app')}</option>
            <option value="MAIL_GATEWAY">{t('Mailserver', 'Mail server')}</option>
          </select>
        </Field>
        <Field label={t('Concepten komen op naam van', 'Drafts arrive in the name of')}>
          <PersonSelect value={actAs} onChange={setActAs} roles={['SUPPORT_STAFF', 'RECORDS_MANAGER']} />
        </Field>
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ messages and jobs

interface Outbox { id: string; to: string; subject?: string; body: string; kind: string; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null }
interface Job { id: string; job: string; startedAt: string; finishedAt: string | null; outcome: Record<string, unknown> }

function MessagesTab() {
  const { t, language } = usePrefs();
  const toast = useToast();
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const outbox = useApi<Outbox[]>(`/api/admin/outbox/${channel}`);
  const jobs = useApi<Job[]>('/api/admin/jobs');
  const jobNames: Record<string, string> = {
    deadlines: t('Termijnen nalopen', 'Check deadlines'),
    digest: t('Dagoverzicht versturen', 'Send daily digest'),
    'weekly-report': t('Weekrapport versturen', 'Send weekly report'),
    outbox: t('Wachtende berichten versturen', 'Send waiting messages'),
  };
  const status: Record<string, [string, string, 'ok' | 'warn' | 'danger' | 'neutral']> = {
    SENT: ['Verstuurd', 'Sent', 'ok'],
    LOGGED: ['Vastgelegd, niet verzonden', 'Recorded, not sent', 'neutral'],
    QUEUED: ['Wacht', 'Waiting', 'warn'],
    FAILED: ['Mislukt', 'Failed', 'danger'],
  };
  return (
    <div className="split">
      <Panel
        title={t('Verstuurde berichten', 'Messages sent')}
        flush
        actions={
          <Segmented
            label={t('Kanaal', 'Channel')}
            value={channel}
            onChange={setChannel}
            options={[
              { value: 'email', label: t('E-mail', 'E-mail') },
              { value: 'sms', label: 'SMS' },
            ]}
          />
        }
      >
        <p className="xs muted" style={{ padding: '0 20px', margin: '0 0 8px' }}>
          {t('Er is nog geen mailserver of sms-dienst gekoppeld. Berichten worden daarom vastgelegd en niet verzonden, zodat niets verloren gaat. De koppeling wordt op de server ingesteld (zie de installatiehandleiding); daarna gaan nieuwe berichten echt de deur uit.', 'No mail server or text-message service is connected yet. Messages are therefore recorded, not sent, so nothing is lost. The connection is set on the server (see the installation guide); from then on new messages really go out.')}
        </p>
        {!outbox.data ? (
          <Loading />
        ) : outbox.data.length === 0 ? (
          <Empty title={t('Geen berichten', 'No messages')} />
        ) : (
          <ul className="list">
            {outbox.data.slice(0, 40).map((m) => (
              <li key={m.id} className="stack" style={{ gap: 3 }}>
                <span className="row between">
                  <strong className="small">{m.subject ?? m.body.slice(0, 80)}</strong>
                  <Badge tone={status[m.status]?.[2] ?? 'neutral'}>{status[m.status] ? t(status[m.status][0], status[m.status][1]) : m.status}</Badge>
                </span>
                <span className="xs muted">
                  {t('aan', 'to')} {m.to}, {dateTime(m.createdAt, language)}
                  {m.lastError ? `, ${m.lastError}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('Geplande taken', 'Scheduled jobs')} flush>
        <div className="stack" style={{ padding: '0 20px 14px', gap: 8 }}>
          {Object.entries(jobNames).map(([job, label]) => (
            <div key={job} className="row between">
              <span className="small">{label}</span>
              <button
                type="button"
                className="btn sm"
                onClick={async () => {
                  try {
                    await api.post(`/api/admin/jobs/${job}/run`);
                    toast(t('Uitgevoerd', 'Done'));
                    void jobs.reload();
                    void outbox.reload();
                  } catch (e) {
                    toast(errorText(e), 'error');
                  }
                }}
              >
                <Play size={14} /> {t('Nu uitvoeren', 'Run now')}
              </button>
            </div>
          ))}
        </div>
        <ul className="list">
          {(jobs.data ?? []).slice(0, 12).map((j) => (
            <li key={j.id} className="stack" style={{ gap: 2 }}>
              <span className="small strong">{jobNames[j.job] ?? j.job}</span>
              <span className="xs muted">
                {dateTime(j.startedAt, language)}
                {j.outcome && 'error' in j.outcome ? `, ${t('fout', 'error')}: ${String(j.outcome.error)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ security

function SecurityTab() {
  const { t, language } = usePrefs();
  const { data, error } = useApi<{ locks: { occurredAt: string; summary: string; account: string }[]; failures: { email: string; failures: number; lastAttempt: string; addresses: number }[] }>('/api/security/alerts');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="grid-2">
      <Panel title={t('Geblokkeerde accounts (7 dagen)', 'Locked accounts (7 days)')} flush>
        {data.locks.length === 0 ? (
          <p className="small muted" style={{ padding: '4px 20px 14px' }}>
            {t('Geen accounts geblokkeerd.', 'No accounts locked.')}
          </p>
        ) : (
          <ul className="list">
            {data.locks.map((l, i) => (
              <li key={i} className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <ShieldAlert size={18} style={{ color: 'var(--danger)', flex: 'none' }} />
                <span className="small">
                  {language === 'en' ? l.summary : auditSummaryNl(l.summary)}
                  <span className="xs muted" style={{ display: 'block' }}>
                    {dateTime(l.occurredAt, language)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('Mislukte aanmeldingen (7 dagen)', 'Failed sign-ins (7 days)')} flush>
        {data.failures.length === 0 ? (
          <p className="small muted" style={{ padding: '4px 20px 14px' }}>
            {t('Geen mislukte aanmeldingen.', 'No failed sign-ins.')}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('Aanmeldnaam', 'Sign-in name')}</th>
                <th>{t('Pogingen', 'Attempts')}</th>
                <th>{t('Laatste', 'Last')}</th>
              </tr>
            </thead>
            <tbody>
              {data.failures.map((f) => (
                <tr key={f.email}>
                  <td className="small">{f.email}</td>
                  <td className="small">
                    {f.failures}
                    {f.addresses > 1 && <span className="xs muted"> ({t(`${f.addresses} adressen`, `${f.addresses} addresses`)})</span>}
                  </td>
                  <td className="small nowrap">{dateTime(f.lastAttempt, language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
