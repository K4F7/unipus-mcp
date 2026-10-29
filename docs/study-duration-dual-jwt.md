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

**Not found** (research 2026-10-29). No HTTP mint URL/fields suitable for box `obtainEdxJwt`.

Evidence:

- Duration + live mitm `flows.jsonl`: `http_resp_edx=0`; edx HS256 only appears as WS query `token=` on `wss://umcs.unipus.cn/umcs/` and `wss://ucontent.unipus.cn/unipusio/` (`aud=edx.unipus.cn`, `iss=c4f772063dcfa98e9c50`, claim `open_id`, ~1y `exp`).
- `POST https://sso.unipus.cn/sso/4.0/sso/login` and `refresh_jwt` return SSO RS256 `jwt`+`rt` only (`aud=cn.unipus.sso.jwt`) — no edx field.
- `GET https://u.unipus.cn/user/data/getToken` (public unipus-tool annotator path) is **not** edx; with SSO cookies it currently returns HTML. Empty-secret forged `aud=edx.unipus.cn` JWTs used as `X-Annotator-Auth-Token` are for content API only; unipusio `/userActivities` rejects them with `Signature verification failed`.
- `https://umcs.unipus.cn/api/*` stubs return `{"umcs":"OK"}` — not a token mint.
- Client-side forge with secrets `{iss, appId, empty, common words}` fails server verify; weak HMAC dictionary against captured me edx signature: 0 hits. APK is ijiami-packed (secret not in plaintext resources).

Leading theory: App locally signs HS256 with embedded secret (`iss` = key id). Gap: recover secret (Frida/memory after login) or finish cold-start login-window mitm if an HTTP mint was missed. Prefer mint API over per-account mitm; until then install `accounts/<id>/edx-jwt` from App capture only.

Do **not** ship a forge-based obtainer in unipus-mcp — server rejects bad signatures.

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

## Mint / obtaining edx-jwt

Proven facts (2026-10-29, alice→nixos redroid+mitm capture):

- **No HTTP mint** observed. SSO `login` / `refresh_jwt` return only SSO RS256 `jwt`+`rt`.
- edx JWT is **HS256**, claims include `aud=edx.unipus.cn`, `iss=c4f772063dcfa98e9c50`, `open_id` matching SSO `openId`.
- Token first appears as WebSocket query `token=` on `umcs.unipus.cn` / unipusio after App login (local sign; secret still unknown / ijiami-packed).
- **Operational obtain (self accounts):** password-login on instrumented App → open U听说 → extract `token=` from mitm `flows.jsonl` → install `accounts/<phone>/edx-jwt` mode `0600`. Do **not** ship forged HS256 (server rejects).
- Capture recipe that worked: landscape tap privacy `同意` → portrait password mode + ADBKeyboard fill → check `cb_policy_and_agreement` (login stays `enabled=false` until checked) → MainActivity → U听说.

