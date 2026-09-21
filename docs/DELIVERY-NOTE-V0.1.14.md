# JusPol EDRMS — Delivery Note V0.1.14

**Slice:** Timeline paging and CSV export (open items 3 and 4 of the V0.1.12 note)
**Gate:** None closes here. Side branch, alongside the Gate 1–3 testing round.
**Builds on:** V0.1.1 to V0.1.13, all protected baseline
**Date:** September 2026

---

## 1. Scope

Delivered:

- `GET /api/dossiers/:id/timeline/page?limit=&cursor=` — one page of the account, oldest first, with the total and a cursor for the next page. Default 50, maximum 200.
- `GET /api/dossiers/:id/timeline/export` — the whole account as a CSV file.
- The timeline panel reads a page at a time ("Show more (n of total)") and offers "Download as CSV".

Unchanged: `GET /api/dossiers/:id/timeline` still returns the whole account in one read. The Gate 3 pack and V0.1.12's tests rely on it.

Not in this version: **PDF export.** No PDF library is in the dependencies and adding one is a separate decision. The CSV opens in Excel; a PDF can follow if the Ministry needs one.

## 2. Why cursor paging, not page numbers

The history does not only grow at the end. Filing an older record brings its earlier registration and document captures into the *middle* of the account. With page numbers, that shifts entries, and one entry gets served on two pages.

The cursor is the position of the last entry read: (time, source, row id). The server serves only entries after it, so no entry is ever served twice. Entries that arrive *behind* the reader are not silently lost: every page carries the current total, and the panel says so in plain words ("This history gained 2 entries while you were reading…") and offers to read again from the start.

The row id is a new tie-breaker in the ordering. Two entries at the same server time and source now have a fixed order, which paging needs. The unpaged endpoint gets the same tie-breaker; it changes nothing observable except that ties are now stable.

The cursor comes from the client, so it is validated: a forged or damaged cursor is refused with 400, not interpreted.

## 3. Export

- **What it says:** exactly the entries of the unpaged timeline, in the same order, plus five provenance lines: dossier, subject, who exported, when (UTC, server time), entry count.
- **CSV injection:** a field starting with `=`, `+`, `-`, `@`, tab or carriage return gets an apostrophe in front, so a reason typed into the system cannot run as a spreadsheet formula. The apostrophe is visible on purpose — the export must not quietly differ from the record. Verified live with `=cmd|' /C calc'!A0` as a closure reason.
- **Recorded:** reading on screen writes nothing, but an export hands the account to someone outside the system, so it writes one `TIMELINE_EXPORTED` audit event (who, which matter, how many entries). Nothing about the matter changes.
- **UTF-8 with BOM**, so Excel shows names and accented text correctly.

## 4. Also fixed

The build version was stale in two places: `/api/health` reported `0.1.1` and the startup log said `v0.1.4`. Both now read one constant, `backend/src/version.ts`. The Developer Guide tells a new developer to check `/api/health`, so this mattered.

## 5. Verification status

**Suite: 167 integration tests (twelve spec files) and 28 component tests**, all passing on a schema rebuilt from empty. 10 integration and 3 component tests are new.

**Mutation testing — five properties, all caught**

| Mutation | Result |
|---|---|
| Formula neutralisation removed | `✕ neutralises a reason that a spreadsheet would run as a formula` |
| Export not audited | `✕ records the export, and nothing else` |
| Cursor ignored (every page starts at the beginning) | `✕ serves the same account page by page…`, plus six |
| Cursor compares time only (ties re-served) | `✕ serves the same account page by page…` and `✕ never serves an entry twice…` |
| Page-size cap removed | `✕ clamps a client-supplied page size` |

The cap mutation first **survived**: no test built a matter with more than 200 entries. The clamp is now a small exported function with its own test.

**Live smoke run** against a migrated, seeded development database: health reports 0.1.14; a matter taken through submit, approve, finalise and close; a change to the closed matter refused with the closure sentence; the paged endpoint served 2 of 5; the export downloaded with the right headers and neutralised the payload.

**Three existing component tests changed, intentionally.** The panel now reads through the paged endpoint, so the V0.1.12 tests mock `timelinePage` instead of `timeline`. Their assertions are unchanged.

## 6. Not verified, and open items

1. **No browser walk-through** of Show more, the growth notice or the download link.
2. **Export has no permission filtering** — same gap as the timeline (FR-DOS-009, waits on DEC-02), and more serious here, because an export leaves the system. When the FR-SEC-003 evaluator exists, the export must go through it before anything else.
3. **No PDF export** (see §1).
4. Unchanged: three overlapping history views; no CI runner; HTTPS not exercised.

## 7. Slice size

Approximately **650 lines** — backend 260, frontend 170, tests 220.

## 8. Suggested commit message

```
V0.1.14 — timeline paging and CSV export

Cursor paging on (time, source, row): no entry is served twice, and the
total tells the reader when an older record filed mid-read grew the account
behind them. CSV export of the whole account with provenance lines,
formula-neutralised fields and one TIMELINE_EXPORTED audit event. The
unpaged endpoint is unchanged. /api/health now reports the real build version.
```
