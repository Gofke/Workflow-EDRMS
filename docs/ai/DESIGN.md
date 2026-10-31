# AI assistant (Gemini) — design

| | |
|---|---|
| Product | JusPol EDRMS V0.4.0, "Vraag de assistent" |
| Follows | AI Assistant Implementation Guide (where it differs from a default, the guide wins) |
| Business document | [BUSINESS-DOCUMENT.md](BUSINESS-DOCUMENT.md) |
| Code | `backend/src/ai/agent/`, `frontend/src/shell/ChatPanel.tsx`, `frontend/src/lib/markdown.tsx` |

## 1. Shape

```
browser panel ──POST /api/v1/ai/query──▶ gate (origin, per-address limit, body size)
                                          ▶ session + role guard
                                          ▶ validation (question, history, lang, page)
                                          ▶ hourly quota per person
                                          ▶ AI loop ──▶ provider adapter ──▶ Gemini (or other)
                                               │  ▲
                                               ▼  │ metadata only
                                          read-only tools ──▶ PostgreSQL
                                               │   (permission predicates + line of command)
                                               └──▶ cards for the panel (full detail, never to the model)
                                          ▶ audit event + usage row (no question text)
                                          ▶ JSON {success, message, data}
```

The built-in engine (V0.3.0) stays: it answers when no model is configured, when the
model cannot answer (fallback), and for requests that propose changes (a task, tasks from
meeting notes) so that the person's text stays on the server and nothing happens without
confirmation.

## 2. Roles, line of command and tools

### 2.1 Line of command (`AccessService.lineScope`)

| Person | Line |
|---|---|
| Minister, Records manager | whole ministry |
| Head of a unit (`organisational_unit.head_account_id`) | that unit and every unit below it |
| Directeur / Onder-Directeur heading no unit | own unit and below |
| Anyone else | own unit |
| Stand-in (active out-of-office) | also the absent person's line, on top of their own |
| Always | records the person is involved in (created, responsible, task, advice, review, granted access) |

The line narrows what the assistant reports; it never widens what a person may see. Every
tool query applies both the record permission predicates (`dossierPredicate`,
`itemPredicate`, `TasksService.visibility` — the single source of truth used by the
screens) **and** the line predicates.

Unit kinds: `CABINET` → `DIRECTORATE` → `SUB_DIRECTORATE` (new in V0.4.0) → `DEPARTMENT`
(also `SERVICE`, `OFFICE`, `DISTRICT`).

### 2.2 Tool matrix (layer 2: the model only sees the tools of the role)

| Tool | Minister | Directeur | Onder-Dir. | Staff | Records mgr | Auditor | Sys admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `help_articles` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `my_work` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `find_record` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `list_records` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `count_records` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `deadline_risk` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `org_structure` | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ |
| `summarise_record` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `draft_reply` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `retention_overview` | | | | | ✓ | | |
| `audit_overview` | | | | | | ✓ | |
| `system_status` | | | | | | | ✓ |

Layer 3: `runTool` checks the role again before every call; an unknown tool or a tool
outside the role returns `{error}`. Layer 4: results are minimal (below).

All tools are read-only. `summarise_record` and `draft_reply` run the built-in engine on
the server and show the result as a card; nothing is saved or sent.

### 2.3 Tool results

- Lists are capped at 10; the true `total` is always given, with a note when capped.
- Confidential and secret records are left out of every count, group and list the model
  receives — also under a filter — so nothing about them (not even "one is overdue") reaches
  it. The person sees them in the cards, and a note card says how many were left out.
  A record looked up by its number appears only as `restricted`; an open page with a
  confidential record is named only as "a restricted letter/matter".
- No match: `{found: false}` — existence is never confirmed without access.
- Not allowed: `{error: "…"}` (outside the line, outside the role).
- A record visible on screen but outside the line: `{found: true, outsideYourLine: true, ref, link}`.
- Counts per unit mark groups outside the line (`outsideYourLine`), with `inYourLine` and
  `involvedOutsideYourLine` totals over all groups (at most 25 groups are listed).
