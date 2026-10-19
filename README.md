# unipus-mcp

U校园AI / **U听说**（U听力 + U口语）本机 stdio MCP。

## 范围

- 目标产品：手机 App「U听力」（包名 `cn.unipus.cloud`），**不是**网页课「261英语视听说」。
- 网关线索：`https://ucloud.unipus.cn/api/uls/*`（需 JWT）；SSO：`sso.unipus.cn`。
- 登录与密钥：本仓 `accounts/<id>/password`（0600）或 env `UNIPUS_PASSWORD_<id>` / `UNIPUS_PASSWORD` + CLI；**不强制 SecretSpec**；**不作为 MCP 工具参数**。

## MVP 工具

1. `auth_status` — 是否已有可用 JWT / SSO session
2. `list_week_progress` — 本周听力进度（如 x/5）与级别
2b. `list_accounts_progress` — 多账户周进度只读汇总（无调度）
3. `start_listening_training` — 开始训练 / loadPaper（返回 `instance_ids` 精确字符串）
4. `upload_answer_audio` / `submit_answer` / `save_snapshot`（听力口语位 S5） / `speak_and_submit` — 静默口语上传与提交
5. `grade_question` — `gradeQuestion` 评分（BigInt-safe instance id；CDN-only 常 0 分）
6. `score_speech` — Clio WSS `en.sent.score`（真实口语分；勿伪造）

`auth_status` 已接入：从 `UNIPUS_JWT` / `UNIPUS_JWT_FILE`（或 `~/.config/unipus-mcp/jwt`）读取 JWT，探活 `ucloud.unipus.cn/api/uls/`。
`list_week_progress` 默认读 `getUserStatusForApp`：听力和口语的本周计数是 `weekDoneTaskCount`，达标数是 `weekFrequency`。静默上传 / submit / grade 见 `docs/mcp.md` 与 `docs/api-notes.md`。

## 登录（env / 文件，永不作为工具参数）

```sh
export UNIPUS_JWT='eyJ...'          # 或
export UNIPUS_JWT_FILE=/path/to/jwt # 原始 JWT、jwt= cookie、或 portal JSON
```

不要把密码、JWT 写进 MCP 工具参数或聊天。

多账户：`~/.config/unipus-mcp/accounts/<id>/{jwt,rt}` + `active-account.txt`；JWT ~48h，优先 `npm run refresh-jwt`；切换 `npx tsx scripts/accounts.ts use <id>`。详见 `docs/mcp.md`「登录约定」。

## 开发

```sh
npm ci
npm run typecheck
npm run build
npm test
npm start --silent   # stdio MCP；勿关 stdin
```

## 挂到 Grok Bot（AddMcpServer 无 cwd）

必须用**绝对路径** launcher。详见 [docs/mcp.md](docs/mcp.md)。

推荐：

```json
{
  "command": "/ABS/PATH/TO/unipus-mcp/scripts/run-mcp.sh",
  "args": []
}
```

或：

```json
{
  "command": "npm",
  "args": ["start", "--silent", "--prefix", "/ABS/PATH/TO/unipus-mcp"]
}
```

本机仓库路径示例：`/workspace/unipus-mcp`。

## License

Private use for Sein / K4F7 unless stated otherwise.

## Weekly grind (harness)

`npx tsx scripts/weekly-grind.ts [--account <id>]… | --all [--listen-only|--speak-only]` — stateless multi-account listen/speak gap fill for AI harness routines. Per-account `meta.grind` (`both`|`listen`|`speak`, default both) plus CLI override; set via `accounts.ts grind <id> …`. `meta.usage` is `self` (no expiry) or `assist` with a persisted `expires_at`; expired assist accounts return `skipped_expired` and are not submitted. Both modes store `listen_per_week` and `speak_per_week` (`--listen` / `--speak`, 0–30, or `platform`). Unset follows `weekFrequency`; a number caps that side at `min(configured, weekFrequency)`. MCP still has no scheduler.

**Answers come only from the LLM — no template, no heuristic, no empty blank.** Set all three (no defaults, `SILICONFLOW_API_KEY` is not read):

```bash
export UNIPUS_LLM_BASE_URL=https://…/v1   # OpenAI-compatible
export UNIPUS_LLM_MODEL=…
export UNIPUS_LLM_API_KEY=…               # via env / SecretSpec, never in chat or logs
```

Any missing, or a one-request probe of the LLM fails → the account is `status=error` with `ANSWER_REFUSED` before login, placement or any submit. If the LLM fails (3 attempts) or returns an invalid option / empty blank / too-short speech, that paper (speak: that part and every later part) is not submitted and the account stops for this run (`ANSWER_REFUSED` in `errors`, status `error`, no next paper). 跟读 / 单词跟读 items without source text are refused the same way (no placeholder sentence).

Speak grind synthesises answer audio locally and silently: unset `UNIPUS_TTS_ENGINE` → macOS built-in `say` (always `say -o <file>`, never played aloud, then ffmpeg → 16 kHz mono s16 WAV), other platforms → Kokoro; `UNIPUS_TTS_ENGINE=kokoro|piper|say` overrides, `edge|flite|auto` are legacy. `npx tsx scripts/doctor.ts` prints a read-only self-check (ffmpeg, TTS engine for this platform, timeouts, results file).

