# unipus-mcp（stdio）

本仓库根目录就是给 Grok Bot / Cursor 用的本机 stdio MCP。体验对齐 [K4F7/chaoxing-mcp](https://github.com/K4F7/chaoxing-mcp) / [K4F7/icourse163-mcp](https://github.com/K4F7/icourse163-mcp)：一个进程、stdio、凭据不进工具参数。

目标产品：手机 App **U听力 / U听说**（包名 `cn.unipus.cloud`），**不是**网页课「261英语视听说」。

`auth_status` 会读取环境变量/文件中的 JWT 并对 `https://ucloud.unipus.cn/api/uls/` 做探活；`list_week_progress` 默认用 **raw JWT** 调 uadaptive `GET /api/uls/user/activation/status`，字段 `listenTrialUsed`/`speakTrialUsed`/`trialUsageLimit` = **本周试用进度**（试用账号已对齐 App `tvWeekProgress`；付费周配额 5听+3口 path 未验证）。`start_listening_training` 已实现：调用 uadaptive 的 `POST /api/uls/user/loadPaper`。

## 工具

| 工具 | 说明 |
|------|------|
| `auth_status` | 探活 JWT：是否有效、粗判过期、安全 user id（密码/JWT 永不作为参数） |
| `list_week_progress` | 本周试用听+口：`listen_done`/`listen_total`、`speak_done`/`speak_total`（activation `*TrialUsed`/`trialUsageLimit`；试用已对齐）；`progress_*`/`level` 为听力别名；401→`auth_required`，网络失败→`NETWORK_ERROR` |
| `start_listening_training` | 开始听力训练；必填 `taskId`，可选 `ansVersion`（默认 `1`）和 `openId`；返回 `task_id` / `paper_token` / `instance_ids`（精确字符串，防 BigInt 精度丢失） |
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
- 业务成功码接受 `0`、`1`、`200`；成功结果带 `task_id`、`paper_token`，以及从 paperJson 提取的 **`instance_ids`（精确字符串）**。
- 所有雪花 id（`q_qinstid` / `questionInstanceId`）**禁止** `Number()` / 裸 `JSON.parse`；内部用 `parseJsonPreservingLargeInts`。

有效时：`status: "ok"`，并带 `authenticated`、`expired`、`expiresAt`、`userId`（若可从 payload 安全取得）。

`list_week_progress` 成功时带：`listen_done`/`listen_total`、`speak_done`/`speak_total`（口语未知时为 `null`），以及兼容别名 `progress_done`/`progress_total`/`level`（= 听力）。默认 path `/api/uls/user/activation/status`（uadaptive，**raw JWT**，**本周试用进度**；试用号已对齐 `tvWeekProgress`）；仅当设置 `UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH` 时才二次请求。付费周配额 path **未验证**。网络失败为 `status: "error"` / `code: "NETWORK_ERROR"`。

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
- 进度路径（可选）：`UNIPUS_ULS_ADAPTIVE_ORIGIN`（默认 `https://uadaptive.unipus.cn`）、`UNIPUS_ULS_ORIGIN`（若设置则覆盖进度 host）、`UNIPUS_ULS_WEEK_PROGRESS_PATH`（默认 `/api/uls/user/activation/status`）、`UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH`（可选二次请求；推荐同为 activation/status，通常不必设）。Authorization 为**原始 JWT**（不加 `Bearer `）。
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

## `speak_and_submit`

One-shot silent oral path: Edge TTS → 16 kHz mono WAV → `upload_answer_audio` → `submit_answer`.

- Args: `text`, `taskId`, `paperToken`, `instanceId`; optional `voice` (default `en-US-JennyNeural`), `ansVersion`, `durationSec`, `openId`.
- Needs `ffmpeg` on PATH and network for Edge TTS + Qiniu.
- Prefer this over speaker/mic inject.

## `grade_question`

Headless grade via `POST /api/uls/rate/gradeQuestion` (raw JWT, no Bearer).

- Args: `taskId`, `questionInstanceId` (**exact string** snowflake), `questionContent` (answer JSON string), optional `ansVersion` / `isObjective` / `openId`.
- Override URL: `UNIPUS_ULS_GRADE_QUESTION_PATH` / `UNIPUS_ULS_ADAPTIVE_ORIGIN`.
- **CDN-url-only** oral `{record:{url}}` often returns **score=0**. Prefer device-shaped `EN_SENT_SCORE` under `children[0].record` (+ child `isDone`) from `score_speech` / `buildEnSentScoreQuestionContent`. Do **not** put `recordDetail` in answer JSON. Already-submitted tasks may empty userAnswer — retest needs unsubmitted + speak quota.
- After `submit_answer`, results may be readable at `/api/uls/user/loadGradedQuestions` (config URL helper only; **no MCP tool yet**).
- Paid week quota 5/3 path still **unverified**.

## `score_speech`

Headless Clio sentence score over `wss://speech.unipus.cn/speech/proxy/wss` (`en.sent.score`).

- Args: `transcript`, `wavPath` (16 kHz mono WAV); optional `userId`.
- Env: `UNIPUS_CLIO_APP_ID` / `UNIPUS_CLIO_APP_SECRET` (default = SPA phoneme pair from `mobile/core.js`), `UNIPUS_CLIO_WSS_URL`.
- Returns `overall` / `total`, `audio_url` (clio-audios CDN), `en_sent_score_content` / `en_sent_score_record` for `grade_question` / `submit_answer` (children-shaped; pass Qiniu URL via `clioToEnSentScoreFields` `qiniuUrl` for production path/url split).
- Live smoke: `UNIPUS_CLIO_LIVE_SMOKE=1 npx tsx scripts/clio-score-smoke.ts ["hello world"]`.
- initialize/v2 appKey rotation and native `aiengine.provision` — see `docs/api-notes.md` (provision = native TBD; not in soe-sdk JS).


## Placement / 定级（无新 MCP 工具）

定级交卷路径见 `docs/api-notes.md`「Placement / 定级 completion path」。纯函数 helper：`src/placement-paper.ts`（`listPlacementQuestions` / `buildPlacementUserData` / `diagnosePlacementSubmitCoverage`）。

- 单题 `grade_question` 在定级卷上常返回空壳（`userId=""` / `questionInstanceId=0` / `score=null`）——**预期**，不能代替交卷。
- 单条 `submit_answer` 对多小题定级卷 → 业务码 **4295**「作答小题数存在问题」；需全卷 `userData` 且 `children` 对齐。`submit_answer` 现会以 `BUSINESS_ERROR` 打出 code/msg。
- `type=grade` → `train` 由服务端在全卷 `submitAnswer` 成功后翻转；无 skip API。
