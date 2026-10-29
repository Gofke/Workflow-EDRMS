import { FileDown, FileSpreadsheet, FileText, Fingerprint, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { date, dateTime } from '../lib/format';
import { useApi, useDebounced } from '../lib/hooks';
import { AUDIT_CATEGORY, AUDIT_TYPE } from '../lib/labels';
import { auditSummaryNl } from '../lib/auditText';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, Empty, ErrorNote, Field, Loading, Notice, PageHead, Panel, Tabs, useToast } from '../ui';
import { BarChart } from '../ui/charts';

type Tab = 'logboek' | 'integriteit';

interface Event { seq: number; id: string; occurredAt: string; eventType: string; actor: string | null; onBehalfOf: string | null; subject: string | null; previousValue: string | null; newValue: string | null; summary: string; chainHash: string; category: string }
interface Run { id: string; runAt: string; auditEvents: number; chainOk: boolean; anchorsOk: boolean; documents: number; documentsFailed: number; runBy: string; sealsFailed: number; ok: boolean }
interface Report {
  id: string;
  runAt: string;
  ok: boolean;
  audit: { events: number; chainOk: boolean; broken: number[]; newestSeq: number | null; newestHash: string | null };
  anchors: { checked: number; ok: boolean; missing: string[] };
  documents: { checked: number; failed: number; failures: { id: string; name: string; problem: string }[] };
  seals: { checked: number; failed: number; failures: { id: string; problem: string }[] };
  sealId: string | null;
}

const CATEGORIES = ['SECURITY', 'ADMINISTRATION', 'RECORDS', 'MATTERS', 'TASKS', 'ACCESS', 'ARCHIVE', 'ASSISTANT', 'INTEGRATION', 'OVERSIGHT'];

export default function AuditPage() {
  const { t } = usePrefs();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'logboek';
  return (
    <>
      <PageHead
        title={t('Logboek en integriteit', 'Log and integrity')}
        lead={t(
          'Elke handeling in het systeem staat in het logboek: wie, wat, wanneer en namens wie. Regels kunnen niet worden gewijzigd of verwijderd, en elke regel is met een vingerafdruk aan de vorige gekoppeld, zodat geknoei opvalt.',
          'Every action in the system is in the log: who, what, when and on whose behalf. Entries cannot be changed or deleted, and each entry is chained to the previous one with a fingerprint, so tampering shows.',
        )}
      />
      <Tabs
        label={t('Onderdeel', 'Section')}
        value={tab}
        onChange={(v) => setParams(v === 'logboek' ? {} : { tab: v }, { replace: true })}
        tabs={[
          { value: 'logboek', label: t('Logboek', 'Log') },
          { value: 'integriteit', label: t('Integriteitscontrole', 'Integrity check') },
        ]}
      />
      <div style={{ marginTop: 20 }}>{tab === 'logboek' ? <LogTab /> : <IntegrityTab />}</div>
    </>
  );
}

