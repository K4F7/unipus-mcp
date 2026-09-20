# API notes (living)

Source of truth until runtime capture: copy key bits from roadbot
`/workspace/unipus-apk/cloud-api-map.md`.

- Package: `cn.unipus.cloud` (IJM packed)
- UTSS = U听力 + U口语; deeplink `page=ulistenspeak`
- Likely prefix: `GET/POST https://ucloud.unipus.cn/api/uls/*` (401 without JWT)
- Alias origin: `uai.unipus.cn`
- Speech SDKs (secondary): chivox / stkouyu — not MVP

## Configurable ULS paths (capture later → change constant / env)

| Constant / env | Default | Used by |
|----------------|---------|---------|
| `DEFAULT_ULS_WEEK_PROGRESS_PATH` / `UNIPUS_ULS_WEEK_PROGRESS_PATH` | `/api/uls/week-progress` | `list_week_progress` |
| `UNIPUS_ULS_ORIGIN` | `https://ucloud.unipus.cn` | week-progress URL base |

Exact subpaths for 「本周进度」/「开始训练」are **unknown** until mitm; defaults are placeholders so a later capture only changes a constant (or env).

Stable MCP fields for week progress (independent of upstream shape):
`progress_done`, `progress_total`, `level` (parser also accepts aliases like `done`/`total`/`levelName` and nested `data`/`result`).

Update this file when mitm captures 「开始训练」/ week-progress paths.
