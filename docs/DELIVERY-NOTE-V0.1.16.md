# JusPol EDRMS — Delivery Note V0.1.16

**Slice:** OCR text as retrieval assistance (FR-COR-015, CONDITIONAL; FS-08 AP-07)
**Gate:** None closes here. Side branch, alongside the Gate 1–3 testing round.
**Builds on:** V0.1.1 to V0.1.15, all protected baseline
**Date:** September 2026

---

## 1. Scope

Delivered, and **off by default**: when `OCR_ENABLED=true`, text is read from a captured image after the capture is committed, stored apart from the document, and offered through `GET /api/records/:itemId/documents/:documentId/text`. The screen shows it under "Read text (OCR)" with the engine named and the document itself still one click away.

Four outcomes are recorded, and they are different things:

| Status | Meaning |
|---|---|
| EXTRACTED | The engine read text. |
| EMPTY | The engine ran and found nothing readable. |
| SKIPPED | Not attempted: OCR off, or a type not configured for reading. |
| FAILED | The engine errored or ran out of time. The capture was unaffected. |

"Read and nothing found" and "nobody looked" must not look alike to someone deciding whether to open the scan.

Not in this version: **PDF text.** The configured types are images. A text-layer PDF needs a different tool (extraction, not OCR) and a scanned PDF needs a page-rasterising step. Both are a further decision, and most pilot scans are PDFs — so expect this to come up.

Also not in this version: search over the text (Gate 5, waits on DEC-02), re-extraction of existing documents, and any use of the text in the timeline or the duplicate warning.

## 2. The property that matters: derived, never authoritative

FR-COR-015 exists to prevent one failure — OCR output standing in for the captured content. Four things hold it:

1. **A separate table.** `document_text` references the document; nothing writes to `captured_document`, which is append-only anyway. No code path can put machine-read text where the evidence is.
2. **The hash it was read from** is stored with the text. If it ever differs from the document's current hash, the API reports `stale: true` and the screen warns.
3. **Derived in the response and on the screen.** `derived: true` on every reply; the panel says the text is an aid to finding the document, not the document.
4. **After the capture, never inside it.** A document is captured evidence whether or not a machine can read it, so OCR runs once the capture is committed. An engine that fails or hangs cannot fail or roll back a capture.

The engine gets a temporary copy of the bytes, not the stored file. Arguments are passed as a list, never a shell string, so a filename cannot become a command. The call is time-boxed.

## 3. Verification status

**Suite: 182 integration tests (fourteen spec files) and 36 component tests**, all passing on a schema rebuilt from empty. 8 integration and 3 component tests are new.

The suite drives a **stub engine** with tesseract's interface (`backend/test/fixtures/fake-ocr.sh`), so running the tests does not require an OCR engine wherever they run, and unreadable, failing and hanging engines can all be exercised.

**Live run with real Tesseract**, separately, against a migrated and seeded database with `OCR_ENABLED=true`: a generated scan of "MINISTERIE VAN JUSTITIE EN POLITIE / Inzageverzoek dossier 44" was captured, read back correctly as `tesseract (eng)`, and the retrieved document bytes hashed identically to the file that went in.

**Mutation testing — four properties, all caught**

| Mutation | Result |
|---|---|
| An OCR failure allowed to fail the capture | `✕ captures the document even when the engine fails…`, plus one |
| Staleness never reported | `✕ marks text stale when it no longer matches the document…` |
| Empty output reported as read text | `✕ records an unreadable page as read-but-empty, not as absent` |
| Engine time limit removed | `✕ captures the document even when the engine hangs past its time limit` |

## 4. Not verified, and open items

1. **No Dutch language data.** The default is `eng`. Suriname's correspondence is Dutch; `OCR_LANGUAGES=nld` needs the Dutch data pack installed (`tesseract-ocr-nld`). Untested here.
2. **No accuracy measurement.** One clean generated image was read correctly. Real scans — skewed, stamped, handwritten annotations — have not been tried, and OCR accuracy on them is unknown.
3. **No permission filtering** on the text, same as everything else pre-Gate 4. Text is record content and must go through FR-SEC-003 when it exists.
4. **OCR runs in the request**, after the capture commits, so a slow engine makes a capture feel slow up to the timeout. At pilot volumes this is acceptable; a queue is the answer if it is not.
5. **No browser walk-through** of the text panel.
6. **Enabling OCR is an operational decision** for whoever runs the pilot server: an engine must be installed and kept patched.

## 5. Slice size

Approximately **700 lines** — backend 320, frontend 130, tests 250.

## 6. Suggested commit message

```
V0.1.16 — OCR text as retrieval assistance (FR-COR-015), off by default

Text read from captured images after the capture commits, stored in its own
table with the hash it was read from, and always presented as derived. A
failing, empty or hanging engine never affects the captured document. Images
only; PDF text is a separate decision. Tests drive a stub engine; verified
live against tesseract.
```