function LogTab() {
  const { t, language } = usePrefs();
  const { has } = useSession();
  const toast = useToast();
  const overview = useApi<{ days: number; categories: Record<string, number>; byDay: { day: string; n: number }[]; attention: number }>('/api/audit/overview?days=30');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q, 350);
  useEffect(() => setPage(1), [category, from, to, dq]);
  const filter = new URLSearchParams({ ...(category ? { category } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(dq.trim() ? { q: dq.trim() } : {}) });
  const list = useApi<{ total: number; page: number; limit: number; data: Event[] }>(`/api/audit/events?${filter.toString()}&page=${page}&limit=40`);
  const [open, setOpen] = useState<string | null>(null);
  const restricted = !has('AUDITOR', 'MINISTER');
  const download = async (ext: 'csv' | 'xlsx') => {
    try {
      await api.download(`/api/audit/events.${ext}?${filter.toString()}`, `logboek.${ext}`);
      toast(t('Logboek gedownload. Ook dat staat nu in het logboek.', 'Log downloaded. That is now in the log too.'));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const o = overview.data;
  return (
    <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
      {restricted && (
        <Notice tone="info">
          {t('Als beheerder ziet u het logboek zonder inhoud van stukken: onderwerpen van vertrouwelijke zaken zijn weggelaten. De auditor en de Minister zien alles.', 'As an administrator you see the log without record content: subjects of confidential matters are left out. The auditor and the Minister see everything.')}
        </Notice>
      )}
      {o && (
        <div className="grid-2">
          <Panel title={t(`Handelingen per dag (${o.days} dagen)`, `Actions per day (${o.days} days)`)}>
            <BarChart
              height={170}
              title={t('Aantal logboekregels per dag', 'Number of log entries per day')}
              labels={o.byDay.map((d) => date(d.day, language).replace(/ \d{4}$/, ''))}
              series={[{ name: t('Handelingen', 'Actions'), color: 'var(--brand)', values: o.byDay.map((d) => d.n) }]}
            />
          </Panel>
          <Panel title={t(`Per soort (${o.days} dagen)`, `By kind (${o.days} days)`)}>
            <div className="chips">
              <button type="button" className={`chip-btn ${category === '' ? 'on' : ''}`} aria-pressed={category === ''} onClick={() => setCategory('')}>
                {t('Alles', 'All')}
              </button>
              {CATEGORIES.filter((c) => o.categories[c]).map((c) => (
                <button key={c} type="button" className={`chip-btn ${category === c ? 'on' : ''}`} aria-pressed={category === c} onClick={() => setCategory(c)}>
                  {AUDIT_CATEGORY(t, c)} <strong>{o.categories[c]}</strong>
                </button>
              ))}
            </div>
            {o.attention > 0 ? (
              <Notice tone="danger" title={t(`${o.attention} meldingen vragen aandacht`, `${o.attention} entries need attention`)}>
                {t('Mislukte aanmeldingen, geblokkeerde accounts of documenten die niet meer kloppen.', 'Failed sign-ins, locked accounts or documents that no longer match.')}
              </Notice>
            ) : (
              <p className="small muted" style={{ marginBottom: 0 }}>
                <ShieldCheck size={15} style={{ verticalAlign: '-3px', color: 'var(--ok)' }} /> {t('Geen gebeurtenissen die aandacht vragen.', 'No events that need attention.')}
              </p>
            )}
          </Panel>
        </div>
      )}
      <Panel
        flush
        title={list.data ? t(`${list.data.total} ${list.data.total === 1 ? 'regel' : 'regels'}${category || q || from || to ? '' : ' sinds de ingebruikname'}`, `${list.data.total} ${list.data.total === 1 ? 'entry' : 'entries'}${category || q || from || to ? '' : ' since go-live'}`) : t('Regels', 'Entries')}
        actions={
          <div className="row">
            <button type="button" className="btn sm" onClick={() => void download('csv')}>
              <FileText size={15} /> CSV
            </button>
            <button type="button" className="btn sm" onClick={() => void download('xlsx')}>
              <FileSpreadsheet size={15} /> Excel
            </button>
          </div>
        }
      >
        <div className="filters" style={{ padding: '0 20px 14px' }}>
          <Field label={t('Zoeken in het logboek', 'Search the log')}>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('naam, nummer of woord', 'name, number or word')} />
          </Field>
          <Field label={t('Vanaf', 'From')}>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('Tot en met', 'Until')}>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <ErrorNote error={list.error} />
        {!list.data ? (
          <Loading lines={8} />
        ) : list.data.data.length === 0 ? (
          <Empty title={t('Geen regels gevonden', 'No entries found')} />
        ) : (
          <table className="table responsive audit-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('Wanneer', 'When')}</th>
                <th>{t('Handeling', 'Action')}</th>
                <th>{t('Door', 'By')}</th>
                <th>{t('Waarover', 'About')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((e) => (
                <Fragment key={e.id}>
                  <tr className={open === e.id ? 'open' : undefined}>
                    <td className="xs muted mono">{e.seq}</td>
                    <td className="nowrap small">{dateTime(e.occurredAt, language)}</td>
                    <td>
                      <button type="button" className="btn link" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                        {AUDIT_TYPE(t, e.eventType)}
                      </button>
                      <div className="xs muted">{AUDIT_CATEGORY(t, e.category)}</div>
                    </td>
                    <td className="small">
                      {e.actor?.replace(/ \(.*\)$/, '') ?? t('Systeem', 'System')}
                      {e.onBehalfOf && (
                        <div className="xs muted">
                          {t('namens', 'on behalf of')} {e.onBehalfOf}
                        </div>
                      )}
                    </td>
                    <td className="small">{e.subject ?? '—'}</td>
                  </tr>
                  {open === e.id && (
                    <tr className="detail-row">
                      <td colSpan={5}>
                        <dl className="kv-inline">
                          <dt>{t('Omschrijving', 'Description')}</dt>
                          <dd>{language === 'en' ? e.summary : auditSummaryNl(e.summary)}</dd>
                          {language !== 'en' && auditSummaryNl(e.summary) !== e.summary && (
                            <>
                              <dt>{t('Vastgelegde tekst', 'Stored text')}</dt>
                              <dd className="muted small">{e.summary}</dd>
                            </>
                          )}
                          {(e.previousValue || e.newValue) && (
                            <>
                              <dt>{t('Van → naar', 'From → to')}</dt>
                              <dd>
                                {e.previousValue ?? '—'} → {e.newValue ?? '—'}
                              </dd>
                            </>
                          )}
                          <dt>{t('Account', 'Account')}</dt>
                          <dd>{e.actor ?? t('Systeem', 'System')}</dd>
                          <dt>
                            <Fingerprint size={14} style={{ verticalAlign: '-2px' }} /> {t('Vingerafdruk', 'Fingerprint')}
                          </dt>
                          <dd className="mono xs" style={{ wordBreak: 'break-all' }}>
                            {e.chainHash}
                          </dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {list.data && list.data.total > list.data.limit && (
          <div className="row between" style={{ padding: '12px 20px' }}>
            <span className="small muted">
              {t(`Pagina ${page} van ${Math.ceil(list.data.total / list.data.limit)}`, `Page ${page} of ${Math.ceil(list.data.total / list.data.limit)}`)}
            </span>
            <div className="row">
              <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                {t('Nieuwer', 'Newer')}
              </button>
              <button type="button" className="btn sm" disabled={page * list.data.limit >= list.data.total} onClick={() => setPage(page + 1)}>
                {t('Ouder', 'Older')}
              </button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function IntegrityTab() {
  const { t, language } = usePrefs();
  const { has } = useSession();
  const toast = useToast();
  const runs = useApi<Run[]>('/api/integrity/runs');
  const [selected, setSelected] = useState<string | null>(null);
  const report = useApi<Report>(selected ? `/api/integrity/runs/${selected}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!selected && runs.data?.length) setSelected(runs.data[0].id);
  }, [runs.data, selected]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Report>('/api/integrity/run');
      await runs.reload();
      setSelected(r.id);
      toast(r.ok ? t('Alles klopt', 'Everything checks out') : t('Er zijn afwijkingen gevonden', 'Deviations were found'), r.ok ? 'ok' : 'error');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const r = report.data;
  return (
    <div className="split">
      <div className="stack" style={{ '--gap': '18px' } as React.CSSProperties}>
        <div className="row between">
          <p className="muted" style={{ margin: 0, maxWidth: '64ch' }}>
            {t('De controle loopt elke nacht vanzelf. Hij rekent de keten van het logboek na, vergelijkt elk opgeslagen document met zijn vingerafdruk en controleert elk digitaal zegel.', 'The check runs by itself every night. It recomputes the log chain, compares every stored document with its fingerprint and verifies every digital seal.')}
          </p>
          {has('AUDITOR', 'SYS_ADMIN') && (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>
              <Play size={16} /> {busy ? t('Bezig met controleren…', 'Checking…') : t('Nu controleren', 'Check now')}
            </button>
          )}
        </div>
        <ErrorNote error={error} />
        {!r ? (
          selected ? <Loading lines={6} /> : <Empty title={t('Nog geen controle', 'No check yet')} />
        ) : (
          <Panel
            title={
              <span className="row" style={{ gap: 10 }}>
                {r.ok ? <ShieldCheck size={22} style={{ color: 'var(--ok)' }} /> : <ShieldAlert size={22} style={{ color: 'var(--danger)' }} />}
                {r.ok ? t('Alles is ongewijzigd', 'Nothing has been altered') : t('Er zijn afwijkingen', 'There are deviations')}
              </span>
            }
            actions={
              <button type="button" className="btn sm" onClick={() => void api.download(`/api/integrity/runs/${r.id}/report.pdf`, 'integriteitsverklaring.pdf')}>
                <FileDown size={15} /> {t('Verklaring (PDF met zegel)', 'Statement (sealed PDF)')}
              </button>
            }
          >
            <p className="small muted" style={{ marginTop: 0 }}>
              {t('Controle van', 'Check of')} {dateTime(r.runAt, language)}
            </p>
            <ul className="checks">
              <li className={r.audit.chainOk ? 'ok' : 'bad'}>
                <strong>{t('Keten van het logboek', 'Log chain')}</strong>
                <span>
                  {r.audit.chainOk
                    ? t(`${r.audit.events} ${r.audit.events === 1 ? 'regel' : 'regels'} nagerekend; elke regel sluit aan op de vorige.`, `${r.audit.events} ${r.audit.events === 1 ? 'entry' : 'entries'} recomputed; every entry links to the previous one.`)
                    : t(`Breuk bij regel ${r.audit.broken.join(', ')}.`, `Break at entry ${r.audit.broken.join(', ')}.`)}
                </span>
              </li>
              <li className={r.anchors.ok ? 'ok' : 'bad'}>
                <strong>{t('Eerdere controles', 'Earlier checks')}</strong>
                <span>
                  {r.anchors.ok
                    ? r.anchors.checked === 0 ? t('Dit is de eerste controle; er zijn nog geen eerdere ankerpunten.', 'This is the first check; there are no earlier anchor points yet.') : r.anchors.checked === 1 ? t('Het eerder vastgelegde ankerpunt komt nog overeen.', 'The earlier anchor point still matches.') : t(`Alle ${r.anchors.checked} eerder vastgelegde ankerpunten komen nog overeen.`, `All ${r.anchors.checked} earlier anchor points still match.`)
                    : t('Een eerder vastgelegd ankerpunt komt niet meer overeen: het logboek is achteraf veranderd.', 'An earlier anchor point no longer matches: the log was changed afterwards.')}
                </span>
              </li>
              <li className={r.documents.failed === 0 ? 'ok' : 'bad'}>
                <strong>{t('Documenten', 'Documents')}</strong>
                <span>
                  {r.documents.failed === 0
                    ? r.documents.checked === 1 ? t('Het bestand is precies zoals het is opgeslagen.', 'The file is exactly as it was stored.') : t(`Alle ${r.documents.checked} bestanden zijn precies zoals ze zijn opgeslagen.`, `All ${r.documents.checked} files are exactly as they were stored.`)
                    : t(`${r.documents.failed} van de ${r.documents.checked} bestanden ${r.documents.failed === 1 ? 'wijkt' : 'wijken'} af.`, `${r.documents.failed} of ${r.documents.checked} files differ.`)}
                  {r.documents.failures.map((f) => (
                    <span key={f.id} className="xs" style={{ display: 'block', color: 'var(--danger)' }}>
                      {f.name}: {f.problem}
                    </span>
                  ))}
                </span>
              </li>
              <li className={r.seals.failed === 0 ? 'ok' : 'bad'}>
                <strong>{t('Digitale zegels', 'Digital seals')}</strong>
                <span>
                  {r.seals.failed === 0 ? (r.seals.checked === 1 ? t('Het zegel is geldig.', 'The seal is valid.') : t(`Alle ${r.seals.checked} zegels zijn geldig.`, `All ${r.seals.checked} seals are valid.`)) : t(`${r.seals.failed} ${r.seals.failed === 1 ? 'zegel is' : 'zegels zijn'} ongeldig.`, `${r.seals.failed} ${r.seals.failed === 1 ? 'seal is' : 'seals are'} invalid.`)}
                </span>
              </li>
            </ul>
            {r.audit.newestHash && (
              <p className="xs muted" style={{ marginBottom: 0 }}>
                {t('Laatste vingerafdruk', 'Latest fingerprint')} (#{r.audit.newestSeq}): <span className="mono" style={{ wordBreak: 'break-all' }}>{r.audit.newestHash}</span>
              </p>
            )}
          </Panel>
        )}
      </div>
      <Panel title={t('Eerdere controles', 'Earlier checks')} flush>
        <ul className="list">
          {(runs.data ?? []).map((x) => (
            <li key={x.id}>
              <button type="button" className={`list-link ${selected === x.id ? 'current' : ''}`} onClick={() => setSelected(x.id)}>
                {x.ok ? <ShieldCheck size={18} style={{ color: 'var(--ok)', flex: 'none', marginTop: 2 }} /> : <ShieldAlert size={18} style={{ color: 'var(--danger)', flex: 'none', marginTop: 2 }} />}
                <span className="grow stack" style={{ gap: 2, textAlign: 'left' }}>
                  <span className="list-title">{dateTime(x.runAt, language)}</span>
                  <span className="xs muted">
                    {x.runBy}, {t(`${x.auditEvents} regels, ${x.documents} documenten`, `${x.auditEvents} entries, ${x.documents} documents`)}
                  </span>
                </span>
                <Badge tone={x.ok ? 'ok' : 'danger'}>{x.ok ? t('in orde', 'intact') : t('afwijking', 'deviation')}</Badge>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