- A person outside the line is simply `{found: false}`; a unit outside it is refused (the
  organisation chart is public); an ambiguous unit or person returns the candidates.
- Periods (`today`, `this_week`, `last_month`, …) are computed by the server in Suriname time.

## 3. Data classes (what may reach the model)

| Class | Examples | Free Gemini | Paid / own server (`dataPolicy = records`) |
|---|---|:-:|:-:|
| Public | help articles, page names | ✓ | ✓ |
| Internal metadata | registration numbers, statuses, dates, deadlines, working days, counts, unit names | ✓ | ✓ |
| Staff names and job titles | handler, unit head, people in a unit (within the line) | ✓ | ✓ |
| Record content | subjects, senders, document text, task titles, summaries, drafts | ✗ (cards only) | open/internal subjects only |
| Confidential / secret | any field beyond "restricted" | ✗ | ✗ |
| Personal data typed by the person | phone numbers, e-mail, ID and account numbers | removed (`redact`) | removed |

`agentConfig` forces `metadata` for any free-tier model outside the ministry network
(Gemini or another external provider), whatever the setting. "Inside the network" is
decided by parsing the address: localhost, a private IPv4 address or an intranet name. The older
text features (`AiService.model`) follow the same policy: no record text to an external
model under `metadata`.

Free-tier terms (Gemini API Additional Terms, last updated 28 April 2026, checked 31 October
2026): content sent to unpaid services may be used to improve Google products and may be read
by human reviewers; sensitive, confidential or personal information must not be submitted.

## 4. Provider adapter

`ChatModel.generate(request) → {text, calls, raw, model, inputTokens, outputTokens}`.

| Provider | Endpoint | Key |
|---|---|---|
| `gemini` | `POST {base}/models/{model}:generateContent` (`v1beta`), `functionDeclarations`, `toolConfig.functionCallingConfig.mode` AUTO / NONE | header `x-goog-api-key` |
| `openai-compatible`, `ollama` | `POST {base}/chat/completions` with `tools` | `Authorization: Bearer` (optional) |
| `anthropic` | `POST {base}/v1/messages` with `tools` | header `x-api-key` |

- The model's own turn is sent back unchanged (`raw`), so Gemini thought signatures are echoed.
- Tool results go back as a user turn with `functionResponse` parts.
- Errors map to one reason: 429/RESOURCE_EXHAUSTED → `free-limit`; 401/403/API key → `bad-key`;
  404/unknown model → `bad-model`; 5xx → `unavailable`; 408/504/timeout → `timeout`; other 4xx → `bad-request`.
- Fallback: the next model in `AI_FALLBACK_MODELS` (same provider and key, so the same tier)
  on `free-limit`, `rate-limit`, `unavailable`, `bad-model`. A paid model never falls back to
  a free one. After that, the built-in assistant answers (if `offlineFallback`), with a notice.
- Switching provider or model is settings or environment only.

## 5. The loop

- At most 6 rounds; the 6th is sent with tools switched off (`mode: NONE`), so the model must
  answer; still calling tools then → `too-many-steps`.
- At most 5 tool calls per round; extra calls get an error result.
- 30 s per model call, 80 s per question; Stop in the panel (request closed) aborts at once.
- A failing tool becomes an error result for the model, and a warning in the server log
  (tool name and error, never the question).

## 6. API contract

`POST /api/v1/ai/query`

```json
{ "question": "1–2000 chars", "history": [{"role": "user|assistant", "content": "…"}],
  "lang": "nl|en", "page": "/zaken/…", "conversationId": "uuid (optional)" }
```

History: at most 30 turns, `user` and `assistant` only (a `system` turn is refused), each
at most 8,000 characters. Unknown fields are refused.

Success `200`:

```json
{ "success": true, "message": "ok",
  "data": { "answer": "Markdown", "toolsUsed": ["count_records"], "cards": [...],
            "suggestions": [], "conversationId": "…", "messageId": "…",
            "engine": {"provider": "gemini", "model": "gemini-flash-latest", "offline": false, "local": false},
            "notice": null, "pending": null, "createdAt": "…" } }
```

Errors: `{ "success": false, "message": "…", "reason": "…" }`

| Status | reason |
|---|---|
| 400 | `invalid`, `too-long` |
| 401 | `signed-out` |
| 403 | `denied`, `origin`, `switched-off` |
| 413 | `too-large` |
| 429 | `rate-limit` (per person per hour, per address per minute), `free-limit` (provider) |
| 499 | `cancelled` |
| 502 | `unavailable`, `bad-request`, `too-many-steps` |
| 503 | `no-key`, `bad-key`, `bad-model` |
| 504 | `timeout` |

`GET /api/v1/health` → `{success, data: {env, version, ai: {state, provider, model}}}` (no secrets).
`GET /api/v1/ai/status` → what the panel shows for the signed-in person (model, limits, examples).
`GET /api/v1/ai/config` (system administrator) → effective configuration, which values the
server fixes, whether a key is present (never the key).

## 7. Settings and environment

Settings (`Beheer → Assistent`): `provider` (adds `gemini`), `model`, `fallbackModels`,
`dataPolicy` (`metadata` | `records`), `scope` (`work` | `broad`, default `broad`),
`hourlyLimit` (30), `offlineFallback` (true), feature `assistant`.

Environment (wins over settings; shown as fixed on the screen): `AI_PROVIDER`, `AI_MODEL`,
`AI_FALLBACK_MODELS`, `AI_API_KEY` (secret), `AI_BASE_URL`, `AI_TIER`, `AI_MAX_OUTPUT_TOKENS`,
`AI_CALL_TIMEOUT_MS`, `AI_TOTAL_TIMEOUT_MS`, `AI_HOURLY_LIMIT`, `AI_IP_LIMIT_PER_MINUTE`,
`ALLOWED_ORIGINS`, `APP_ENV`. Empty values count as not set.

## 8. Defences

| Threat | Defence |
|---|---|
| Seeing more than allowed | permission + line predicates inside every query; tool list per role; role check per call |
| Prompt injection (question, history, record text) | record text never reaches the model; rules live in code; the prompt marks tool output and user text as data; no `system` turns from the client |
| Leak to Google | metadata-only tool results; redaction of typed personal data; leak tests with planted marker text |
| Script in an answer | answers render as safe Markdown (React elements, no HTML); links only to `/…` or `https://` |
| Abuse / cost | per-person hourly quota, per-address limit, body size limit, round and time limits |
| Request from another site | origin check (`ALLOWED_ORIGINS`), session cookie `SameSite=Lax` |

## 9. Audit and history

- Hourly quota: a quota row is written, under a per-person lock, before any work starts,
  so parallel questions cannot overrun the limit.
- Audit event `AI_QUESTION_ANSWERED` / `AI_QUESTION_FAILED`: who (name, role), outcome or
  reason, tools used, model, tokens, duration, server time. Never the question or answer.
- `ai_interaction` (usage and quota): feature `assistant`, outcome, tools, tokens; the
  prompt summary holds only the tool names.
- The conversation itself is kept in `chat_message` for the person only (as in V0.3.0).

## 10. Tests

`backend/test/p4-assistant.spec.ts` (52) and `p4-assistant-units.spec.ts` (32),
`frontend/src/shell/ChatPanel.test.tsx` (11), `frontend/src/lib/markdown.test.tsx` (5),
`deploy/test-install.sh` (12).
Fakes only: a scripted model and a fake Gemini HTTP server; no real model, no real key.
See [EVALUATION.md](EVALUATION.md), [AUDIT.md](AUDIT.md) and the tester sheet.
