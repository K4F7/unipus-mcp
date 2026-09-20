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
| Listen path | **Placeholder** `/api/uls/week-progress` | Override `UNIPUS_ULS_WEEK_PROGRESS_PATH` / `UNIPUS_ULS_ORIGIN`. Not claimed as mitm-captured. |
| Speak path | **Unknown** | No default URL invented. Set `UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH` when captured (same origin helper). |

MCP `list_week_progress` fields:

- `listen_done` / `listen_total` — listening week progress (product target **5**/week)
- `speak_done` / `speak_total` — speaking week progress (product target **3**/week); `null` until twin fields appear in the listen response **or** speak path env is set
- `progress_done` / `progress_total` / `level` — **backward-compatible aliases** of listen (same numbers as `listen_*`)

## Ops: PCAPdroid

1. App filter `cn.unipus.cloud`; avoid SOCKS5 for normal use.
2. Start → one UI action → on timeout/white screen → **force-stop capture** → continue without VPN.
3. Paths above already unblock documenting #4; VPN only to confirm response shape when needed.


## Week quotas (product)

| Module | Weekly target | UI signal (2026-09-21 phone) |
|--------|---------------|------------------------------|
| 听力 U听力 | **5** / week | Home / 听力 tab (capture remaining into `list_week_progress`) |
| 口语 U口语 | **3** / week | 口语 tab shows **当前进度 `0/3`** + task card +「开始训练」 |

MCP must expose remaining for both (not listen-only). Prefer one tool or twin fields: `listen_done/listen_total`, `speak_done/speak_total`.

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

周进度 UI：**当前进度 `0/3`**（口语本周 3 次）。

关键 API（静态）：
- `GET/POST` 族 `/api/uls/oral/train?ansVersion&questionId&taskId&openId…`
- `POST /api/uls/user/answer/query-upload-url`（拿上传凭证，注音/无头上传答案用）

听力周额度 **5**；口语 **3**；MCP 进度工具要同时露出听/口剩余。
