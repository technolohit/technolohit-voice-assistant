# Asterisk (Easybell inbound)

Docker image assets for the production `technolohit-asterisk` container. These files are the **source of truth** for the verified production deployment (registration keeper + module policy).

## Files (must match production image)

| Repo file | Role |
|-----------|------|
| `easybell-registration-keeper.sh` | Background SIP registration lifecycle |
| `docker-entrypoint.sh` | Renders PJSIP, copies configs, starts Asterisk + keeper |
| `Dockerfile` | Ubuntu 24.04 + Asterisk package image |
| `templates/pjsip.conf.template` | Easybell PJSIP registration/endpoint (envsubst) |
| `templates/modules.conf` | `autoload=yes` + explicit `noload` for unused modules |
| `.env.example` | Keeper interval defaults (no secrets) |

Dialplan (`extensions.conf`) and other templates may exist only on the deployed host/image from an earlier build; this repo intentionally does **not** change `from-easybell` dialplan in keeper/module updates.

## Docs

- [docs/asterisk-easybell-registration.md](../docs/asterisk-easybell-registration.md) — root cause, keeper behavior, final production verification, parity checks
- [docs/asterisk-module-policy.md](../docs/asterisk-module-policy.md) — module `noload` policy

## Build

```bash
docker compose build asterisk
docker compose up -d asterisk
```

For production voice-bridge image mode, keep the local build compose file and add `docker-compose.prod.yml` as an override. Set `VOICE_BRIDGE_IMAGE` to an immutable Docker Hub tag such as `thnhit/technhvoice:voice-bridge-abc1234`; see [docs/dockerhub-voice-deploy.md](../docs/dockerhub-voice-deploy.md).

Do not change voice-bridge, Postgres, n8n, monitoring, credentials, or dialplan when updating only the files listed above.
