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

## Code direction (#130 hard gate)

1. Keep SSO JWT for uls `kick-v2` (and ULS HTTP).
2. `edxJwt` opens native presence socket that stays joined while grind runs (required for live grind).
3. **Hard gate**: missing edx-jwt / dual failed / no `r_set` (delta≥1) → fail the grind side.
   交卷出分 alone is **not** success. Unit tests with fake JWTs (no openId) still soft-NOOP.
4. Threshold: at least one `r_set` with `delta≥1` while the paper is open (short papers may only get delta=1).

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

Mint API still unknown; refresh_jwt only returns SSO. Without this file (and without env),
live grind **fails** the side with `missing edx-jwt for account <id>` (hard gate #130).
Only accounts with a captured native App token (today: mainly **me**) can grind successfully.

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
4. Hard gate (#130): same as listen — missing edx / no dual / no r_set → fail the speak side.

`grind-speak` / `grind-listen` / `weekly-grind` require `edxJwt` up front and wait for
`r_set` credit before declaring a paper ok.

