# API notes (living)

Phone PCAPdroid VPN often breaks U听力 WebView / submit. **Own the capture loop**: short bursts; on timeout or `ERR_CONNECTION_*`, stop VPN immediately then continue UI. Prefer SPA static analysis for paths.

## Origins / auth

| Item | Value | Notes |
|------|-------|-------|
| H5 (U听力训练) | `https://uadaptive.unipus.cn` | App WebView; `/api/uls/*` same-origin |
| Gateway candidate | `https://ucloud.unipus.cn` | Earlier probe; JWT |
| Package | `cn.unipus.cloud` | IJM packed |
| Auth header | `Authorization: <raw JWT>` | **No** `Bearer ` prefix (SPA preload) |
| Optional header | `openId` | When present |

Live SNI while capturing: `uadaptive.unipus.cn`, `log.unipus.cn`, `ucontent.unipus.cn`.

## 「开始训练」/ 听力（SPA 2026-09-21）

Source: `uadaptive.unipus.cn` preload + `index-*.js`. Preload only on `/listen` (not `/listen/custom`, `/speak`, `/speak/custom`).

| Method | Path | Body / query | Role |
|--------|------|--------------|------|
| **POST** | `/api/uls/user/loadPaper` | `{ taskId, ansVersion }` | **Enter training / load paper** |
| **GET** | `/api/uls/user/getHomeworkByTaskId?taskId=` | query | Homework; success often `code: 0` |
| POST | `/api/uls/task/loadQuestion` | JSON | Load question |
| POST | `/api/uls/user/loadAnswer` | JSON | Prior answers |
| POST | `/api/uls/user/loadTaskRes` | JSON | Task resources |
| POST | `/api/uls/user/submitAnswer` | JSON | Submit answer |
| POST | `/api/uls/user/saveSnapshot` | JSON | Snapshot |
| POST | `/api/uls/rate/gradeQuestion` | JSON | Grade |
| GET | `/api/uls/part/get-question?…` | taskId, ansVersion, … | Part questions |
| GET | `/api/uls/part/get?…` | | Part payload |
| POST | `/api/uls/part/submit` | JSON | Part submit |
| POST | `/api/uls/part/submit-question` | JSON | Per-question |
| POST | `/api/uls/report/listen/trainingReport` | JSON | Listen report |
| POST | `/api/uls/report/paperReport` | JSON | Paper report |
| POST | `/api/uls/report/check` / `checkStatus` | JSON | Report status |
| GET | `/api/uls/plan/current?trainType=` | query | Plan |
| GET | `/api/uls/user/getUserStatus?flowType=` | query | Status |

Wrong path (do not use): `/api/uls/homework/getByTaskId`.

### MCP `start_listening_training` (#4)

- Implemented with **`POST /api/uls/user/loadPaper`** and body `{ taskId, ansVersion }` (`ansVersion` defaults to `1`).
- MCP args: required `taskId`; optional positive `ansVersion` and `openId` (sent as the `openId` header).
- Uses `Authorization: <raw JWT>` with no `Bearer ` prefix; JWT remains env/CLI-only, never a tool argument.
- Default URL is `https://uadaptive.unipus.cn/api/uls/user/loadPaper`; override with `UNIPUS_ULS_ADAPTIVE_ORIGIN` / `UNIPUS_ULS_LOAD_PAPER_PATH`.
- Accepts business codes `0`, `1`, and `200`; returns observable `task_id` and `paper_token` when present. MVP does not auto-finish the exercise set.

## 口语（app 内下一步，暂缓实现）

SPA refs: `/api/uls/oral/train/free-speaking-report`, share-card `ai-oral`. Capture after listening app flow is done.

## Week progress

