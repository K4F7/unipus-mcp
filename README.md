# unipus-mcp

U校园AI / **U听说**（U听力 + U口语）本机 stdio MCP。

## 范围

- 目标产品：手机 App「U听力」（包名 `cn.unipus.cloud`），**不是**网页课「261英语视听说」。
- 网关线索：`https://ucloud.unipus.cn/api/uls/*`（需 JWT）；SSO：`sso.unipus.cn`。
- 登录与密钥：环境变量 / CLI / SecretSpec，**不作为 MCP 工具参数**。

## MVP 工具

1. `auth_status` — 是否已有可用 JWT / SSO session
2. `list_week_progress` — 本周听力进度（如 x/5）与级别
3. `start_listening_training` — 对应 App「开始训练」（精确 path 以抓包为准）

`auth_status` 已接入：从 `UNIPUS_JWT` / `UNIPUS_JWT_FILE`（或 `~/.config/unipus-mcp/jwt`）读取 JWT，探活 `ucloud.unipus.cn/api/uls/`。
`list_week_progress` 已接入：同一套 JWT 拉本周进度（默认 path `/api/uls/week-progress`，可用 `UNIPUS_ULS_WEEK_PROGRESS_PATH` / `UNIPUS_ULS_ORIGIN` 覆盖；抓包后只改常量）。`start_listening_training` 仍为占位。

## 登录（env / 文件，永不作为工具参数）

```sh
export UNIPUS_JWT='eyJ...'          # 或
export UNIPUS_JWT_FILE=/path/to/jwt # 原始 JWT、jwt= cookie、或 portal JSON
```

不要把密码、JWT 写进 MCP 工具参数或聊天。

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
