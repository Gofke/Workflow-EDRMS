import { Fragment, useEffect, useState } from 'react';
import {
  CapturedDocumentView,
  DocumentTextView,
  DraftInput,
  ItemView,
  PossibleDuplicate,
  api,
} from '../api';

const DIRECTIONS = [
  { code: 'INCOMING', label: 'Incoming' },
  { code: 'OUTGOING', label: 'Outgoing' },
  { code: 'INTERNAL', label: 'Internal' },
];

const EMPTY: DraftInput = { direction: 'INCOMING', subject: '', party: '', documentDate: '' };

const REASON_LABEL: Record<string, string> = {
  IDENTICAL_DOCUMENT: 'the same document',
  SAME_SUBJECT_AND_PARTY: 'the same subject and party',
};

/**
 * The registration confirmation, with any possible duplicates named in it
 * (FR-COR-016). Advisory: the question stays "register?", never "merge?", and
 * cancelling is the user's choice, not the system's.
 */
export function registrationPrompt(
  item: ItemView,
  duplicates: PossibleDuplicate[] | null,
): string {
  const base = `Register "${item.subject}" as an official record? This cannot be undone.`;
  if (duplicates === null) {
    return `${base}\n\n(The check for possible duplicates could not be run.)`;
  }
  if (duplicates.length === 0) return base;
  const lines = duplicates.map(
    (d) =>
      `• ${d.registrationIdentity} — "${d.subject}" (${d.reasons.map((r) => REASON_LABEL[r] ?? r).join(' and ')})`,
  );
  return (
    `Possible duplicate${duplicates.length === 1 ? '' : 's'} already registered:\n` +
    `${lines.join('\n')}\n\n` +
    `Registering creates a separate record. Nothing is merged or changed.\n\n${base}`
  );
}

/**
 * Correspondence registration.
 *
 * A draft and a registered record are shown as visibly different things: a
 * draft has no reference and is labelled as preparatory, a registered record
 * carries its official reference and its server registration time. Nothing in
 * this screen lets a user type either of those two values.
 */
