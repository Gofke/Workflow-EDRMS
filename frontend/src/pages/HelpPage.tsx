import { ArrowRight, Compass, MessageSquare, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useDebounced } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { useAssistant } from '../shell/context';
import { Empty, Loading, PageHead, Panel } from '../ui';

interface Article { id: string; link: string; nl: { title: string; body: string }; en: { title: string; body: string }; score?: number }

export default function HelpPage() {
  const { t, language } = usePrefs();
  const { business, ai } = useSession();
  const { ask } = useAssistant();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const { data } = useApi<Article[]>(dq.trim() ? `/api/ai/help?q=${encodeURIComponent(dq.trim())}` : '/api/ai/help');
  const [open, setOpen] = useState<string | null>(null);
  const text = (a: Article) => (language === 'en' ? a.en : a.nl);
  return (
    <>
      <PageHead
        title={t('Help', 'Help')}
        lead={t('Korte uitleg bij elk onderdeel. Dezelfde uitleg gebruikt de assistent als u in de chat vraagt “hoe doe ik…”.', 'Short explanations for every part. The assistant uses the same explanations when you ask “how do I…” in the chat.')}
        actions={
          business && (
            <button type="button" className="btn" onClick={() => window.dispatchEvent(new CustomEvent('juspol:tour'))}>
              <Compass size={16} /> {t('Rondleiding starten', 'Start the guided tour')}
            </button>
          )
        }
      />
      <div className="split">
        <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          <div className="topbar-search" style={{ maxWidth: 'none' }}>
            <Search size={18} aria-hidden="true" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Waarmee kunnen we helpen? Bijv. “brief registreren” of “vervanger instellen”', 'What can we help with? E.g. “register a letter” or “set a stand-in”')} aria-label={t('Zoeken in de help', 'Search the help')} />
          </div>
          <Panel flush>
            {!data ? (
              <Loading lines={6} />
            ) : data.length === 0 ? (
              <Empty title={t('Geen uitleg gevonden', 'No explanation found')}>{t('Probeer andere woorden, of stel de vraag aan de assistent.', 'Try other words, or ask the assistant.')}</Empty>
            ) : (
              <ul className="list help-list">
                {data.map((a) => (
                  <li key={a.id}>
                    <button type="button" className="help-q" aria-expanded={open === a.id || (!!dq.trim() && data[0].id === a.id && open === null)} onClick={() => setOpen(open === a.id ? '' : a.id)}>
                      {text(a).title}
                    </button>
                    {(open === a.id || (!!dq.trim() && data[0].id === a.id && open === null)) && (
                      <div className="help-a">
                        <p>{text(a).body}</p>
                        <Link to={a.link} className="small">
                          {t('Ga naar dit onderdeel', 'Go to this part')} <ArrowRight size={14} style={{ verticalAlign: '-2px' }} />
                        </Link>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          {business && ai('chat') && (
            <Panel title={t('Vraag het de assistent', 'Ask the assistant')}>
              <p className="small" style={{ marginTop: 0 }}>
                {t('Staat uw vraag er niet bij? De assistent rechtsboven beantwoordt vragen over het systeem en over uw eigen werk.', 'Is your question not listed? The assistant at the top right answers questions about the system and about your own work.')}
              </p>
              <button type="button" className="btn assist" onClick={() => ask(q.trim() || t('Hoe werkt het systeem?', 'How does the system work?'))}>
                <MessageSquare size={16} /> {t('Vraag stellen', 'Ask a question')}
              </button>
            </Panel>
          )}
          <Panel title={t('Sneltoetsen', 'Keyboard shortcuts')}>
            <dl className="kv-inline">
              <dt>
                <kbd>/</kbd>
              </dt>
              <dd>{t('Zoeken', 'Search')}</dd>
              <dt>
                <kbd>Tab</kbd>
              </dt>
              <dd>{t('Naar het volgende veld of de volgende knop', 'To the next field or button')}</dd>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>{t('Venster of menu sluiten', 'Close a window or menu')}</dd>
            </dl>
          </Panel>
          <Panel title={t('Hulp van een mens', 'Help from a person')}>
            <p className="small" style={{ margin: 0 }}>
              {t('Voor een account, wachtwoord of rol: de systeembeheerder. Voor archief en bewaartermijnen: de archiefbeheerder van Centrale Registratie en Archief.', 'For an account, password or role: the system administrator. For archive and retention: the records manager of Central Registry and Archive.')}
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
