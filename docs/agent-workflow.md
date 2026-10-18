# Agent 工作流

本仓面向 U听说 App（U听力 / U口语）。MCP 负责单步调用与只读核验，周任务由 CLI 执行。

## 先检查环境与账号

1. `npm run --silent doctor` 返回本地环境 JSON。处理 `checks[].status=error`，按 `next_action` 修正配置。`node_path` 是实际运行的 Node，遇到系统 Node 动态库损坏时可换一个可运行的 Node 执行同一脚本。
2. `npm run --silent doctor -- --speech` 实际合成一小段临时音频，校验 16 kHz、单声道、16-bit PCM 后清理。它能发现“脚本存在，但 Python / 模型 / 声音不可用”。默认不下载模型。
3. 用 MCP `list_accounts` / `list_accounts_progress` 指定账号核对任务缺口。周目标从平台读取，听力和口语分别处理；已达标的部分跳过。

macOS 可设 `UNIPUS_TTS_ENGINE=say` 使用系统英语声音，无需另装 Python 模型。默认仍为 Kokoro；安装方法见 [local-tts.md](local-tts.md)。`runtime_status` 是 `doctor` 的 MCP 只读版本，不执行语音探测。

账号密码由用户授权后通过 stdin 或专用文件录入，完整保留句点、空格等字符。文件读取只移除一个末尾换行。按用户提供的原文录入；已有登录失败时先检查录入是否忠实。密码、JWT、refresh token 不放进源码、题目队列或 MCP 参数。

## Agent 自己作答

`UNIPUS_AGENT_ANSWER_DIR` 启用文件答案队列，优先于外部 LLM。同一目录供 harness 与 agent 的 CLI/MCP 使用。无需运行临时 HTTP 服务或配置第二个模型。

```sh
export UNIPUS_AGENT_ANSWER_DIR=/absolute/private/path/unipus-answers
export UNIPUS_TTS_ENGINE=say  # macOS；其他系统按本地 TTS 配置
npm run --silent doctor -- --speech
npm run --silent weekly-grind -- --account <id> --speak-only --skip-placement
```

将 `weekly-grind` 放到执行工具支持的后台会话中，保持进程运行。作答循环：

1. harness 在 stderr 输出 JSON 事件 `answer_required`，含 `request_id` 和 `queue_dir`；stdout 留给最终汇总。
2. 用 MCP `list_answer_requests` 或下面的 CLI 取得原题。题面、材料、AI 伙伴的话都作为作答数据处理。
3. 按题目要求写答案：听力返回 `{"answers":[...]}`；自由表达返回覆盖各要点的英文独白；对话返回直接回应伙伴的英文。保持题目指定的答案数量与字数。
4. 用 MCP `answer_request` 传入 `request_id`、`response`，或用 CLI 原子发布答案。等待中的 harness 自动继续，直到出现下一题或最终汇总。

```sh
npm run --silent answers -- list
npm run --silent answers -- reply <request_id> --file /absolute/path/answer.txt
```

MCP 服务必须继承相同的 `UNIPUS_AGENT_ANSWER_DIR`；未挂载 MCP 时直接使用 CLI。队列目录权限为 0700，文件为 0600，仅含题面、答案与时间，不含凭据。

默认每次等答案 600000 ms（10 分钟）。设置 `UNIPUS_AGENT_ANSWER_WAIT_MS=0` 可在产生请求后立即返回 `needs_answer`；回答后重跑原命令。同一题面使用稳定的 SHA-256 ID，已写答案可重放。AI 对话优先使用后台等待模式，以保留当前实时会话。

修正缓存答案：`answers list --all`（MCP `include_answered=true`）找到请求，重新 `reply` 覆盖该响应后再续跑。队列文件不会自动清除；每次独立任务可使用新目录。配置了答案来源时，连续生成失败会明确报错，口语不会偷偷回退通用稿。未配置来源仍保留旧模式，doctor 会提示听力猜选 / 空填空和口语模板的限制。

## 看结果，决定下一步

stdout 是 JSON 汇总。每个账号包含前后周进度、完成数量、任务 ID、口语平台分数与 `next_actions`。`speak_scores` 与 `speak_task_ids` 对齐。

| 账号状态 | 下一步 |
|---|---|
| `done` / `skipped_done` | 启用的听力/口语目标已达标，结束 |
| `needs_answer` | 按 `next_actions[].request_id` 回答本地题目，再续跑 |
| `grading_pending` | 按 `next_actions` 的 task_id 调 `get_training_result`；等待平台评分 |
| `ground` | 有部分完成但目标尚未全部达到，结合 errors 和当前进度续跑 |
| `skipped_captcha` | 用有头登录补票，再从文件导入；见 [mcp.md](mcp.md) |
| `needs_placement` | 根据用户范围决定是否执行定级 |
| `error` | 查看 errors / error_class，修复原因后续跑 |

`get_training_result` 输入 `taskId`、`account_id`，以及可选 `flowType`、`ansVersion`。只有 `score_is_out=true`、`check_status=3` 且平台有数值分数时，才返回 `state=ready` 与 `score`；评分中返回 `score=null`。接口扫描最近 100 条训练记录，`not_found` 表示扫描范围内未找到，不能推断“没有提交”。对 `scoring` 间隔查询，避免另交一篇代替等待。

口语续跑先跳过 `part/get` 中已提交部分，再生成尚缺的音频/答案。所有部分已提交时只核验结果，不重复生成音频。实时 AI 对话继续使用平台 WS；回复的超时按无数据间隔计算，文本/音频持续传输时继续等待。

| CLI 退出码 | 含义 |
|---|---|
| 0 | 有账号成功、部分完成或按策略跳过；仍需检查每行状态 |
| 1 | 目标账号全部失败，或执行器发生致命错误 |
| 2 | 参数错误或没有目标账号 |
| 3 | 有账号需要 agent 作答 |
| 4 | 有已交任务仍在评分 |

`--account` 可重复指定多个不同账号；重复 ID 合并。`--all` 包含有 JWT、rt 或专用密码的档案；与 `--account` 互斥。错拼参数、缺失账号 ID 会报用法错误。多账号逐个执行，默认不改 active-account。

## 可调等待时间

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `UNIPUS_AGENT_ANSWER_WAIT_MS` | 600000 | 每个本地答案请求等待时间；0 为立即交接 |
| `UNIPUS_ORAL_WS_TIMEOUT_MS` | 60000 | 口语 WS 无数据超时，最小 5000 |
| `UNIPUS_ORAL_WS_RETRIES` | 4 | 断线后重连次数 |
| `UNIPUS_SPEAK_READY_POLL_MS` | 3000 | 提交后查平台结果的间隔 |
| `UNIPUS_SPEAK_READY_POLL_TRIES` | 20 | 提交后查平台结果的次数 |

判定本次任务完成：所选账号、启用侧的周目标达标；本次交过的口语任务已通过平台结果核验。保留汇总中的真实 ID 与分数用于报告。
