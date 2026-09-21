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
| **Paid default (listen)** | **`GET getUserStatus?flowType=listen` → `POST /api/uls/report/listen/trainingReport`** | Live 2026-09-21 (paid/unlocked): `weeklyCompleted` / `weeklyTarget` / `weeklyProgress` (e.g. **5/5**). In-progress paper may return `weeklyTarget=0` while `weeklyCompleted` stays valid — MCP then fills total with product listen quota **5**. Host **uadaptive**, raw JWT. |
| Trial optional | **`GET /api/uls/user/activation/status`** | `listenTrialUsed` / `speakTrialUsed` / `trialUsageLimit` = **本周试用进度** (e.g. speak 2/3). Trial UI `tvWeekProgress` aligned. After unlock these fields are **null** — must **not** PARSE_ERROR. Force legacy single-GET via `UNIPUS_ULS_WEEK_PROGRESS_PATH` / `weekProgressUrl`. |
| Speak dedicated path | Optional env | `UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH`; paid speak week path **BLOCKED** (static+probe 2026-09-21) — leave `speak_*` null (do **not** invent 3). |
| Task-card % | Separate | Chapter completion (e.g. 0%), not week counters. |

MCP `list_week_progress` fields (**default = paid trainingReport listen**):

- `listen_done` / `listen_total` — trainingReport `weeklyCompleted` / `weeklyTarget` (fallback: trial `listenTrialUsed` / `trialUsageLimit`)
- `speak_done` / `speak_total` — trial `speakTrialUsed` / `trialUsageLimit` when present; otherwise **`null`** (**BLOCKED**: paid speak week path not in SPA; needs device capture)
- `progress_done` / `progress_total` / `level` — **backward-compatible aliases** of listen
- Default user going forward is **paid**; trial counters are optional only

### BLOCKED: paid speak weekly progress (App ~3/week)

**Status (2026-09-21):** path **not findable** from H5 SPA static + JWT probes. Do **not** wire guessed paths. Needs **unipus device capture** (PCAPdroid / Frida) while opening 口语首页 so `tvWeekProgress` (native UTSS) refreshes.

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

**Capture ask (unipus):** short PCAPdroid burst → open 口语 tab / pull-to-refresh until `tvWeekProgress` shows x/3 → stop VPN. Prefer hosts `uadaptive.unipus.cn` / `ucloud.unipus.cn`. Record method+path+JSON keys that carry done/total (expect ~3). Then wire `list_week_progress` `speak_*` like listen trainingReport.

## Ops: PCAPdroid

1. App filter `cn.unipus.cloud`; avoid SOCKS5 for normal use.
2. Start → one UI action → on timeout/white screen → **force-stop capture** → continue without VPN.
3. Paths above already unblock documenting #4; VPN only to confirm response shape when needed.


## Week quotas (product)

| Module | Weekly target | UI signal (2026-09-21 phone) |
|--------|---------------|------------------------------|
| 听力 U听力 | **5** / week | Home / 听力 tab (capture remaining into `list_week_progress`) |
| 口语 U口语 | **3** / week | Paid weekly quota path **BLOCKED** — SPA 无对称 trainingReport；需设备抓包（见上节）。 |

Note: 口语首页 `tvWeekProgress` (e.g. **2/3**) **matches** activation `speakTrialUsed`/`trialUsageLimit` on trial accounts. Task-card **0%** is chapter completion (old UI said 0/3).

`list_week_progress` → **付费默认** trainingReport listen week；activation trial 字段可选；口语付费周 **BLOCKED** → speak 保持 null.

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
付费周配额 3：**BLOCKED**（SPA+probe 无 path；勿编造）。

关键 API（静态）：
- `GET/POST` 族 `/api/uls/oral/train?ansVersion&questionId&taskId&openId…`
- `POST /api/uls/user/answer/query-upload-url`（拿上传凭证，注音/无头上传答案用）

付费周额度目标：听力 **5**（trainingReport 已验证）、口语 **3**（**BLOCKED**，勿编造）。MCP `list_week_progress` 默认 = **付费** listen trainingReport；activation = 试用可选；speak_* 付费仍 null。


## Silent audio upload (2026-09-21 live)

Confirmed against `uadaptive` with JWT (raw `Authorization`, no Bearer):

| Step | Method | Path / host | Notes |
|------|--------|-------------|-------|
| Credential | POST | `/api/uls/user/answer/query-upload-url` | Body `{ fileName }`; returns `token` / `path` / `url` |
| Upload | POST multipart | `https://up-z1.qiniup.com` | Fields `token`, `key`(=path), `file` |
| Submit | POST | `/api/uls/user/submitAnswer` | Needs `loadPaper` token; multi-device lock without it |

MCP tool: `upload_answer_audio` (filePath → storage_key + cdn_url). Does **not** submit yet.

SSO login CLI: `UNIPUS_USERNAME` + `UNIPUS_PASSWORD` → `npx tsx scripts/sso-login.ts` writes `~/.config/unipus-mcp/jwt`.

Progress probe (paid default): `getUserStatus?flowType=listen` + `POST .../listen/trainingReport` on uadaptive with **raw JWT** → `weeklyCompleted` / `weeklyTarget`. Trial: activation/status `*TrialUsed` / `trialUsageLimit` optional (null after unlock OK). Speak paid week **BLOCKED** (needs device capture; see section above).

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
  - Record fields only: `type` / `text` / `url` / `path` / `replayUrl` / `list` — **no** `recordDetail` / `specific_scores` in questionContent (those appear in **gradeResult.review** after grade).
  - Production URLs: `url`/`replayUrl` = birdflock ans-prod (Qiniu upload); `path` = clio-audios speech-proxy.
- Helper: `buildEnSentScoreQuestionContent` / `clioToEnSentScoreFields({ qiniuUrl })`. Optional `reviewScores` maps Clio `overall→score`, `fluency→smooth`, etc. for callers — **not** embedded in answer JSON.
- Scoring engine is **client SDK** (Clio WSS / speech.cdn); server grade mostly **persists**. Pre-submit: `score_speech` → optional Qiniu upload → `grade_question` with children-shaped content.
- **Retest caveat:** grading an **already-submitted** task may empty `userAnswer` / return score=0. Need an **unsubmitted** task + remaining speak quota to live-verify non-zero grade.
- After submit: **`/api/uls/user/loadGradedQuestions`** can read results (URL helper in config; **no MCP tool yet**).
- Paid week quota 5/3 still **unverified**.

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
