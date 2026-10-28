# cn.unipus.cloud (U校园AI版) API map — static pass

Date: 2026-09-20 (CST)  
APK: `/workspace/unipus-apk/cn.unipus.cloud.apk` (v2.8.4 / 20840)  
jadx: `/workspace/unipus-apk/jadx-cloud` (and identical `jadx-cloud-b`)

---

## Packaging

- APK size ~176MB; package `cn.unipus.cloud`
- **爱加密 (ijiami) packer**: `classes.dex` is only ~14KB stub; real DEX encrypted
- Native shell: `assets/ijm_lib/*/libexec{,main}.so`, `assets/libijmDataEncryption*.so`, `assets/ijiami.dat`, `ijiami.ajm`
- Application stub: `s.h.e.l.l.S` / `s.h.e.l.l.A`; real Application name `cn.unipus.cloud.app.APP` (not in sources)
- jadx yields **6 Java files** only — no Retrofit / OkHttp baseUrl for U听力
- Static jadx cannot recover business code; need runtime unpack (Frida dump) or traffic capture

---

## Confirmed product surface (U听力 / adaptive / 开始训练)

| Signal | Evidence |
|--------|----------|
| Branding | Layout `utss_layout_listening_header.xml` `contentDescription="U听力"` |
| Module | **UTSS / UTS** = U听说 (U听力 + U口语); package `cn.unipus.cloud.uts.student.*` |
| Kotlin module | `META-INF/UTSStuComponent_release.kotlin_module` → `cn.unipus.cloud.uts.student.entity` / `.utils` |
| 「开始训练」 | `utss_layout_cur_train_card.xml` → `@id/tvStartTraining` text **开始训练** |
| Tabs | strings `utts_tab_listening`=听力, `utts_tab_training`=训练 |
| Deep link | `unipuscloud://open?page=ulistenspeak` (from `https://app.unipus.cn/ucloud/apd_app.html`) |
| H5 note | apd_app comments refer to **mobile.unipus.cn** as “U听说 H5” (NXDOMAIN from this box) |

Relevant layouts: `utss_fragment_listening.xml`, `utss_item_listening_task.xml`, `utss_layout_listening_header.xml`, `utss_layout_cur_train_card.xml`, `utss_fragment_speaking.xml`, …

Cordova/H5 under `assets/www` and `assets/dist` is IM/whiteboard, **not** the core listen APIs.

---

## Hosts

### From APK resources / strings (static)

| Host | Source | Notes |
|------|--------|-------|
| `app.unipus.cn` | Manifest intent-filter host; strings | Deeplink / marketing / download |
| `u.unipus.cn` | Manifest intent-filter host | Short host / deeplink |
| `my.unipus.cn` | `wbv_fragment_developer_options.xml` hint | Account portal (`:3025` in hints) |
| `devucontent.unipus.cn` | developer options | Content preview |
| `testucontent.unipus.cn` | developer options | Test content |
| `unipus.cn` | strings / email | `service@unipus.cn` |

### Speech-eval SDKs (plaintext in APK)

| Host | Notes |
|------|-------|
| `api.chivox.com`, `auth.cloud.chivox.com`, `cfg.cloud.chivox.com`, `cloud.chivox.com`, `log.cloud.chivox.com` | Chivox |
| `device-cfg.stkouyu.com`, `update.stkouyu.com`, `log.stkouyu.com`, `log1.stkouyu.com`, `auth.stkouyu.com` | 声通 / stkouyu |

### Public U校园AI版 SPA (same product family; not from packed DEX)

| Host | Notes |
|------|-------|
| **`ucloud.unipus.cn`** / **`uai.unipus.cn`** | Primary web origin (same IP); `/api/*` behind JWT |
| `sso.unipus.cn` | SSO login / refresh_jwt / logout |
| `birdflock.unipus.cn`, `birdflockqn.unipus.cn` | FE CDN + historical APK OTA |
| `ucloudqn.unipus.cn`, `unicloud.cdn.unipus.cn`, `ucontent.cdn.unipus.cn`, `cdn.unipus.cn` | CDN / static |
| `captcha.unipus.cn` | Captcha |
| `media.app.unipus.cn` | Current Android OTA path `/ota/unipuscloud/android/…` |

### Related (from Utalk decompile — **not proven** for U听力)

- `jgy.unipus.cn/tm/...` training / exercise APIs
- `utalk.unipus.cn`, `ucontent.unipus.cn`, `ucontentapi.unipus.cn`, `uexeapi.unipus.cn`, `speech.unipus.cn`

---

## Endpoints

### Best lead for U听说 / U听力 (gateway probe)

Unauthenticated HTTP against `https://ucloud.unipus.cn`:

| Pattern | No-JWT response | Meaning |
|---------|-----------------|---------|
| `/api/uls/*` (any subpath) | **401** `Missing JWT token in request` | **Real mount** (JWT gate before route); uls ≈ U Listen Speak |
| `/api/uts/*` | **404** Route Not Found | Not a gateway prefix |
| `/api/config`, `/api/menu`, … | **401** | Real SPA routes |
| `/api/<unknown>` | **404** | Main router |

**Concrete base to capture at runtime:** `https://ucloud.unipus.cn/api/uls/` (and alias `https://uai.unipus.cn/api/uls/`).

Exact subpaths for adaptive / 开始训练 are **unknown** until JWT traffic or unpacked DEX. Do not treat guessed paths (`/listen/start`, `/train/start`, …) as confirmed — the `/api/uls/` prefix is catch-all 401.

### Sample cloud SPA `/api/*` (from public webpack; JWT)

```
GET  /api/config
GET  /api/menu
GET  /api/home/statistics | /todolist | /backlog
GET  /api/account/user/info
POST /api/account/user/identity
GET  /api/school/query/list
GET  /api/user/query-config
POST /api/sso/4.0/sso/image_captcha2
```

