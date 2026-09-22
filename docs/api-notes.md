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
- The same `loadPaper` body starts **口语**. Take `taskId` / `ansVersion` from `getUserStatusForApp?flowType=speak`. There is no `flowType` field in the body.

## 口语开始训练（模拟器 2026-09-22）

口语首页「继续训练」打开 `https://uadaptive.unipus.cn/speak?taskId=&ansVersion=`，然后：

| Item | Value |
|------|--------|
| Method | `POST` |
| URL | `https://uadaptive.unipus.cn/api/uls/user/loadPaper`（`ucloud` 同样 200） |
| Body | `{ "taskId", "ansVersion" }` |
| WebView headers | `authorization` 裸 JWT，`sourceid: 116`，`x-requested-with: cn.unipus.cloud`，`openid` / `u-openid` |
| Headless | 裸 JWT + 上述 body 即 `code=1`。`sourceid: 116` 和 `u-app-id: 116` 也可带，但这个接口不强制 |
| `value` | `token`（提交用，约 32 字符）、`taskId`、`paperJson`、`tags`、`audioVisual` |
| `paperJson` | `chr` / `id` / `tp`；题目实例在 `q_qinstid`（必须当字符串） |

第二次 `loadPaper` 会让端内 `POST /api/uls/part/submit` 返回 `code=4021`（请勿多设备同时作答）。无头复现不要和正在作答的 WebView 抢 token。

### 范例学习（三关均已交卷；模拟器 2026-09-22）

`GET /api/uls/part/get?taskId=&ansVersion=` 返回 `value.partList[]`：`partId`、`partName`、`questionInstanceIds`、`reportStatus`、`submitted`，以及 `paperName`、`score`。三关名：「范例学习」「AI口语对话」「自由表达」。裸 JWT 即可，`sourceid` / `u-app-id` 都接受。交完后三关均为 `reportStatus=completed` / `submitted=true`（一份 `part/get` 的 `score` 示例为 90）。

进入范例学习后实际请求（**没有**打到 `/api/uls/oral/train`）：

- `POST /api/uls/user/loadTaskRes` body `{ taskId, ansVersion }`，头 `u-app-id: 116` 或 WebView 的 `sourceid: 116`。`value` 是音频 URL 列表。
- `POST /api/uls/part/submit` — **同一 URL**；作答中 `action:"snapshot"`，最终交卷 `action:"submit"`（**没有**另一条交卷 path）。Body：`{ action, ansVersion, duration, partId, taskId, token, userData: [{ instanceId, answer, answerVersion, context, contextVersion, instStatus }] }`。`token` 来自 `loadPaper`。成功 `code=1`。
- Step 3 题型：资源 `u-listen-speak-sentence-scoop-follow-read.js`，卷内 `type`=`sentence-scoop-record`（听译朗读）。跟读子题 `record.type`=`EN_SENT_SCORE`；有声快照含 `recordDetail` / `specific_scores`（见下方 MCP diffs）。

### AI口语对话（进关到出关；模拟器 2026-09-22）

**没有**请求 `/api/uls/oral/train`。真实 path 如下（多数在 **ucloud**；业务成功码是 **`code=200`**，不是 uls 用户接口那种 `1`）。业务头：`sourceid: 116`（小写）、`x-requested-with: cn.unipus.cloud`、裸 JWT。`create` body 里 `sourceId` 也是 116。