export function RecordsPage() {
  const [items, setItems] = useState<ItemView[]>([]);
  const [draft, setDraft] = useState<DraftInput>(EMPTY);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Record<string, CapturedDocumentView[]>>({});
  const [texts, setTexts] = useState<Record<string, DocumentTextView>>({});

  const loadDocuments = async (itemId: string) => {
    const captured = await api.documentsFor(itemId);
    setDocuments((current) => ({ ...current, [itemId]: captured }));
  };

  /**
   * FR-COR-015: text read from a scan, shown as an aid to finding the
   * document — never in its place. The document itself stays one click away
   * above, and the panel says where the words came from.
   */
  const toggleText = async (itemId: string, documentId: string) => {
    if (texts[documentId]) {
      setTexts((current) => {
        const next = { ...current };
        delete next[documentId];
        return next;
      });
      return;
    }
    try {
      const text = await api.documentText(itemId, documentId);
      setTexts((current) => ({ ...current, [documentId]: text }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The text could not be loaded.');
    }
  };

  const reload = () =>
    api
      .records()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load records.'));

  useEffect(() => {
    void reload();
  }, []);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setMessage(null);
    setError(null);
    try {
      await action();
      setMessage(done);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action could not be completed.');
    }
  };

  const save = () =>
    run(async () => {
      await api.createDraft({
        direction: draft.direction,
        subject: draft.subject,
        party: draft.party || undefined,
        documentDate: draft.documentDate || undefined,
      });
      setDraft(EMPTY);
    }, 'Draft saved. It is not an official record until you register it.');

  const register = (item: ItemView) =>
    run(async () => {
      // The warning is optional; registration is not. A failed check is said,
      // not allowed to block.
      const duplicates = await api.possibleDuplicates(item.id).catch(() => null);
      if (!window.confirm(registrationPrompt(item, duplicates))) {
        throw new Error('Cancelled.');
      }
      await api.register(item.id, item.version);
    }, 'Registered. The system has assigned the official reference.');

  return (
    <section>
      <h2>Correspondence</h2>
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="card inline">
        <h3>Prepare a new item</h3>
        <label htmlFor="direction">Direction</label>
        <select
          id="direction"
          value={draft.direction}
          onChange={(e) => setDraft({ ...draft, direction: e.target.value })}
        >
          {DIRECTIONS.map((d) => (
            <option key={d.code} value={d.code}>{d.label}</option>
          ))}
        </select>

        <label htmlFor="subject">Subject</label>
        <input
          id="subject"
          value={draft.subject}
          onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
        />

        <label htmlFor="party">Sender or addressee</label>
        <input
          id="party"
          value={draft.party ?? ''}
          onChange={(e) => setDraft({ ...draft, party: e.target.value })}
        />

        <label htmlFor="documentDate">Date on the document</label>
        <input
          id="documentDate"
          type="date"
          value={draft.documentDate ?? ''}
          onChange={(e) => setDraft({ ...draft, documentDate: e.target.value })}
        />
        <p className="footnote">
          This is the date written on the document itself. The registration date is set by the
          system when you register the item, and cannot be typed in.
        </p>

        <button type="button" className="primary" onClick={save}>Save as draft</button>
      </div>

      <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th>Official reference</th>
            <th>State</th>
            <th>Direction</th>
            <th>Subject</th>
            <th>Sender / addressee</th>
            <th>Document date</th>
            <th>Registered (server time)</th>
            <th>Prepared by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td colSpan={9} className="muted">No items yet.</td></tr>
          )}
          {items.map((item) => (
            <Fragment key={item.id}>
            <tr>
              <td className="mono">{item.registrationIdentity ?? '—'}</td>
              <td>
                <span className={item.state === 'REGISTERED' ? 'tag official' : 'tag draft'}>
                  {item.state === 'REGISTERED' ? 'Official record' : 'Draft — not official'}
                </span>
              </td>
              <td>{item.direction.charAt(0) + item.direction.slice(1).toLowerCase()}</td>
              <td>{item.subject}</td>
              <td>{item.party ?? '—'}</td>
              <td className="mono">{item.documentDate ?? '—'}</td>
              <td className="mono">
                {item.registeredAt ? new Date(item.registeredAt).toLocaleString('en-GB') : '—'}
              </td>
              <td>{item.createdByName}</td>
              <td>
                {item.state === 'DRAFT' && (
                  <button type="button" className="secondary small" onClick={() => register(item)}>
                    Register
                  </button>
                )}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    if (documents[item.id]) {
                      setDocuments((current) => {
                        const next = { ...current };
                        delete next[item.id];
                        return next;
                      });
                      return;
                    }
                    void loadDocuments(item.id);
                  }}
                >
                  {documents[item.id] ? 'Hide documents' : 'Documents'}
                </button>

              </td>
            </tr>
            {/* The panel needs the full width of the table: inside the action
                cell it was squeezed into one narrow column and clipped its own
                text. */}
            {documents[item.id] && (
              <tr className="documents-row">
                <td colSpan={9}>
                  <div className="documents">
                    {documents[item.id].length === 0 && (
                      <p className="muted small-text">No document captured yet.</p>
                    )}
                    <ul>
                      {documents[item.id].map((doc) => (
                        <li key={doc.id}>
                          <a href={api.documentContentUrl(item.id, doc.id)}>
                            {doc.originalFilename}
                          </a>{' '}
                          <span className="footnote">
                            {Math.max(1, Math.round(doc.byteSize / 1024))} kB, captured by{' '}
                            {doc.capturedByName} on{' '}
                            {new Date(doc.capturedAt).toLocaleString('en-GB')}
                          </span>
                          {/* The integrity reference, shown so a reviewer can
                              see that one exists and compare it if needed. */}
                          <div className="footnote mono">
                            SHA-256 {doc.contentHash.slice(0, 16)}…
                          </div>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => void toggleText(item.id, doc.id)}
                          >
                            {texts[doc.id] ? 'Hide read text' : 'Read text (OCR)'}
                          </button>
                          {texts[doc.id] && (
                            <div className="document-text">
                              {texts[doc.id].status === 'EXTRACTED' ? (
                                <>
                                  <p className="footnote">
                                    Read from the scan by {texts[doc.id].engine} — an aid to finding
                                    this document, not the document itself. The captured document
                                    above is the record.
                                  </p>
                                  {texts[doc.id].stale && (
                                    <p className="error" role="alert">
                                      This text was read from different content and may not describe
                                      the document above.
                                    </p>
                                  )}
                                  <pre className="small-text">{texts[doc.id].text}</pre>
                                </>
                              ) : (
                                <p className="footnote">
                                  {texts[doc.id].status === 'EMPTY' &&
                                    (doc.mediaType === 'application/pdf'
                                      ? 'This PDF carries no text layer, so it is probably a scanned page. Reading the page image inside a PDF is not built yet.'
                                      : 'The page was read and no text was found.')}
                                  {texts[doc.id].status === 'FAILED' &&
                                    'The text could not be read. The document itself is unaffected.'}
                                  {texts[doc.id].status === 'SKIPPED' &&
                                    'No text was read from this document.'}
                                </p>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    <label htmlFor={`file-${item.id}`} className="visually-hidden">
                      Document to capture
                    </label>
                    <input
                      id={`file-${item.id}`}
                      type="file"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        await run(async () => {
                          await api.captureDocument(item.id, file);
                          await loadDocuments(item.id);
                        }, `Captured ${file.name}.`);
                      }}
                    />
                    <p className="footnote">
                      A new capture is added alongside the existing ones. Captured content is never
                      replaced or deleted.
                    </p>
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