| Item | Status | Notes |
|------|--------|-------|
| Primary path | **`GET /api/uls/user/activation/status`** | Live 2026-09-21: `listenTrialUsed` / `speakTrialUsed` / `trialUsageLimit` = **本周试用进度** (e.g. speak 2/3). Trial UI `tvWeekProgress` **aligned**. Task-card **0%** = chapter completion (separate). Paid week quota path **unverified**. Default host **uadaptive** (raw JWT). Override path `UNIPUS_ULS_WEEK_PROGRESS_PATH`; host `UNIPUS_ULS_ORIGIN` or `UNIPUS_ULS_ADAPTIVE_ORIGIN`. |
| Speak dedicated path | Same body (optional env) | Recommended `UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH=/api/uls/user/activation/status` only if a second fetch is desired; usually unnecessary. |
| Listen report fields | `POST /api/uls/report/listen/trainingReport` | `weeklyCompleted` / `weeklyTarget` after a finished listen paper (parser also accepts these). |

MCP `list_week_progress` fields (default = **本周试用进度**；试用账号已对齐):

- `listen_done` / `listen_total` — activation `listenTrialUsed` / `trialUsageLimit` (or trainingReport weekly* if path overridden)
- `speak_done` / `speak_total` — activation `speakTrialUsed` / `trialUsageLimit`; `null` if absent and no speak path env
- `progress_done` / `progress_total` / `level` — **backward-compatible aliases** of listen (same numbers as `listen_*`)
- **试用账号已对齐** App `tvWeekProgress`；**付费周配额**（听力 5 / 口语 3）**path 未验证** — 勿假装已抓到付费周接口

## Ops: PCAPdroid

1. App filter `cn.unipus.cloud`; avoid SOCKS5 for normal use.
2. Start → one UI action → on timeout/white screen → **force-stop capture** → continue without VPN.
3. Paths above already unblock documenting #4; VPN only to confirm response shape when needed.


## Week quotas (product)

| Module | Weekly target | UI signal (2026-09-21 phone) |
|--------|---------------|------------------------------|
| 听力 U听力 | **5** / week | Home / 听力 tab (capture remaining into `list_week_progress`) |
| 口语 U口语 | **3** / week | Paid weekly quota path **unverified** (device capture ongoing). |

Note: 口语首页 `tvWeekProgress` (e.g. **2/3**) **matches** activation `speakTrialUsed`/`trialUsageLimit` on trial accounts. Task-card **0%** is chapter completion (old UI said 0/3).

`list_week_progress` → activation/status = **本周试用进度**（试用已对齐）；付费周配额 path 未验证.

## 口语 SPA routes (static)

`/speak`, `/speak/custom`, `/speak/custom/ai-dialog`, `/speak/custom/ai-dialog-report`, `/speak/custom/free`, `/speak/custom/free-report`, …
API refs: `/api/uls/oral/train`, `/api/uls/user/answer/query-upload-url`, share cards `ai-oral` / `free-expression`.

## Auto audio inject (hard requirement)

Goal: App `AudioRecord` / WebView mic sees our TTS/WAV without human speech.

**Tried / failed**
- System player + speaker loopback → pops「打开方式」, leaves WebView.
- `RECORD_AUDIO` grant alone is not enough without a feed.

**Candidate approaches (priority)**
1. **Virtual mic / audio loopback app** (e.g. USB audio interface, VB-Cable-like Android, or Magisk/root snd-aloop) — play WAV into chosen input device, App records default mic.
2. **Appium/scrcpy with audio injection** if available on device build.
3. **Frida hook** `AudioRecord.read` / WebView `getUserMedia` to feed PCM from file (works without acoustic path; needs Frida + possibly SSL separately).
4. **Direct API**: skip UI mic — upload answer audio via `/api/uls/user/answer/query-upload-url` + submit (headless path; needs capture of exact multipart + ids).

MVP acceptance: one 跟读/口头填空/口语题 auto-filled by generated audio end-to-end.


## 口语题型（App 实勘 2026-09-21）

入口：底栏「口语」→ 当前任务卡（例：讲述大学期间追求成长的目标）→「开始训练」→ 三关：

| 关卡 | 状态 | 内容形态 |
|------|------|----------|
| **范例学习** | 解锁 | Step1–3；先听范文音频+跟读文本；可长按查词；后续 Step 预计跟读/录音 |
| **AI口语对话** | 锁 | 需完成范例后解锁；对应 SPA `/speak/training/ai-dialog` |
| **自由表达** | 锁 | 对应 `/speak/training/free` 等 |