| 请求 | 位置 | body / query 键 | 成功时 |
| --- | --- | --- | --- |
| `POST /api/uls/conversation/create` | **ucloud** | `ansVersion` `questionId` `role` `sourceId` `taskId` `title` | `code=200`。`data`: `conversationId` `sceneId` `token` `level` |
| `GET /api/uls/conversation/chat/info` | ucloud（作答中也会打 uadaptive） | query `conversationId` | `code=200`。`data.record` 含 `recordDetail` `list` `role`，另有 `duration` |
| `GET /api/uls/conversation/max-count` | ucloud | 无 body | `code=200`，`data` 为数字（界面「话轮数 /10」） |
| `POST /api/uls/ebcp/auth` | ucloud | `scene` `bizExt`（内有 `questionId` `taskId` `ansVersion` `openId` `sourceId` `partId`） | `code=200`。`data`: `pAppId` `pCipTxt` `sourceId`（勿抄这些值） |
| `POST /api/uls/ebcp/speakers` | ucloud | `scene` `bizExt` | `code=200`。`data.speakers[]`、`data.speakVoiceTones[]` |
| `POST /api/uls/conversation/save` | ucloud | `duration` `speakTaskId` `speakAddTaskRecord` | `code=200`。`data.id` |
| `POST /api/uls/conversation/stop` | ucloud | `evaluation` `evaluationContent` `speakTaskId` `voiceToneId` | `code=200`（退出并完成「你认为 AI 表现如何」之后） |
| `POST /api/uls/part/submit` | 退出时在 **ucloud** | 仍是 `action:"submit"` + `partId` `taskId` `ansVersion` `token` `duration` `userData` | `code=1` |

`speakAddTaskRecord` 键：`aiType` `botAudioDuration` `botAudioUrl` `botChContent` `botEnContent` `digitalPersonId` `sort` `speakType` `speed` `userAudioDuration` `userAudioUrl` `userChContent` `userEnContent` `voiceToneId`。

对话 WebSocket：`GET https://oral.unipus.cn/oral_api/ws//{conversationId}` — **不是** `/api/uls/oral/train`。用户音频仍走 `query-upload-url`（文件名如 `ai-dialog-….wav` → birdflock ans-prod）。退出后 `part/get`：`reportStatus=completed`，`submitted=true`。

### 自由表达（模拟器 2026-09-22）

资源名 `mobile-speak-free-….js`，卷内类型 `oral-personal-state`。**没有**新的 path 前缀。进关仍是 `getUserStatus`、`part/get`、`loadAnswer`、`loadGradedQuestions`、`loadPaper`、`loadTaskRes`。

录音是「点击录音」（不是按住）。答体 `record.type` 是 **`EN_PRED_SCORE`**（不是跟读的 `EN_SENT_SCORE`），`children[0].isDone=true`，`recordDetail.score` 为界面分。先 `part/submit` `action=snapshot`（`context` 为 `{"state":"doing"}`），再 `action=submit`，`code=1`。交卷后 `part/get`：`completed` / `submitted=true`。

### MCP diffs vs App（文档对照；#18 抓包）

1. **打分引擎**：端内是 `zt.unipus.cn/soe/api/{initialize,acquire,release,log}/v2`（另有 `acquire/v3`）；MCP `score_speech` 走 Clio WSS `en.sent.score`。SOE 字段名 `overall`/`fluency`/`integrity`/`pronunciation`；Clio `result` 数字键是 `accuracy`/`completeness`/`total`/`audio_time`（另有 `fluency`/`detail`）。同一句可两边都非 0，但字段集合不同。
2. **范例 / 口语 part 交卷**：用 `POST /api/uls/part/submit`（`snapshot` → `submit`），**不是** `submit_answer` 的 `POST /api/uls/user/submitAnswer`。
3. **上传链**与 MCP `upload_answer_audio` 一致：`query-upload-url` → 七牛 `up-z1.qiniup.com`。
4. **答体形状**：`children[].record` + 子项 `isDone`；有声 snapshot 的 `record` 还带 `recordDetail` / `specific_scores`。MCP `buildEnSentScoreRecord` 目前只组 `type`/`text`/`url`/`path`/`replayUrl`/`list`，**不**放那两块（文档差异；本 PR 不改代码）。
5. SPA 静态曾出现的 `/api/uls/oral/train`、`part-report`、`free-speaking-report` 在整段交卷抓包中**仍未出现** — 勿臆造。


### MCP `start_speaking_training` (#20)

- Thin alias：可选覆盖 `taskId`/`ansVersion`，否则 `GET getUserStatusForApp?flowType=speak`（裸 JWT + `u-app-id`）→ 同一 `POST loadPaper`。
- 返回与 `start_listening_training` 相同（`task_id` / `paper_token` / `instance_ids`）。
- 勿与打开的 WebView 抢 token（`part/submit` → `4021`）。

### 交卷后读分 / MCP `load_graded_questions` (#20)