stdout is JSONL: one `{"event":"paper",…}` line per paper as soon as it is done (`note`, `skill` 听/说, `taskId`, `ansVersion`, `score`, `scoreIsOut`, `status` = `ok|low_score|grading|failed|skipped_existing`, `error`; speak lines also carry `parts` = per-part `{partId, score, status: ok|pending|failed|error, words?, sec?}` from part-report and `flags` ⊆ `ai_report_missing|free_talk_below_80|free_talk_short`; accounts by note only), then a final `{"event":"summary",…}` line (per-account `note`, masked `account_id` like `139****5678`, `status`, `errors`, `error_class`, `totals`; phone numbers in error text are masked too). Paper lines are appended to `UNIPUS_RESULTS_FILE` (default `~/.config/unipus-mcp/results.jsonl`); the ledger is per account (taskIds are shared papers). When it says this account already submitted the current paper, App history decides: listed (or the history lookup fails) → `skipped_existing`, which is not a failure (the same paper offered again stops that skill); not listed → the ledger row is stale and the paper is answered. Failed lines are written every time; only submitted outcomes are deduplicated. Each built recording logs its step durations (`用时 TTS 合成 / Clio 评分 / mp3 转码 / 上传`). Exit 0 = any account succeeded/skipped, 1 = all targeted accounts errored, 2 = usage / no targets, 3 = stall watchdog (`{"event":"fatal","error_code":"STALL"}` after `UNIPUS_STALL_MINUTES`, default 15, without any log line or stage advance; 0 disables).

Timeouts and budgets run on active time: the wall clock minus process freezes (a heartbeat more than 15s late means the box VM was paused; that gap is logged as `[stall]` and not counted), so a freeze neither fires a deadline nor spends a retry budget, while a live but silent socket still times out on schedule (#100): `UNIPUS_ORAL_WS_TIMEOUT_MS` (oral WS no-data timeout, default 60000, reset by every frame), `UNIPUS_ORAL_WS_TURN_MAX_MS` (one dialog turn incl. reconnects, default 240000), `UNIPUS_HTTP_TIMEOUT_MS` (default 60000), `UNIPUS_UPLOAD_TIMEOUT_MS`, ffmpeg (60s hard kill; binary via `UNIPUS_FFMPEG_BIN`), and one Clio request (30s + 3× the audio length, 45s up to `UNIPUS_CLIO_MAX_MS`; `UNIPUS_CLIO_TIMEOUT_MS` pins a fixed value).

Speak/listen budgets (#92, all active time; `npx tsx scripts/doctor.ts` prints the effective values):

| env | default | meaning |
|---|---|---|
| `UNIPUS_SCORE_POLL_MS` / `UNIPUS_SCORE_MAX_MS` | 5000 / 180000 | after submit, poll App history until `scoreIsOut`, then write the final score to the JSONL (listen + speak) |
| `UNIPUS_AI_REPORT_POLL_MS` / `UNIPUS_AI_REPORT_MAX_MS` | 30000 / 600000 | speak: poll `part-report` for every part; still 500 at the end → `ai_report_missing` (`MAX=0` reads once) |
| `UNIPUS_TTS_RETRY_MAX_MS` | 600000 | total time for TTS/Clio/upload retries of one recording (≤4 attempts, backoff 3s→6s→12s, each failure logged with its stage; the wav is synthesised once) |
| `UNIPUS_CLIO_MAX_MS` | 360000 | cap on one Clio scoring request (Clio needs ≈2.2× the audio length) |
| `UNIPUS_MAX_CONSECUTIVE_FAILURES` | 2 | a failed / timed-out paper is written to the JSONL and skipped; this many failures in a row stop the account (refusal, missing LLM config and login/auth failures stop at once) |
| `UNIPUS_CONCURRENT_RETRIES` / `UNIPUS_CONCURRENT_RETRY_MS` | 2 / 60000 | `4021 请勿多设备同时作答`: wait, confirm the paper is still the current unsubmitted one (ledger, getUserStatus, listen history / speak part/get), reload a fresh token and resend; still 4021 → skip this paper |
| `UNIPUS_PART_MAX_MS` | 900000 | building the answers of one part |
| `UNIPUS_PAPER_MAX_MS` | 2400000 | one whole paper; past it no further part is submitted |
| `UNIPUS_AI_TURN_MIN_MS` | 55000 | AI dialogue pacing: minimum time between saves, like a human turn |
| `UNIPUS_FREE_TALK_MIN_SEC` | 90 | 自由表达 recording floor; shorter after regeneration → paper refused |
| `UNIPUS_LLM_TIMEOUT_MS` / `UNIPUS_LLM_MAX_TOKENS` | 180000 / 1024 | total cap / max_tokens of one streamed LLM request (grok-4.5 free-talk scripts take 23–74s) |
| `UNIPUS_LLM_FIRST_BYTE_MS` / `UNIPUS_LLM_IDLE_MS` | 30000 / 60000 | no response byte within this time → `LLM 首包超时`; stream silent this long → `LLM 流空闲超时` (each error names its stage; the caller's retries apply) |
| `UNIPUS_FREE_TALK_TTS_SPEED` | 0.85 | 自由表达 TTS speed (0.5–1.5); sentence pauses are stretched up to 1.2s if needed |

自由表达 text: the LLM is asked for 210–240 words (205–250 accepted, otherwise regenerated before TTS); lead-ins ("Sure, here's…"), titles, quotes, markdown and word counts are stripped, meta replies are rejected, and up to 3 generations are tried — a template or the prompt text is never submitted. Local Clio score is informational only. AI dialogue follows the App: one save per turn with user+bot (opener + 3 turns = 4 saves), real elapsed `duration`, server bot audio, then ebcp/speakers → stop → WS close and a single AI part submit.
