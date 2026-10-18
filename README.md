# unipus-mcp

U校园AI / **U听说**（U听力 + U口语）本机 stdio MCP。

Agent 执行训练与排错入口：[docs/agent-workflow.md](docs/agent-workflow.md)。支持本地文件交接答案（无需另配 LLM）、环境自检、断点续做与平台出分核验。

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
7. `runtime_status` / `list_answer_requests` / `answer_request` / `get_training_result` — agent 自检、答案交接与只读结果核验

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

`npx tsx scripts/weekly-grind.ts [--account <id>]… | --all [--listen-only|--speak-only]` — stateless multi-account listen/speak gap fill for AI harness routines. Per-account `meta.grind` (`both`|`listen`|`speak`, default both) plus CLI override; set via `accounts.ts grind <id> …`. MCP still has no scheduler.

Speak grind defaults to local Kokoro. Select `UNIPUS_TTS_ENGINE=kokoro|piper|say|edge|flite|auto`; `say` uses macOS built-in speech, while explicit `auto` uses Edge with flite fallback. Run `npm run --silent doctor -- --speech` before training. See [docs/local-tts.md](docs/local-tts.md).

Set `UNIPUS_AGENT_ANSWER_DIR` to an absolute directory to let the driving agent answer listening/free-talk/dialogue prompts via files or MCP, without an external LLM key. The harness waits for each answer and emits `answer_required` JSON events on stderr. See [the handoff workflow](docs/agent-workflow.md).

Once accounts are resolved, stdout carries a JSON summary with per-account status, progress, task IDs, actual speaking scores and `next_actions`. Exit 0 = some success/partial completion/policy skip, 1 = all targets errored, 2 = usage/no targets, 3 = agent answer required, 4 = submitted task still grading. Inspect every account row before declaring completion.
