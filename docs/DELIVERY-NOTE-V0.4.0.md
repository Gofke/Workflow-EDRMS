# Delivery note — JusPol EDRMS V0.4.0

Date: 31 October 2026

## What this delivery is

V0.4.0 adds **"Vraag de assistent"**: a chat panel like ChatGPT on every page of
the EDRMS, on Google Gemini (free tier first), that answers any question about
the work from the live data — but only what the person asking may see, within
their line of command:

| Who | The assistant answers about |
|---|---|
| Minister | the whole ministry |
| Directeur | the directorate and everything under it |
| Onder-Directeur | the sub-directorate and its departments |
| Head of department, employee | the department, plus what they are personally involved in |
| Records manager | archive and retention across the ministry |
| Auditor | audit and integrity figures, no record content |
| System administrator | accounts, jobs and settings, no record content |

The organisation now has sub-directorates (Minister → directorates →
sub-directorates → departments → employees). The demonstration ministry has two
directorates with four sub-directorates.

V0.3.0 (the merge of Workflow Task Management into the EDRMS) is unchanged
underneath; the two archives supplied were identical to the V0.3.0 source.

The feature document `JusPol-EDRMS-V0.4.0-Features.pdf` shows every feature on
the demonstration data; chapter 1 is the assistant.

## Built to the AI Assistant Implementation Guide

| Guide | Where |
|---|---|
| Business document, design (role → permission → tool, data classes) | `docs/ai/BUSINESS-DOCUMENT.md`, `docs/ai/DESIGN.md` |
| Security in code: middleware, tools per role, check inside every tool, minimal results | `backend/src/ai/agent/` |
| Provider adapter, error mapping, fallback, settings or environment only | `providers.ts`, `config.ts` |
| API contract, request lifecycle, limits | `POST /api/v1/ai/query`, `GET /api/v1/health` |
| Audit log without question text; audit document; scenarios AU-01…AU-35 | `docs/ai/AUDIT.md` |
| Tests with fakes only; evaluation set; tester sheet | `backend/test/p4-*`, `docs/ai/EVALUATION.md`, `docs/JusPol-EDRMS-V0.4.0-AI-Tester-Sheet.xlsx` |
| Linux deployment with rollback; environment separation | `deploy/install.sh`, `deploy/pack.sh`, `deploy/test-install.sh` |

## Evidence

| Check | Result |
|---|---|
| Backend integration tests (real PostgreSQL) | 379 of 379 pass (assistant: 84) |
| Frontend component tests | 40 of 40 pass |
| Installer, end to end with stubs | 12 of 12 pass |
| Leak tests | planted text in subjects, senders, task titles, a phone number and an injected instruction never reach the model, for every business role |
| Independent code review | 20 findings, all fixed and tested (below) |

The screenshots of the assistant were made in the test environment, which has
no Gemini key and no route to Google. A local stand-in that speaks the Gemini
interface worded the answers; the data, tools, permissions, cards, limits and
log are the real system's. With the ministry's key the wording comes from
Gemini itself.

## Independent review — findings and fixes

| Finding | Fix |
|---|---|
| A stand-in lost their own unit | The absent person's line is added to one's own |
| Summary and draft reply skipped the line check | Same check as the lists; outside the line only a link |
| Name look-up told whether someone exists outside the line | Simply "not found" |
| Confidential records could show up in counts or under a filter | Left out of everything the model receives; a note card tells the person |
| Number of a confidential record on screen went into the prompt | Named only as "a restricted letter/matter" |
| Tasks on confidential records in "my work" | Counted, never named to the model |
| Free-tier rule only for Gemini; look-alike public names counted as local | Every free external provider gets metadata only; addresses are parsed |
| Look-alike numbers escaped redaction | Only the system's own number formats are protected |
| Unit look-up and group totals could mislead | Line filter in the query; totals over all groups |
| Letter deadlines counted drafts | Registered letters only |
| Hourly quota could be overrun by parallel questions | Quota row written under a per-person lock before any work |
| Summary card showed no summary | Card shows the summary when the model answered |
| Stop, new chat and language change | A stopped question is not resent; a late answer never lands in a new chat; changing language does not stop a question |
| Installer: secrets on the command line, old port in nginx, migrations on rollback, install scripts as root | Builtins only for settings; site follows the port; database copy before each update and pointed to on rollback; `npm ci --ignore-scripts` |

## Decisions taken

- Free Gemini tier first; the free tier always gets **metadata only** (numbers,
  statuses, dates, deadlines, unit and handler names). Subjects, document text
  and confidential records are shown to the person in cards by the server and
  never sent out. Typed phone numbers, e-mail addresses and ID numbers are removed.
- Scope "broad" by default (the request was "ask anything"): general office
  questions are answered briefly; the ministry can narrow it to "work only".
- Requests that propose a change (create a task, tasks from notes) stay with the
  built-in engine and wait for confirmation; the model only reads.
- Records a person is involved in outside their line are included, and marked.
- Default model `gemini-flash-latest`, fallback `gemini-flash-lite-latest`, then
  the built-in offline assistant with a notice.

## For the ministry to decide

- Whether the free Gemini tier is acceptable (staff names and question wording
  reach Google), or a paid tier / a model on ministry hardware.
- Scope "broad" or "work only"; questions per hour (30).
- Server and address for staging and production (`deploy/install.sh`).

## Repositories

- **Workflow-EDRMS**: the Phase 3 work replayed on top of `main` (V0.0.2) as
  readable commits, then the V0.4.0 commits; branches `main` and `kiran` on the
  same commit; annotated tags `V0.3.0` and `V0.4.0` (existing `V0.0.1`, `V0.0.2`
  kept). No keys, stored documents or runtime data in the history.
- **Workflow-TaskManagement**: archive notice mapping each feature to its place
  in the EDRMS, the Firebase key no longer tracked, branches `main` and `kiran`,
  tag `V1.0.0`. The key remains in that repository's history and **must be
  revoked** in the Google Cloud console.

## Known limits

- Answers are worded by a language model and can be wrong; the panel says so and
  the tools give exact data. Run the evaluation set with the real key on staging
  before production.
- The free tier has per-minute and daily limits; then the fallback model and the
  built-in assistant answer.
- Gemini is a global service; the free tier offers no choice of data region.
