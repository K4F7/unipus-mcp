# unipus-mcp（stdio）

本仓库根目录就是给 Grok Bot / Cursor 用的本机 stdio MCP。体验对齐 [K4F7/chaoxing-mcp](https://github.com/K4F7/chaoxing-mcp) / [K4F7/icourse163-mcp](https://github.com/K4F7/icourse163-mcp)：一个进程、stdio、凭据不进工具参数。

目标产品：手机 App **U听力 / U听说**（包名 `cn.unipus.cloud`），**不是**网页课「261英语视听说」。

`auth_status` 会读取环境变量/文件中的 JWT 并对 `https://ucloud.unipus.cn/api/uls/` 做探活。`list_week_progress` 默认对听力和口语各请求一次 `GET https://ucloud.unipus.cn/api/uls/user/getUserStatusForApp?flowType=listen|speak`，并带请求头 `u-app-id: 116`（可用 `UNIPUS_U_APP_ID` 覆盖）。服务端把这个头当作 `sourceId`；不带它会返回 `sourceId不能为空`。本周计数是 `weekDoneTaskCount`，达标数是 `weekFrequency`。不要把 3 或 6 写死。`weekTotalTaskCount` 不是这两个数。试用账号仍可用 `UNIPUS_ULS_WEEK_PROGRESS_PATH` 走 activation。`start_listening_training` / `start_speaking_training` 走同一 `POST loadPaper`；`load_graded_questions` 读已评分题目。

## 工具

| 工具 | 说明 |
|------|------|
| `auth_status` | 探活 JWT：是否有效、粗判过期、安全 user id（密码/JWT 永不作为参数） |
| `list_week_progress` | 听力和口语都返回本周计数 / 达标数：`*_done`=`weekDoneTaskCount`，`*_total`=`weekFrequency`；`progress_*`/`level` 为听力别名；401→`auth_required`，网络失败→`NETWORK_ERROR` |
| `start_listening_training` | 开始听力训练；必填 `taskId`，可选 `ansVersion`（默认 `1`）和 `openId`；返回 `task_id` / `paper_token` / `instance_ids`（精确字符串，防 BigInt 精度丢失） |
| `start_speaking_training` | 开始口语训练；可选 `taskId`/`ansVersion`/`openId`；缺省时 `getUserStatusForApp?flowType=speak` + `u-app-id` 再 `loadPaper`；勿与打开的 WebView 抢 token（4021）；AI对话/自由表达见 #18 |
| `load_graded_questions` | 交卷后读分：`POST loadGradedQuestions` `{ taskId, ansVersion }` + 裸 JWT + `u-app-id`；空列表 OK |
| `upload_answer_audio` | 静默上传答案音频（query-upload-url → Qiniu）；返回 `storage_key` / `cdn_url` |
| `submit_answer` | 提交答案（需 loadPaper `paperToken`）；口语 CDN URL 可自动包成 `record.url` |
| `speak_and_submit` | TTS → 上传 → submit 一键静默口语 |
| `grade_question` | `POST /api/uls/rate/gradeQuestion`；`questionInstanceId` 必须字符串；CDN-only 常 score=0 |
| `score_speech` | Clio WSS `en.sent.score`（transcript + wavPath）→ overall/total + `en_sent_score_content`；凭据走 env |

错误形状（`structuredContent` 与 text JSON 一致）：

```json
{
  "isError": true,
  "status": "auth_required",
  "code": "AUTH_REQUIRED",
  "message": "需登录：…"
}
```

无 JWT 或 uls 返回 401 时：`status: "auth_required"` / `code: "AUTH_REQUIRED"`。

`start_listening_training` 参数与请求：

- `taskId`：必填任务 id；空字符串返回 `INVALID_ARGUMENT`。
- `ansVersion`：可选正数，默认 `1`。
- `openId`：可选；存在时作为 `openId` 请求头发送。
- 请求体为 `{ taskId, ansVersion }`，`Authorization` 使用**原始 JWT**，不加 `Bearer ` 前缀。
- 默认地址为 `https://uadaptive.unipus.cn/api/uls/user/loadPaper`；可用 `UNIPUS_ULS_ADAPTIVE_ORIGIN` / `UNIPUS_ULS_LOAD_PAPER_PATH` 覆盖。
- 口语「继续训练」是同一个 `loadPaper`。`taskId` / `ansVersion` 来自 `getUserStatusForApp?flowType=speak`。请求体没有 `flowType`。WebView 会带 `sourceid: 116`；无头只带裸 JWT 也能 `code=1`，响应里有 `token` 和 `paperJson`。
- 业务成功码接受 `0`、`1`、`200`；成功结果带 `task_id`、`paper_token`，以及从 paperJson 提取的 **`instance_ids`（精确字符串）**。
- 所有雪花 id（`q_qinstid` / `questionInstanceId`）**禁止** `Number()` / 裸 `JSON.parse`；内部用 `parseJsonPreservingLargeInts`。

`start_speaking_training`：

- 可选 `taskId` / `ansVersion` / `openId`；缺 `taskId` 或 `ansVersion` 任一则先 `GET …/getUserStatusForApp?flowType=speak`（裸 JWT + `u-app-id`，默认 `116`）补全，再复用听力同一 `loadPaper`。
- 返回形状与 `start_listening_training` 相同；成功 message 含「口语」。
- **不要**在 App WebView 已打开同一任务时调用 — `part/submit` 可能 `4021`（多设备）。
- **不要**臆造 `/api/uls/oral/train`。AI对话 / 自由表达仍见 issue **#18**。

`load_graded_questions`：

- 必填 `taskId`；可选 `ansVersion`（默认 `1`）、`openId`。
- `POST /api/uls/user/loadGradedQuestions`（默认 host `UNIPUS_ULS_ADAPTIVE_ORIGIN` / uadaptive；ucloud 亦可），裸 JWT + `u-app-id`；body `{ taskId, ansVersion }`。
- 返回 `items` 数组；进行中任务空列表为成功。GET + query → 业务 500，勿用。

有效时：`status: "ok"`，并带 `authenticated`、`expired`、`expiresAt`、`userId`（若可从 payload 安全取得）。

`list_week_progress` 成功时带：`listen_done`/`listen_total`、`speak_done`/`speak_total`，以及兼容别名 `progress_done`/`progress_total`/`level`（= 听力）。

**默认**：ucloud **raw JWT**，外加请求头 `u-app-id`（默认 `116`，`UNIPUS_U_APP_ID` 可覆盖）→ `GET /api/uls/user/getUserStatusForApp?flowType=listen` 和 `flowType=speak`。`u-app-id` 就是服务端要求的 `sourceId`，不是 query，也不等于 openId。`*_done` 是 `weekDoneTaskCount`（界面「本周总计」），`*_total` 是 `weekFrequency`（达标数，`weekDoneTaskCount >= weekFrequency` 即已达标）。数字从响应读取，不写死 3 或 6。

**试用可选**：`GET /api/uls/user/activation/status` 的 `listenTrialUsed`/`speakTrialUsed`/`trialUsageLimit`。强制旧单 GET：设 `UNIPUS_ULS_WEEK_PROGRESS_PATH` 或 `weekProgressUrl`。网络失败为 `status: "error"` / `code: "NETWORK_ERROR"`。

## 安装

在仓库根：

```sh
npm ci
```

启动（`--silent` 避免 npm 把脚本横幅写进 stdout，否则会破坏 MCP JSON-RPC）：

```sh
npm start --silent
```

`package.json` 的 `start` 是 `node --import tsx src/stdio.ts`。stdin 保持打开时进程不应退出。

也可直接跑仓库里的包装脚本（自己 `cd` 到仓库根再 `exec`）：

```sh
/ABS/PATH/TO/unipus-mcp/scripts/run-mcp.sh
```

构建产物入口（`npm run build` 后）：

```sh
node /ABS/PATH/TO/unipus-mcp/dist/index.js
```

## 挂到 Grok Bot / Cursor（AddMcpServer **没有 cwd**）

Grok Bot 的 AddMcpServer **不提供 cwd**，必须用绝对路径启动。不要依赖客户端帮你 `cd` 进仓库。把下面的 `/ABS/PATH/TO/unipus-mcp` 换成本机仓库的真实绝对路径。**不要**把账号、密码、JWT 写进 MCP 配置或工具参数。

### 方式 A：绝对路径包装脚本（推荐）

command = `scripts/run-mcp.sh` 的绝对路径，args 为空。

```json
{
  "command": "/ABS/PATH/TO/unipus-mcp/scripts/run-mcp.sh",
  "args": []
}
```

Cursor `mcpServers`：

```json
{
  "mcpServers": {
    "unipus": {
      "command": "/ABS/PATH/TO/unipus-mcp/scripts/run-mcp.sh",
      "args": []
    }
  }
}
```

Grok Bot user-scope TOML：

```toml
[mcp_servers.unipus]
command = "/ABS/PATH/TO/unipus-mcp/scripts/run-mcp.sh"
args = []
startup_timeout_sec = 60
```

### 方式 B：`npm start --silent --prefix`（绝对路径）

command = `"npm"`。`--prefix` 必须是仓库根的绝对路径；`--silent` 必填，避免 npm 横幅破坏 stdout 上的 JSON-RPC。

```json
{
  "command": "npm",
  "args": ["start", "--silent", "--prefix", "/ABS/PATH/TO/unipus-mcp"]
}
```

```toml
[mcp_servers.unipus]
command = "npm"
args = ["start", "--silent", "--prefix", "/ABS/PATH/TO/unipus-mcp"]
startup_timeout_sec = 60
```

## 和仓库根 `.grok/config.toml` 的区别

本机从**仓库根**启动的 grok（cwd = repo root）可以用相对形式，不必写绝对路径：

```toml
[mcp_servers.unipus]
command = "npm"
args = ["start", "--silent"]
startup_timeout_sec = 60
```

Grok Bot AddMcpServer 没有 cwd，必须用上面的绝对路径脚本或 `--prefix /ABS/PATH/TO/unipus-mcp`。

## 登录约定

- 登录与密钥：环境变量 / CLI / SecretSpec，**永不**作为 MCP 工具参数。
- 读取顺序：`UNIPUS_JWT` → `UNIPUS_JWT_FILE` / `UNIPUS_COOKIE_FILE` → `UNIPUS_COOKIE` → `~/.config/unipus-mcp/jwt`（或 `$XDG_CONFIG_HOME/unipus-mcp/jwt`）。
- 进度路径（可选）：默认 host `https://ucloud.unipus.cn`（`UNIPUS_ULS_ORIGIN` 可覆盖），path `UNIPUS_ULS_USER_STATUS_FOR_APP_PATH`（默认 `/api/uls/user/getUserStatusForApp`）。请求头 `u-app-id` 默认 `116`（`UNIPUS_U_APP_ID` 可覆盖），这是服务端的 `sourceId`。`UNIPUS_ULS_WEEK_PROGRESS_PATH` 若设置则**强制** legacy 单 GET。Authorization 为**原始 JWT**（不加 `Bearer `）。
- 听力训练路径（可选）：`UNIPUS_ULS_ADAPTIVE_ORIGIN`（默认 `https://uadaptive.unipus.cn`）、`UNIPUS_ULS_LOAD_PAPER_PATH`（默认 `/api/uls/user/loadPaper`）。
- 工具也不返回密码、cookie、JWT 原文。

## `upload_answer_audio`

Silent answer-audio upload (no mic):

1. `POST /api/uls/user/answer/query-upload-url` with `{ fileName }` (JWT raw Authorization on uadaptive)
2. Multipart POST to Qiniu `up-z1.qiniup.com` (`token`, `key`, `file`)
3. Returns `storage_key` + `cdn_url` (+ optional `upload_hash`)

Does **not** call `submitAnswer` yet (needs a fresh `loadPaper` token).

Args: `filePath` (required), optional `fileName`, `openId`. No credentials in tool args.

SSO helper: `npx tsx scripts/sso-login.ts` with `UNIPUS_USERNAME` / `UNIPUS_PASSWORD` → `~/.config/unipus-mcp/jwt`.

## `submit_answer`

Submit one answer after silent upload:

- Requires `paperToken` from `start_listening_training` / loadPaper (raw JWT alone is not enough).
- Args: `taskId`, `paperToken`, `instanceId`, `answer` (oral CDN URL auto-wrapped as `{record:{url}}`), optional `ansVersion` / `durationSec`.
- Live-confirmed 2026-09-21: `POST /api/uls/user/submitAnswer` returns `code:1`.

## `start_speaking_training`

Headless U口语 start (same `loadPaper` as listening):

- Optional `taskId` / `ansVersion` / `openId`; otherwise resolves via `getUserStatusForApp?flowType=speak` + `u-app-id`.
- Do **not** call while WebView is mid-task (4021). Do **not** invent `/oral/train`.
- AI对话 / 自由表达 capture remains **#18**.

## `load_graded_questions`

- Required `taskId`; optional `ansVersion` (default 1), `openId`.
- `POST …/loadGradedQuestions` with raw JWT + `u-app-id`; empty `items` OK.
- Override: `UNIPUS_ULS_LOAD_GRADED_QUESTIONS_PATH` / `UNIPUS_ULS_ADAPTIVE_ORIGIN`.

## `speak_and_submit`

One-shot silent oral path: Edge TTS → 16 kHz mono WAV → `upload_answer_audio` → `submit_answer`.

- Args: `text`, `taskId`, `paperToken`, `instanceId`; optional `voice` (default `en-US-JennyNeural`), `ansVersion`, `durationSec`, `openId`.
- Needs `ffmpeg` on PATH and network for Edge TTS + Qiniu.
- Prefer this over speaker/mic inject.

## `grade_question`

Headless grade via `POST /api/uls/rate/gradeQuestion` (raw JWT, no Bearer).

- Args: `taskId`, `questionInstanceId` (**exact string** snowflake), `questionContent` (answer JSON string), optional `ansVersion` / `isObjective` / `openId`.
- Override URL: `UNIPUS_ULS_GRADE_QUESTION_PATH` / `UNIPUS_ULS_ADAPTIVE_ORIGIN`.
- **CDN-url-only** oral `{record:{url}}` often returns **score=0**. Prefer device-shaped `EN_SENT_SCORE` under `children[0].record` (+ child `isDone`) from `score_speech` / `buildEnSentScoreQuestionContent`. When the engine returns finite review scores, the record also includes `recordDetail` and `specific_scores` (in-app snapshot: `specific_scores.total = recordDetail.score/100`). Already-submitted tasks may empty userAnswer — retest needs unsubmitted + speak quota.
- After `submit_answer`, use MCP `load_graded_questions` (`POST loadGradedQuestions` + `u-app-id: 116`). GET with query returns code 500.
- Paid week counters come from `getUserStatusForApp` (`weekDoneTaskCount` / `weekFrequency`); do not hardcode 3/5/6.

## `score_speech`

Headless Clio sentence score over `wss://speech.unipus.cn/speech/proxy/wss` (`en.sent.score`).

- Args: `transcript`, `wavPath` (16 kHz mono WAV); optional `userId`.
- Env: `UNIPUS_CLIO_APP_ID` / `UNIPUS_CLIO_APP_SECRET` (default = SPA phoneme pair from `mobile/core.js`), `UNIPUS_CLIO_WSS_URL`.
- Returns `overall` / `total`, `audio_url` (clio-audios CDN), `en_sent_score_content` / `en_sent_score_record` for `grade_question` / `submit_answer` (children-shaped; pass Qiniu URL via `clioToEnSentScoreFields` `qiniuUrl` for production path/url split). Finite SOE-style scores are copied into `recordDetail` / `specific_scores` on that record.
- Live smoke: `UNIPUS_CLIO_LIVE_SMOKE=1 npx tsx scripts/clio-score-smoke.ts ["hello world"]`.
- initialize/v2 appKey rotation and native `aiengine.provision` — see `docs/api-notes.md` (provision = native TBD; not in soe-sdk JS).


## Placement / 定级（无新 MCP 工具）

定级交卷路径见 `docs/api-notes.md`「Placement / 定级 completion path」。纯函数 helper：`src/placement-paper.ts`（`listPlacementQuestions` / `buildPlacementUserData` / `diagnosePlacementSubmitCoverage`）。

- 单题 `grade_question` 在定级卷上常返回空壳（`userId=""` / `questionInstanceId=0` / `score=null`）——**预期**，不能代替交卷。
- 单条 `submit_answer` 对多小题定级卷 → 业务码 **4295**「作答小题数存在问题」；需全卷 `userData` 且 `children` 对齐。`submit_answer` 现会以 `BUSINESS_ERROR` 打出 code/msg。
- `type=grade` → `train` 由服务端在全卷 `submitAnswer` 成功后翻转；无 skip API。
