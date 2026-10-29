# StudyDuration dual-JWT (#121)

## App fact (mitm 2026-10-28, account me)

Two concurrent `wss://ucontent.unipus.cn/unipusio/` `/userActivities` sockets:

| Role | JWT `aud` | Alg | Who kicks `uls_*` | Who receives `r_set` |
|------|-----------|-----|-------------------|----------------------|
| Native App | `edx.unipus.cn` | HS256 `iss=c4f772063dcfa98e9c50` | hub only (`shouye`/`utingli`/`ukouyu`) | **yes** (`r_Hi` + `r_set.delta`) |
| H5 WebView | `cn.unipus.sso.jwt` | RS256 | **`uls_<qiId>` listenTask** | no |

Headless reproduction (2026-10-28):

- SSO-only or edx-only uls kick → ACK `code=0`, **`rSetCount=0`**
- Dual (edx joined + optional hub, SSO kicks uls after loadAnswer/loadPaper/saveSnapshot) → **`r_set` deltas 1, 60, …**
- `openIdFromJwt` must read `open_id` (edx claim), not only `openId`

## Mint API

**Not found** in duration-capture `flows.jsonl` (nor bak). `refresh_jwt` returns SSO only.
edx JWT appears already on the first native unipusio connect (cached / minted outside capture).
Gap: need login-window capture or APK reverse of HS256 client `c4f772063dcfa98e9c50`.

## Code direction

1. Keep SSO JWT for uls `kick-v2` (and ULS HTTP).
2. Optional `edxJwt` opens native presence socket that stays joined while grind runs.
3. Soft-fail if edx missing (today’s behaviour: ACK-only, durationHours may stay 0).
4. Do not block 出分 on presence failures.

## edx JWT resolve order (`resolveEdxJwt`)

1. `UNIPUS_EDX_JWT` — inline token (optional `Bearer ` prefix)
2. `UNIPUS_EDX_JWT_FILE` — path to a file containing the token
3. `accounts/<id>/edx-jwt` — per-account file (mode `0600`), where `<id>` is the explicit `accountId` passed by grind/weekly-grind, or else `active-account.txt`

### Ops: install per-account edx JWT

```bash
# After capturing a native App edx.unipus.cn JWT for account <id>:
install -m 600 /path/to/edx.jwt ~/.config/unipus-mcp/accounts/<id>/edx-jwt
# Never commit or log the file contents. open_id in the edx JWT must match the account SSO jwt.
```

Mint API still unknown; refresh_jwt only returns SSO. Without this file (and without env), listen soft-starts SSO-only and durationHours may stay 0.

## Probe scripts (main tree, not required to ship)

- `scripts/sd-ab-probe.ts` — A/B/prelude/C
- `scripts/sd-dual-appseq.ts` — App-sequence dual (reproduced `r_set`)

## Speak (#126)

Headless probe on `me` (2026-10-29, `scripts/sd-speak-probe.ts`):

| cell | r_set | sumΔ | result |
|------|-------|------|--------|
| dual + uls listenTask-shape with speak ids | 7 | 301 | PASS |
| dual App-seq (edx ukouyu stop → SSO `/speak` uls) | 7 | 299 | PASS |
| edx joined + SSO kick hub `ukouyu` | 7 | 299 | PASS |
| edx alone kick hub `ukouyu` | 0 | 0 | FAIL |

Speak uses the same dual-JWT pattern as listen:

1. Prefer `speakStudyTarget({ taskId, questionInstanceId })` → `listenTask` with `apptype: "speak"` / `appMiddle: "/speak"`.
2. `softStartStudyDuration` + `edxJwt` → `startDualStudyDuration` (SSO kicks uls_*; edx receives `r_set`; edx hub prelude uses `ukouyu` for speak).
3. Fallback without qiId: hub `ukouyu` (needs edx presence + SSO kick to credit; edx-alone fails).
4. Soft-fail; never block 出分.

`grind-speak` resolves `edxJwt` and passes the first paper leaf qiId, mirroring `grind-listen`.

