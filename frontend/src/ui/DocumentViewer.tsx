import { Download, FileText, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';
import { bytes, dateTime } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { Badge, ErrorNote, Loading } from './index';

export interface DocumentRow {
  id: string;
  originalFilename: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  capturedByName: string;
  capturedAt: string;
}

interface DerivedText {
  status: 'EXTRACTED' | 'EMPTY' | 'SKIPPED' | 'FAILED';
  text: string | null;
  engine?: string | null;
  method?: string | null;
  stale?: boolean;
}

/** The documents of a letter, with a preview drawn in the page and the text read from it. */
export function DocumentViewer({ itemId, documents }: { itemId: string; documents: DocumentRow[] }) {
  const { t, language } = usePrefs();
  const [selected, setSelected] = useState<string | null>(documents[0]?.id ?? null);
  const [view, setView] = useState<'preview' | 'text'>('preview');
  const doc = documents.find((d) => d.id === selected) ?? documents[0];
  useEffect(() => {
    if (!selected && documents[0]) setSelected(documents[0].id);
  }, [documents, selected]);
  if (!doc) return <p className="muted">{t('Er is nog geen document toegevoegd.', 'No document has been added yet.')}</p>;
  return (
    <div className="stack">
      {documents.length > 1 && (
        <div className="doc-list" role="list">
          {documents.map((d) => (
            <button key={d.id} type="button" className="doc-row" aria-pressed={d.id === doc.id} onClick={() => setSelected(d.id)}>
              <FileText size={18} aria-hidden="true" />
              <span className="grow">
                <strong>{d.originalFilename}</strong>
                <br />
                <span className="xs muted">
                  {bytes(d.byteSize)}, {dateTime(d.capturedAt, language)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="row between">
        <div className="segmented" role="group" aria-label={t('Weergave', 'View')}>
          <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>
            {t('Document', 'Document')}
          </button>
          <button type="button" aria-pressed={view === 'text'} onClick={() => setView('text')}>
            {t('Gelezen tekst', 'Text read')}
          </button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <VerifyButton itemId={itemId} documentId={doc.id} />
          <button type="button" className="btn sm ghost" onClick={() => void api.download(`/api/records/${itemId}/documents/${doc.id}/content`, doc.originalFilename)}>
            <Download size={16} /> {t('Downloaden', 'Download')}
          </button>
        </div>
      </div>
      {view === 'preview' ? <Preview key={doc.id} itemId={itemId} doc={doc} /> : <TextView key={doc.id} itemId={itemId} doc={doc} />}
      <p className="xs faint">
        {doc.originalFilename}, {bytes(doc.byteSize)}, {t('vastgelegd door', 'captured by')} {doc.capturedByName}. SHA-256 {doc.contentHash.slice(0, 16)}…
      </p>
    </div>
  );
}

function VerifyButton({ itemId, documentId }: { itemId: string; documentId: string }) {
  const { t } = usePrefs();
  const [result, setResult] = useState<boolean | null>(null);
  useEffect(() => setResult(null), [documentId]);
  const check = async () => {
    const r = await api.get<{ intact: boolean }>(`/api/records/${itemId}/documents/${documentId}/verify`).catch(() => ({ intact: false }));
    setResult(r.intact);
  };
  if (result !== null) return <Badge tone={result ? 'ok' : 'danger'}>{result ? t('Ongewijzigd sinds vastlegging', 'Unchanged since capture') : t('Afwijking: het bestand is gewijzigd of beschadigd', 'Mismatch: the file was altered or damaged')}</Badge>;
  return (
    <button type="button" className="btn sm ghost" onClick={() => void check()}>
      <ShieldCheck size={16} /> {t('Controleren', 'Verify')}
    </button>
  );
}

function Preview({ itemId, doc }: { itemId: string; doc: DocumentRow }) {
  const { t } = usePrefs();
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const previewable = ['application/pdf', 'image/jpeg', 'image/png'].includes(doc.mediaType);

  useEffect(() => {
    if (!previewable) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const blob = await api.blob(`/api/records/${itemId}/documents/${doc.id}/preview`);
        if (doc.mediaType !== 'application/pdf') {
          url = URL.createObjectURL(blob);
          if (!cancelled) setImageUrl(url);
          return;
        }
        const pdfjs = await import('pdfjs-dist');
        const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        const target = box.current;
        if (!target || cancelled) return;
        target.innerHTML = '';
        const width = Math.min(target.clientWidth - 28, 900);
        for (let n = 1; n <= Math.min(pdf.numPages, 12); n += 1) {
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const scale = (width / base.width) * (window.devicePixelRatio || 1);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${width}px`;
          canvas.setAttribute('aria-label', `${t('Pagina', 'Page')} ${n}`);
          target.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
          if (cancelled) return;
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [itemId, doc.id, doc.mediaType, previewable, t]);

  if (!previewable) return <p className="muted">{t('Dit type document kan niet in de browser worden getoond. Download het om het te openen.', 'This type of document cannot be shown in the browser. Download it to open it.')}</p>;
  return (
    <>
      <ErrorNote error={error} />
      {loading && <Loading lines={4} />}
      <div className="doc-viewer" ref={box} aria-label={t('Voorbeeld van het document', 'Document preview')}>
        {imageUrl && <img src={imageUrl} alt={doc.originalFilename} />}
      </div>
    </>
  );
}

/** Derived text: an aid for finding, never the record itself. */
function TextView({ itemId, doc }: { itemId: string; doc: DocumentRow }) {
  const { t } = usePrefs();
  const [text, setText] = useState<DerivedText | null>(null);
  useEffect(() => {
    api.get<DerivedText>(`/api/records/${itemId}/documents/${doc.id}/text`).then(setText).catch(() => setText({ status: 'FAILED', text: null }));
  }, [itemId, doc.id]);
  if (!text) return <Loading />;
  return (
    <div className="stack">
      <p className="small muted">
        {text.status === 'EXTRACTED'
          ? t(`${readHow(text, 'nl')} Dit is een hulpmiddel om te zoeken; het document zelf blijft het stuk.`, `${readHow(text, 'en')} It helps with finding; the document itself remains the record.`)
          : text.status === 'EMPTY'
            ? t('Het document is gelezen, maar er is geen tekst in gevonden.', 'The document was read, but no text was found in it.')
            : text.status === 'SKIPPED'
              ? t('De tekst van dit document is niet gelezen.', 'The text of this document was not read.')
              : t('Het lezen van de tekst is mislukt. Het document zelf is niet aangetast.', 'Reading the text failed. The document itself is unaffected.')}
      </p>
      {text.stale && <div className="notice warn small">{t('Deze tekst hoort bij een eerdere versie van het bestand.', 'This text belongs to an earlier version of the file.')}</div>}
      {text.text && <div className="letter-text small" style={{ maxHeight: 520, overflowY: 'auto', maxWidth: 'none' }}>{text.text}</div>}
    </div>
  );
}

/** How the text was read, in words: "Tekst herkend uit de scan (Nederlands en Engels, 1 pagina)." */
function readHow(text: { method?: string | null; engine?: string | null }, lang: 'nl' | 'en'): string {
  const ocr = Boolean(text.method?.includes('OCR') || /tesseract/i.test(text.engine ?? ''));
  const pages = Number(/(\d+) page/.exec(text.engine ?? '')?.[1] ?? 0);
  const langs = /\((nld|eng)(\+(nld|eng))?\)/.exec(text.engine ?? '') ? (lang === 'en' ? 'Dutch and English' : 'Nederlands en Engels') : '';
  const pageText = pages ? (lang === 'en' ? `${pages} page${pages === 1 ? '' : 's'}` : `${pages} ${pages === 1 ? 'pagina' : "pagina's"}`) : '';
  const detail = [langs, pageText].filter(Boolean).join(', ');
  if (ocr) return lang === 'en' ? `Text recognised from the scan or photo${detail ? ` (${detail})` : ''}.` : `Tekst automatisch herkend uit de scan of foto${detail ? ` (${detail})` : ''}.`;
  return lang === 'en' ? 'Text taken from the document itself.' : 'Tekst overgenomen uit het document zelf.';
}
