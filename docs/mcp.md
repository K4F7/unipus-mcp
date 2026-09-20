# unipus-mcp（stdio）

本仓库根目录就是给 Grok Bot / Cursor 用的本机 stdio MCP。体验对齐 [K4F7/chaoxing-mcp](https://github.com/K4F7/chaoxing-mcp) / [K4F7/icourse163-mcp](https://github.com/K4F7/icourse163-mcp)：一个进程、stdio、凭据不进工具参数。

目标产品：手机 App **U听力 / U听说**（包名 `cn.unipus.cloud`），**不是**网页课「261英语视听说」。

`auth_status` 会读取环境变量/文件中的 JWT 并对 `https://ucloud.unipus.cn/api/uls/` 做探活；其余工具仍返回 `not_implemented`。

## 工具

| 工具 | 说明 |
|------|------|
| `auth_status` | 探活 JWT：是否有效、粗判过期、安全 user id（密码/JWT 永不作为参数） |
| `list_week_progress` | 本周听力进度（如 x/5）与级别（占位） |
| `start_listening_training` | 对应 App「开始训练」（占位） |

错误形状（`structuredContent` 与 text JSON 一致）：

```json
{
  "isError": true,
  "status": "not_implemented",
  "code": "NOT_IMPLEMENTED",
  "message": "未实现：…"
}
```

无 JWT 或 uls 返回 401 时：`status: "auth_required"` / `code: "AUTH_REQUIRED"`。
有效时：`status: "ok"`，并带 `authenticated`、`expired`、`expiresAt`、`userId`（若可从 payload 安全取得）。

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
- 工具也不返回密码、cookie、JWT 原文。
