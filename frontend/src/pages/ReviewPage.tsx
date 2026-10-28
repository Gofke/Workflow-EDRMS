import { Gavel, MessageCircleQuestion } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ago } from '../lib/format';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { Due, Empty, PageHead, Panel, Stamp } from '../ui';
import { TaskRow, TaskView } from '../ui/records';

export default function ReviewPage() {
  const { t, language } = usePrefs();
  const queue = useApi<{ dossierId: string; dossierIdentity: string; subject: string; submittedByName: string; submittedAt: string }[]>('/api/dossiers/review-queue');
  const advice = useApi<{ id: string; question: string; dueDate: string | null; dossierId: string; dossierIdentity: string; subject: string; requestedByName: string }[]>('/api/advice/mine');
  const checks = useApi<{ data: TaskView[] }>('/api/tasks?scope=owner&status=IN_REVIEW&limit=50');
  const standing = useApi<{ id: string; absentName: string; startsOn: string; endsOn: string; message: string | null }[]>('/api/out-of-office/standing-in');
  return (
    <>
      <PageHead title={t('Beoordelen', 'Review')} lead={t('Wat op uw oordeel wacht: besluiten over zaken, gevraagde adviezen en taken die u moet controleren.', 'What awaits your judgement: decisions on matters, advice requested of you and tasks you must check.')} />
      {(standing.data ?? []).length > 0 && (
        <div className="notice info" style={{ marginBottom: 18 }}>
          {t('U vervangt nu:', 'You are standing in for:')} {standing.data!.map((s) => s.absentName).join(', ')}.{' '}
          {t('Hun meldingen en beoordelingen komen ook bij u.', 'Their notifications and reviews also come to you.')}
        </div>
      )}
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Panel title={t('Zaken die op uw besluit wachten', 'Matters awaiting your decision')} flush>
          {(queue.data ?? []).length === 0 ? (
            <Empty title={t('Niets te beslissen', 'Nothing to decide')}>{t('Zaken die u ter beoordeling krijgen, verschijnen hier.', 'Matters submitted to you appear here.')}</Empty>
          ) : (
            <ul className="list">
              {queue.data!.map((r) => (
                <li key={r.dossierId}>
                  <Link to={`/zaken/${r.dossierId}?tab=besluit`} className="list-link">
                    <Gavel size={18} style={{ marginTop: 3, color: 'var(--warn)', flex: 'none' }} aria-hidden="true" />
                    <span className="grow stack" style={{ gap: 3 }}>
                      <span className="list-title">{r.subject}</span>
                      <span className="meta">
                        <Stamp value={r.dossierIdentity} />
                        <span>
                          {t('aangeboden door', 'submitted by')} {r.submittedByName}, {ago(r.submittedAt, language)}
                        </span>
                      </span>
                    </span>
                    <span className="btn sm primary">{t('Beoordelen', 'Review')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="grid-2">
          <Panel title={t('Om uw advies gevraagd', 'Your advice requested')} flush>
            {(advice.data ?? []).length === 0 ? (
              <p className="muted small" style={{ padding: '4px 20px 14px' }}>
                {t('Er wordt nu geen advies van u gevraagd.', 'No advice is requested of you now.')}
              </p>
            ) : (
              <ul className="list">
                {advice.data!.map((a) => (
                  <li key={a.id}>
                    <Link to={`/zaken/${a.dossierId}?tab=advies`} className="list-link">
                      <MessageCircleQuestion size={18} style={{ marginTop: 3, color: 'var(--info)', flex: 'none' }} aria-hidden="true" />
                      <span className="grow stack" style={{ gap: 3 }}>
                        <span className="list-title">{a.subject}</span>
                        <span className="small">{a.question}</span>
                        <span className="meta">
                          <Stamp value={a.dossierIdentity} /> {t('van', 'from')} {a.requestedByName}
                        </span>
                      </span>
                      <Due date={a.dueDate} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={t('Taken ter controle', 'Tasks to check')} flush>
            {(checks.data?.data ?? []).length === 0 ? (
              <p className="muted small" style={{ padding: '4px 20px 14px' }}>
                {t('Geen taken die op uw controle wachten.', 'No tasks waiting for your check.')}
              </p>
            ) : (
              <ul className="list">
                {checks.data!.data.map((task) => (
                  <li key={task.id}>
                    <TaskRow task={task} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