`POST https://ucloud.unipus.cn/api/uls/user/loadGradedQuestions`（`uadaptive` 同样）body `{ taskId, ansVersion }`，头 `u-app-id: 116` + 裸 JWT。`code=1`，`value` 为列表。条目键：`questionInstanceId`、`score`、`scoreDetail`、`review`、`questionContent`、`questionAnswer`、`rateStatus`、`rateType`、`actualRateType`、`objectiveReview`、`questionAnalysis`、`iwriteReview`、`userId`。GET 带 query 会 `code=500`。当前未交卷的任务列表可以为空；已做完的历史任务能返回条目。MCP 工具：`load_graded_questions`。

## Week progress

| Item | Status | Notes |
|------|--------|-------|
| **Homepage week (listen + speak)** | **`GET https://ucloud.unipus.cn/api/uls/user/getUserStatusForApp?flowType=listen` and `flowType=speak`** | Captured 2026-09-21 from official app 2.8.4. Header `u-app-id: 116` is required (`sourceId`). 本周计数 = `value.weekDoneTaskCount`. 达标数 = `value.weekFrequency`. `weekTotalTaskCount` is a third field and is not either of those. Raw JWT, no Bearer. Do not hardcode 3 or 6. |
| Trial optional | **`GET /api/uls/user/activation/status`** | `listenTrialUsed` / `speakTrialUsed` / `trialUsageLimit` = **本周试用进度**. Force legacy single-GET via `UNIPUS_ULS_WEEK_PROGRESS_PATH` / `weekProgressUrl`. |
| trainingReport | Not the homepage counter | `POST /api/uls/report/listen/trainingReport` still exists on uadaptive. `speak/trainingReport` and `oral/trainingReport` are 404. Homepage 本周总计 does not come from those. |
| Task-card % | Separate | Chapter completion (e.g. 0%), not week counters. |

MCP `list_week_progress` fields (**default = getUserStatusForApp**):

- `listen_done` / `speak_done` — `weekDoneTaskCount`（本周计数，界面「本周总计 N次」）
- `listen_total` / `speak_total` — `weekFrequency`（达标数）
- `progress_done` / `progress_total` / `level` — **backward-compatible aliases** of listen
- One capture: listen 5/5 (`weekDoneTaskCount`/`weekFrequency`, `weekTotalTaskCount` was 6); speak 6/3 (`weekTotalTaskCount` was 7). Those samples are not constants.

### Homepage week counters (captured)

Official app homepage uses `getUserStatusForApp`, not `trainingReport`. The notes below are the earlier probes that did not find this path.

### Earlier probes (trainingReport is not the homepage counter)

**Historical (2026-09-21, superseded):** trainingReport-style speak week path was **not findable** from H5 SPA + JWT probes. Homepage counters are now **`getUserStatusForApp`** (see table above) — do **not** treat this subsection as current BLOCKED status.

**SPA static (`tmp-speech-probe/index.js`):**

| Finding | Detail |
|---------|--------|
| Report base | `L = Be = "/api/uls/report"` |
| Only weekly fields | Parser for **`/listen/trainingReport`** maps `weeklyCompleted` / `weeklyTarget` / `weeklyProgress` (listen `prePart`/`whilePart`/`postPart`) |
| Error-code map | Only `/report/listen/trainingReport` (E3003) — **no** `/report/speak/…` |
| Oral reports | `/api/uls/oral/train/part-report`, `/free-speaking-report` (per-task评语, not week quota) |
| Speak UI | `speak-progress-track` = in-paper steps, **not** week counters |
| Native | `tvWeekProgress` in `utss_layout_cur_train_card.xml`; UTSS Java for week API **ijiami-locked** (not in jadx) |

**Live probe (paid JWT, uadaptive, raw Authorization; 2026-09-21):**