口语首页 `tvWeekProgress`（例 **2/3**）= activation `speakTrialUsed`/`trialUsageLimit`（**本周试用进度**，试用号已对齐）。
任务卡 **0%** = 本篇完成度（旧 UI 曾写 0/3）。`trialRemainDesc`（例「2天」）对齐「体验还剩 2天」。
付费周配额 3：**path 未验证**。

关键 API（静态）：
- `GET/POST` 族 `/api/uls/oral/train?ansVersion&questionId&taskId&openId…`
- `POST /api/uls/user/answer/query-upload-url`（拿上传凭证，注音/无头上传答案用）

付费周额度目标：听力 **5**、口语 **3**（**path 未验证**）。MCP `list_week_progress` 默认 = activation **本周试用进度**（试用账号已对齐）；勿当成已验证的付费周接口。


## Silent audio upload (2026-09-21 live)

Confirmed against `uadaptive` with JWT (raw `Authorization`, no Bearer):

| Step | Method | Path / host | Notes |
|------|--------|-------------|-------|
| Credential | POST | `/api/uls/user/answer/query-upload-url` | Body `{ fileName }`; returns `token` / `path` / `url` |
| Upload | POST multipart | `https://up-z1.qiniup.com` | Fields `token`, `key`(=path), `file` |
| Submit | POST | `/api/uls/user/submitAnswer` | Needs `loadPaper` token; multi-device lock without it |

MCP tool: `upload_answer_audio` (filePath → storage_key + cdn_url). Does **not** submit yet.

SSO login CLI: `UNIPUS_USERNAME` + `UNIPUS_PASSWORD` → `npx tsx scripts/sso-login.ts` writes `~/.config/unipus-mcp/jwt`.

Progress probe: prefer `GET /api/uls/user/activation/status` on uadaptive with **raw JWT** (`*TrialUsed` / `trialUsageLimit` = **本周试用进度**；试用号已对齐 tvWeekProgress). Paid week-quota path unverified. Listen report still returns `weeklyCompleted` / `weeklyTarget` after a finished paper.

### submitAnswer (2026-09-21 live)

`POST /api/uls/user/submitAnswer` with raw JWT + body:

```json
{
  "taskId": "...",
  "ansVersion": 1,
  "token": "<loadPaper token>",
  "duration": 3,
  "userData": [{
    "instanceId": "<q_qinstid>",
    "answer": "{\"value\":[],\"children\":[],\"record\":{\"url\":\"<cdn>\"}}",
    "answerVersion": 1,
    "context": "{\"state\":\"done\"}",
    "contextVersion": 1
  }]
}
```

Without a fresh loadPaper `token`, API returns multi-device lock (`4021`).

### gradeQuestion + BigInt ids (2026-09-21 device)

`POST /api/uls/rate/gradeQuestion` (SPA `J()`), raw JWT (no Bearer):

```json
{
  "taskId": "<string>",
  "questionInstanceId": "<string snowflake q_qinstid>",
  "ansVersion": 1,
  "questionContent": "<answer JSON string>",
  "isObjective": false
}
```

- **`questionInstanceId` must be a string** end-to-end. Never `JSON.parse` bare snowflake numbers (e.g. `1984905701219868673` → corrupted). MCP uses `parseJsonPreservingLargeInts` / `asExactIdString`.
- **CDN-url-only** short answer (`children[].record.url` or `{record:{url}}`) → grade may succeed but **`score=0`** / empty userAnswer.
- Real ~76-score body uses rich `record`: `{ "type":"EN_SENT_SCORE", "text", "url", "replayUrl"?, "path"?, "isDone":true }` (`path` may be clio speech-proxy). Helper: `buildEnSentScoreQuestionContent`.
- Scoring engine is **client SDK** (`speech.cdn`); server grade mostly **persists** already-computed scores. **Pre-submit score** cannot rely on upload-then-grade alone without that SDK/proxy — or accept submit → `loadGradedQuestions` with 0-score risk.
- After submit: **`/api/uls/user/loadGradedQuestions`** can read results (URL helper in config; **no MCP tool yet**).
- Paid week quota 5/3 still **unverified**.

MCP: `grade_question`; `start_listening_training` returns `instance_ids` as exact strings.