SSO examples: `https://sso.unipus.cn/sso/login`, `/sso/logout`, `/sso/4.0/sso/refresh_jwt`.

### Speech SDK URLs (APK plaintext)

```
http://api.chivox.com/majordomo/v3.0/serverlist.txt
http://auth.cloud.chivox.com:80/servertime
http://device-cfg.stkouyu.com/
http://update.stkouyu.com/sdk.cfg
```

---

## TLS pinning

| Check | Result |
|-------|--------|
| `CertificatePinner` / ssl pin strings in APK plaintext | **Not found** |
| `comm_boot_network_security_config.xml` | cleartext permitted; **debug-overrides trust user CAs** |
| Manifest `usesCleartextTraffic` | `true` |
| Conclusion | No pinning evidence in recoverable material; user-CA MITM should work for traffic capture. Pinning could still exist inside packed DEX (unverified). |

---

## Relevant files

- `sources/s/h/e/l/l/{A,C,N,S}.java` — ijiami shell
- `resources/AndroidManifest.xml` — hosts `u.unipus.cn`, `app.unipus.cn`; shell Application
- `resources/res/layout/utss_*.xml` — U听力 UI + 开始训练
- `resources/res/layout/wbv_fragment_developer_options.xml` — my/dev/test content hosts
- `resources/res/xml/comm_boot_network_security_config.xml` — NSC
- `META-INF/UTSStuComponent_release.kotlin_module`
- `assets/ijiami.dat` / `ijm_lib/` — encrypted payload

---

## Next steps (runtime)

1. Light AVD (TCG, 2GB RAM) + install this APK  
2. mitmproxy + user CA — open **U听力** → tap **开始训练**; filter `ucloud.unipus.cn` / `uai.unipus.cn` `/api/uls/`  
3. Optional: Frida unpack after first launch to dump decrypted dex → re-jadx → grep `uls`, `listen`, Retrofit  
4. Prefer live traffic over Utalk `jgy.unipus.cn` map  

## Blockers observed on box

- Host KVM broken (`kvm_spurious_fault`); emulator only via `-accel off` (TCG), slow + memory hungry

---

## StudyDuration / 训练时长 (runtime mitm 2026-10-28)

Captured on nixos redroid + mitm with WebSocket hooks. Full notes (redacted): capture tree under `/workspace/unipus-apk/mitm/duration-capture-2026-10-28/` (`notes.md`).

### Source of `durationHours` (learning-report KPI)

**Not** part/submit `durationSec`, **not** `saveSnapshot.duration` (seen as `0`), **not** datasink buried-points (Sensors Analytics only).

**Yes:** Socket.IO presence on

`wss://ucontent.unipus.cn/unipusio/?EIO=3&transport=websocket&uuid=<openId>&token=<JWT>`

Namespace: **`/userActivities`** (Engine.IO 3 / Socket.IO).

| Direction | Event | Meaning |
|-----------|-------|---------|
| client | `kick-v2` | Start/refresh study presence (`TTL`=60s on hub) |
| client | `stop` | End presence for a `module` |
| server | `r_Hi` | Room hello (`concurrent`) |
| server | `r_set` | Duration credit tick: `delta` seconds, `msUpdate` |

Join: `40/userActivities?uuid=…&token=…` then emits `42/userActivities,<id>["kick-v2",{…}]`; acks `43/…`; client Engine.IO ping `2` / server `3` (~25s).

### Payload shape (`kick-v2` / `stop`)

```json
{
  "client": "ucloud",
  "module": "utingli|ukouyu|uls_<questionInstanceId>|shouye",
  "moduleGroup": "app|uls:<taskId>_1",
  "openId": "<uuid>",
  "sendTimestamp": 1793192719893,
  "TTL": 60,
  "tag3": "{\"role\":\"student\",\"status\":\"train\",\"OS\":\"Android\"}"
}
```

Listen task variant adds `url`, `appId`=116, `serviceId`=`uls`, and richer `tag3` (`type=train`, `apptype=listen`, `appMiddle=/listen/guide|/listen/pre-listening`, `questionInstanceId`, …). Hub `stop` omits `status=train` in `tag3`.

### Modules

| module | moduleGroup | Product surface |
|--------|-------------|-----------------|
| `shouye` | `app` | Home |
| `utingli` | `app` | U听力 hub (`status=train`); `stop` when entering listen H5 |
| `ukouyu` | `app` | U口语 hub (`status=train`); `stop` on leave |
| `uls_<qiId>` | `uls:<taskId>_1` | Listen adaptive H5; server `r_set.delta` ≈ 60s heartbeats |

Speak **hub** duration = `ukouyu`/`app`. Deeper speak-task module id was not observed in the short 口语开始训练 window.

### Headless impl (`src/study-duration.ts`)

`grind-listen` / `grind-speak` soft-start a unipusio session per paper: listen prefers `uls_*` when the first leaf `instanceId` is known (else `utingli`/`app`); speak uses `ukouyu`/`app`. Refresh kick-v2 ~45s; `stop` in `finally`. Failures are logged and **must not** block scoring / 出分.

### Side channels

- `POST https://log.unipus.cn/common/log` `eventId=durationSocketMessage|durationSocketMessageSuccess` — client echo of kick/stop (hashed openId in `msg`).
- `datasink.unipus.cn/buried-poing` (`project=ucloud|uls-app`) — analytics clicks only.

## One-line summary

**U听力 = native UTSS (`cn.unipus.cloud.uts.student`); deeplink `page=ulistenspeak`; API likely `https://ucloud.unipus.cn/api/uls/*` (JWT). Adaptive/开始训练 paths locked in ijiami — not in jadx sources.**
