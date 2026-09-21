import { useState } from 'react';
import { TimelineEntry, api } from '../api';

const PAGE_SIZE = 50;

/**
 * The matter read in order.
 *
 * Deliberately one plain list rather than a set of filters. The point of a
 * timeline is that someone picking up a matter can read what happened without
 * reconstructing it from several screens, so nothing here hides an entry by
 * default.
 *
 * V0.1.14: read a page at a time. Filing an older record adds entries in the
 * middle of the account, behind where the reader has got to. The server never
 * repeats an entry, and this panel says so plainly when the account has grown,
 * rather than letting the reader believe they have seen all of it.
 */
export function TimelinePanel({ dossierId }: { dossierId: string }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [firstTotal, setFirstTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEntries(null);
    setCursor(null);
    setTotal(0);
    setFirstTotal(0);
  };

  const loadFirst = async () => {
    setError(null);
    setLoading(true);
    try {
      const page = await api.timelinePage(dossierId, null, PAGE_SIZE);
      setEntries(page.entries);
      setCursor(page.nextCursor);
      setTotal(page.total);
      setFirstTotal(page.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The history could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!cursor || !entries) return;
    setError(null);
    setLoading(true);
    try {
      const page = await api.timelinePage(dossierId, cursor, PAGE_SIZE);
      setEntries([...entries, ...page.entries]);
      setCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The history could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  const grew = entries !== null && total > firstTotal;

  return (
    <div className="timeline">
      <button
        type="button"
        className="link-button"
        onClick={() => (entries ? reset() : void loadFirst())}
      >
        {entries ? 'Hide the full history' : 'Read the full history of this matter'}
      </button>

      {entries && (
        <a className="link-button" href={api.timelineExportUrl(dossierId)} download>
          Download as CSV
        </a>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      {grew && (
        <p className="footnote" role="status">
          This history gained {total - firstTotal} entr{total - firstTotal === 1 ? 'y' : 'ies'} while
          you were reading, some of them earlier than where you are.{' '}
          <button type="button" className="link-button" onClick={() => void loadFirst()}>
            Read it again from the start
          </button>
        </p>
      )}

      {entries && (
        <>
          <ol className="timeline-list">
            {entries.length === 0 && <li className="muted">Nothing has happened yet.</li>}
            {entries.map((entry, i) => (
              <li key={i}>
                <span className="mono timeline-when">
                  {new Date(entry.occurredAt).toLocaleString('en-GB')}
                </span>
                <span className="timeline-what">
                  <strong>{entry.headline}</strong>
                  <span className="footnote">
                    {' '}
                    — {entry.actorName}
                    {entry.onBehalfOfName ? `, on behalf of ${entry.onBehalfOfName}` : ''}
                  </span>
                  {entry.detail && <div className="footnote">{entry.detail}</div>}
                </span>
              </li>
            ))}
          </ol>
          {cursor && (
            <button
              type="button"
              className="secondary small"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              Show more ({entries.length} of {total})
            </button>
          )}
        </>
      )}
    </div>
  );
}