| Candidate | Result |
|-----------|--------|
| `POST /api/uls/report/speak/trainingReport` | **HTTP 404** |
| `POST /api/uls/report/oral/trainingReport` | **HTTP 404** |
| `POST /api/uls/report/trainingScoreReport` + speak `taskId` | 200; score/nodes only — **no** weekly* |
| `POST /api/uls/report/paperReport` + speak `taskId` | 200; paperJson/items — **no** weekly* |
| `GET getUserStatus?flowType=speak` | taskId/type/status/level — **no** weekly* |
| `GET activation/status` | `speakTrialUsed` / `trialUsageLimit` = **null** (paid) |
| `POST /api/uls/report/listen/trainingReport` + **listen** taskId | OK: `weeklyCompleted` (e.g. 5) |
| same + **speak** taskId | business **500** |

**Note:** speak homepage week is wired via `getUserStatusForApp` (PR #17). AI口语对话 / 自由表达 contracts captured 2026-09-22 (issue **#18**); see sections above — still **no** `/oral/train`.

## Ops: PCAPdroid

1. App filter `cn.unipus.cloud`; avoid SOCKS5 for normal use.
2. Start → one UI action → on timeout/white screen → **force-stop capture** → continue without VPN.
3. Paths above already unblock documenting #4; VPN only to confirm response shape when needed.


## Week quotas (product)

| Module | Weekly target | UI signal (2026-09-21 phone) |
|--------|---------------|------------------------------|
| 听力 U听力 | `weekFrequency` | 本周计数 `weekDoneTaskCount`。一次抓包是 5 和 5。 |
| 口语 U口语 | `weekFrequency` | 本周计数 `weekDoneTaskCount`。一次抓包是 6 和 3。 |

Note: 口语首页 `tvWeekProgress` (e.g. **2/3**) **matches** activation `speakTrialUsed`/`trialUsageLimit` on trial accounts. Task-card **0%** is chapter completion (old UI said 0/3).

`list_week_progress` 默认两次 `getUserStatusForApp`，听力和口语都返回本周计数和达标数。

## 口语 SPA routes (static)

`/speak`, `/speak/custom`, `/speak/custom/ai-dialog`, `/speak/custom/ai-dialog-report`, `/speak/custom/free`, `/speak/custom/free-report`, …
API refs in bundle: `/api/uls/oral/train`, `/api/uls/user/answer/query-upload-url`, share cards `ai-oral` / `free-expression`.

**Live capture (2026-09-22):** AI口语对话 uses `conversation/*` + `ebcp/*` (ucloud); free speak reuses `part/submit` with `EN_PRED_SCORE`. `/api/uls/oral/train` remains SPA-only — not observed on the wire. See captured sections above.

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


## 口语题型（App 实勘；三关已交卷 2026-09-22）

入口：底栏「口语」→ 当前任务卡 →「开始训练」→ 三关：

| 关卡 | 状态（2026-09-22） | 内容形态 / 真实 API |
|------|-------------------|---------------------|
| **范例学习** | 已交卷 | Step1–3；跟读 `EN_SENT_SCORE`；Step3 `sentence-scoop-record`；`part/submit` snapshot→submit |
| **AI口语对话** | 已交卷 | `conversation/*` + `ebcp/*` on **ucloud**（`code=200`）；退出再 `part/submit`；WS `oral.unipus.cn/oral_api/ws//{conversationId}` — **不是** `/oral/train` |
| **自由表达** | 已交卷 | 无新 path 前缀；`record.type=EN_PRED_SCORE`；`part/submit` snapshot→submit |

口语首页本周计数 / 达标数见上一节 `getUserStatusForApp`，不要再用试用 2/3 或写死 3。
任务卡 **0%** = 本篇完成度，不是周进度。

范例 / AI对话 / 自由表达的真请求见上方「范例学习」「AI口语对话」「自由表达」小节。SPA 静态仍引用 `/api/uls/oral/train`，但整段抓包**从未**打到该 path — 勿臆造。
`POST /api/uls/user/answer/query-upload-url` 仍是答案上传凭证（含 `ai-dialog-….wav`）。

本周计数和达标数都从 `getUserStatusForApp` 读：`weekDoneTaskCount` / `weekFrequency`。听力和口语各一次。不要写死 3 或 6。


## Silent audio upload (2026-09-21 live)

Confirmed against `uadaptive` with JWT (raw `Authorization`, no Bearer):

| Step | Method | Path / host | Notes |
|------|--------|-------------|-------|
| Credential | POST | `/api/uls/user/answer/query-upload-url` | Body `{ fileName }`; returns `token` / `path` / `url` |
| Upload | POST multipart | `https://up-z1.qiniup.com` | Fields `token`, `key`(=path), `file` |
| Submit | POST | `/api/uls/user/submitAnswer` | Needs `loadPaper` token; multi-device lock without it |

MCP tool: `upload_answer_audio` (filePath → storage_key + cdn_url). Does **not** submit yet.

SSO login CLI: `UNIPUS_USERNAME` + `UNIPUS_PASSWORD` → `npx tsx scripts/sso-login.ts` writes `~/.config/unipus-mcp/jwt`.

Progress probe (default): `GET /api/uls/user/getUserStatusForApp?flowType=listen` and `flowType=speak` on ucloud with **raw JWT** → `weekDoneTaskCount` / `weekFrequency`. Trial activation remains the legacy single-GET.

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
- **CDN-url-only** short answer (`children[].record.url` or top-level `{record:{url}}`) → grade may succeed but **`score=0`** / empty userAnswer.
- Device-persisted ~76-score **answer** shape (2026-09-21):
  ```json
  {"children":[{"record":{"type":"EN_SENT_SCORE","text":"…","path":"https://clio-audios…/speech-proxy/…","url":"https://birdflock…/ans-prod/…","replayUrl":"https://birdflock…/ans-prod/…","list":[]},"value":[],"isDone":true}],"value":[]}
  ```
  - Record lives under **`children[0].record`** (not top-level `record`).
  - **`isDone` is on the child**, not inside `record`.
  - URL-only records: `type` / `text` / `url` / `path` / `replayUrl` / `list`.
  - Voiced in-app `part/submit` snapshots also include `recordDetail` and `specific_scores`. `buildEnSentScoreRecord` adds those blocks when `reviewScores` has a finite number. `recordDetail.audioUrl` is the answer `url` (birdflock when uploaded). Ratios: `specific_scores.total = score/100`, `accuracy = correctness/100`, `fluency = smooth/100`, `integrity = completed/100`, `relevance = relevance/100` (98 → 0.98, 100 → 1). Engine fields that were absent are omitted, not filled with 0.
  - Production URLs: `url`/`replayUrl` = birdflock ans-prod (Qiniu upload); `path` = clio-audios speech-proxy.
- Helper: `buildEnSentScoreQuestionContent` / `clioToEnSentScoreFields({ qiniuUrl })`. `reviewScores` maps Clio `overall→score`, `fluency→smooth`, `integrity→completed`, `pronunciation→correctness`, `relevance→relevance`, and those numbers are embedded on the record. Clio-only names (`accuracy`, `completeness`, `total`, `audio_time`) stay on the Clio result; they are not renamed into `recordDetail`.
- Scoring engine is **client SDK** (Clio WSS / speech.cdn); server grade mostly **persists**. Pre-submit: `score_speech` → optional Qiniu upload → `grade_question` with children-shaped content.
- **Retest caveat:** grading an **already-submitted** task may empty `userAnswer` / return score=0. Need an **unsubmitted** task + remaining speak quota to live-verify non-zero grade.
- After submit: **`POST /api/uls/user/loadGradedQuestions`** `{ taskId, ansVersion }` with raw JWT and `u-app-id: 116` (see speak section). MCP: `load_graded_questions`.
- Paid week counters are `getUserStatusForApp` `weekDoneTaskCount` / `weekFrequency`. Do not hardcode 3 or 6.

MCP: `grade_question`; `start_listening_training` returns `instance_ids` as exact strings.

## Clio / speech.unipus.cn scoring (2026-09-21 verified)

Headless **en.sent.score** for real `EN_SENT_SCORE` payloads (do **not** invent scores client-side).

### WSS protocol

| Item | Value |
|------|-------|
| Prod WSS | `wss://speech.unipus.cn/speech/proxy/wss` (**not** bare `/wss` for business) |
| Sig | `SHA1(hex)` of `applicationId + secret + timestamp` |
| timestamp | `Math.floor(Date.now()/1000).toString()` (= `String(Date.now()).slice(0,-3)`) |

On open, send frames **in order**:

1. `{sdk:{version:16777216,source:4,protocol:"websocket"},app:{applicationId,sig,timestamp,userId,alg:"sha1"}}`
2. `{tokenId:uuid, audio:{audioType:"wav",channel:1,sampleRate:16000,sampleBytes:2}, request:{apiName:"en.sent.score", transcript, userId, sig, parameters:{details:{adjust:0}}}}`
3. binary audio (WAV/PCM bytes)
4. `{"stop":true}`

Success response shape: `{code:0, finalResult:{result:{…scores…}, url:"https://clio-audios.unipus.cn/…"}}`.
Silence → `total=0` is OK for smoke; use TTS WAV for non-zero attempts.

### Credentials

SPA phoneme helper (`mobile/core.js`) hardcodes:

- `applicationId`: `162787294610001`
- `secret`: `8da79f23cff822c84a64d231fa5f7e28c5319896` (public in SPA bundle)

Env overrides: `UNIPUS_CLIO_APP_ID` / `UNIPUS_CLIO_APP_SECRET` / `UNIPUS_CLIO_WSS_URL`.
MCP tool: `score_speech` (transcript + wavPath). Helper `clioToEnSentScoreFields` maps → children-shaped `buildEnSentScoreQuestionContent` (pass `qiniuUrl` after upload).

### SOE initialize/v2 (optional rotation; document only)

Full product path (soe-sdk):

1. `POST https://zt.unipus.cn/soe/api/initialize/v2` with header  
   `auth = btoa(appKey + ':' + ts.slice(0,7) + hashStr(appKey+':'+appSecret+':'+ts.slice(-10)) + ts.slice(-6))`  
   where `ts = String(Date.now())` and `hashStr` is the SDK’s Murmur-style hasher (`Tt.hashStr`) — **not** MD5 despite some notes.
2. Response `data[].config` is hex ciphertext; AES-CBC decrypt with  
   `key = TextEncoder(appSecret)`, `IV = [1..16]` → `engineKey:engineSecret:appId`.
3. Default Clio engine uses those `engineKey`/`engineSecret` for the same WSS sig.

SPA passes `appKey`/`appSecret` into SOE `initConfig` — **not present in main `index.js`**. Without device capture of those keys, keep env overrides and default to the verified phoneme pair. Production may rotate via initialize/v2.

### Chivox / aiengine.provision (native TBD)

- Chivox H5 path: `Html5Recorder` + `https://zt.unipus.cn/soe/api/csAuth` + `wss://cloud.chivox.com`.
- **`aiengine.provision` is NOT in soe-sdk JS.**
- On-device APK (`cn.unipus.cloud`, jadx under `/workspace/unipus-apk`):  
  - asset `resources/assets/aiengine.provision` (112-byte obfuscated blob)  
  - native `libaiengine.so` exports `aiengine_new/start/feed/stop/…` (Chivox-style)  
  - **no Java/Kotlin string refs** in jadx sources (IJM-packed) — reverse **not** complete.
- Leftover for unipus: treat `aiengine.provision` as **native/Chivox stub**; do not fake `EN_SENT_SCORE`. CDN-url-only grade still often score=0 without Clio scores.

MCP: `score_speech` ships the Clio WSS path; `grade_question` stays separate (persist).

## Placement / 定级 completion path (SPA reverse 2026-09-21)

Source: `uadaptive` chunks `mobile-speak-placement-*.js` / `mobile-listen-placement-*.js` + main `index-*.js` API map. **No skip/bypass API** in SPA (no `skipPlacement` / 免测 / 跳过定级).

### sourceBizType → route

| sourceBizType | 卷种 | 进入 |
|---------------|------|------|
| 101 | 听力定级 | `/placement/listen` (auto: `/placement/auto`) |
| 102 | 听力诊断 | `/diagnosis/listen` |
| 103 | 听力训练 | `/listen/guide` |
| 104 | 口语定级 | `/placement/speak` (auto: `/placement/auto`) |
| 106 | 口语训练 | `/speak/training` |

### getUserStatus: `type=grade` → `train`

`GET /api/uls/user/getUserStatus?flowType=` (`listen` / `speak` / `trial-speak`).

Normalized value: `{ type, taskId, ansVersion, status }` where `status` prefers `testStatus` then `status`.

| `type` | Client meaning |
|--------|----------------|
| `grade` | 定级中；`status` 映射阶段 |
| `grade_profile` / `train_plan` | 定级后报告/计划 |
| `train` | 周训已解锁（听力入口遇此 type →「当前不在定级阶段」） |
| `diagnosis` | 诊断阶段 |

`type=grade` 时 `status`：

| status | UI stage |
|--------|----------|
| 0 | `device`（设备/麦克风检测） |
| 1 | `answer`（作答中；设备观察 speak task 常停在此） |
| 2 | `report`（交卷成功后看定级报告） |

**Flip `grade` → `train` is server-side** after a successful **full-paper** `submitAnswer` (and backend settling). Client re-fetches `getUserStatus`; there is no client-only flip API.

Post-placement reports (after status=2):

- Speak: `GET /api/uls/report/oralLevelReport`
- Listen: `POST /api/uls/report/levelReport`

### Exam API sequence (placement)

Placement **does not** finish via `gradeQuestion` or `part/submit`. Chunk has **no** `gradeQuestion` calls.

1. `POST /api/uls/user/loadPaper` `{ taskId, ansVersion }` → `token` + `paperJson`
2. While answering: `POST /api/uls/user/saveSnapshot` (partial `userData`, non-empty answers only); keepalive on hide
3. Final 交卷: `POST /api/uls/user/submitAnswer` with **full** `userData` (every leaf instance) + loadPaper `token` + `duration`
4. On success → local examStatus `done` → finish callback → UI `report`; later `getUserStatus` shows `status=2` then eventually `type=train`

`part/get` / `part/submit` / `part/submit-question` are for **口语训练首页 part 树**（`skillType` train），不是定级交卷路径。

### Why `submitAnswer` → **4295** 「作答小题数存在问题」

SPA `submitExam` before POST:

1. Builds `userData` from **all** `answers` parallel to paper questions (not a single item).
2. Runs reconcile `k(questions, answers)`: for each answer whose paper leaf has `data.children.length > 1`, pads `answer.children` to that length (`w()` oral/objective stubs). Logs `[SUBMIT_ANSWER_RECONCILED]` when repaired.

Server 4295 (not present in SPA client map) = **sub-question count mismatch**:

- `userData.length` ≠ paper leaf count (e.g. headless submit of **one** instance on a multi-question placement paper), and/or
- some `answer` JSON has `children.length` **&lt;** paper expected sub-questions.

Helpers (pure, unit-tested): `listPlacementQuestions` / `reconcileAnswerChildren` / `buildPlacementUserData` / `diagnosePlacementSubmitCoverage` in `src/placement-paper.ts`. `submit_answer` now surfaces `BUSINESS_ERROR` with code/msg (4295 includes placement hint).

### Why `gradeQuestion` returns empty shell on placement items

Observed: `code=SUCCESS` but `userId=""`, `questionInstanceId=0`, `score=null` on listen+speak placement items.

SPA placement chunks **never call** `gradeQuestion`. Main bundle normalizer `Y()` would coerce missing score → `0` and stringify ids — empty fields are **from the server**, not client parse loss.

Interpretation: per-item `gradeQuestion` on a **placement/grade** task is an ack/shell until the paper is closed by `submitAnswer` (and/or report pipeline). It is **not** evidence of wrong EN_SENT_SCORE children shape (PR#12 shape is still correct for train). Completing placement requires full-paper submit, not repeated gradeQuestion.

### Ready notes for unipus (device)

1. `getUserStatus` until `type=grade` & `status=1` with speak/listen `taskId`.
2. `loadPaper` that task → list leaves via `listPlacementQuestions(paperJson)`.
3. For **every** leaf: Clio `score_speech` → Qiniu → children-shaped answer; `reconcileAnswerChildren` / `buildPlacementUserData`.
4. `diagnosePlacementSubmitCoverage` must be `ok` before `submit_answer` (multi-item `userData` + paperToken).
5. Re-`getUserStatus`: expect `status=2` then `type=train` (week 5听/3口). Do **not** invent purchase/skip hacks; `isPurchased=0` trial is fine once type flips.
