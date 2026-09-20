# API notes (living)

Source of truth until runtime capture: copy key bits from roadbot
`/workspace/unipus-apk/cloud-api-map.md`.

- Package: `cn.unipus.cloud` (IJM packed)
- UTSS = U听力 + U口语; deeplink `page=ulistenspeak`
- Likely prefix: `GET/POST https://ucloud.unipus.cn/api/uls/*` (401 without JWT)
- Alias origin: `uai.unipus.cn`
- Speech SDKs (secondary): chivox / stkouyu — not MVP

Update this file when mitm captures 「开始训练」 paths.
