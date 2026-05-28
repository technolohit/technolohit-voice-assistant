# Asterisk Easybell Registration

## Repository source of truth (production parity)

These paths in `technolohit-grow` are the **canonical** Asterisk image inputs. A production rebuild from this repo must produce the same runtime behavior as the verified deployment (keeper fix + module policy). Do not change dialplan, credentials, voice-bridge, Postgres, n8n, or monitoring when updating only these assets.

| Repo path | Runtime path in container |
|-----------|---------------------------|
| `asterisk/easybell-registration-keeper.sh` | `/usr/local/bin/easybell-registration-keeper.sh` |
| `asterisk/docker-entrypoint.sh` | `/usr/local/bin/docker-entrypoint.sh` |
| `asterisk/Dockerfile` | Image build |
| `asterisk/templates/pjsip.conf.template` | Rendered to `/etc/asterisk/pjsip.conf` |
| `asterisk/templates/modules.conf` | `/etc/asterisk/modules.conf` |
| `asterisk/.env.example` | Keeper interval defaults (SIP secrets stay in deploy env only) |

Operational docs: [asterisk-module-policy.md](./asterisk-module-policy.md).

**Parity check** (on the voice host, compare container file to repo before/after deploy):

```bash
docker exec technolohit-asterisk sh -c 'md5sum /usr/local/bin/easybell-registration-keeper.sh /usr/local/bin/docker-entrypoint.sh /etc/asterisk/modules.conf 2>/dev/null'
md5sum asterisk/easybell-registration-keeper.sh asterisk/docker-entrypoint.sh asterisk/templates/modules.conf
```

Keeper script diff:

```bash
docker exec technolohit-asterisk cat /usr/local/bin/easybell-registration-keeper.sh > /tmp/prod-keeper.sh
diff -u /tmp/prod-keeper.sh asterisk/easybell-registration-keeper.sh
```

## Root Cause

The intermittent inbound call failure is a stale Easybell SIP registration/contact lifecycle issue, not a voice-bridge, CDR, module-loading, or dialplan problem.

Production evidence showed:

- Asterisk reported `easybell-registration` as `Registered`.
- UDP `5060` was listening on the host.
- `voice-bridge` was listening on `127.0.0.1:9092`.
- AudioSocket and PJSIP modules were loaded.
- The `from-easybell` dialplan routed correctly to `AudioSocket(...,127.0.0.1:9092)`.
- During the broken state, `tcpdump` showed no inbound SIP `INVITE` at all.
- Manual Asterisk re-registration restored inbound calls without restarting the container:

```bash
pjsip send unregister easybell-registration
sleep 5
pjsip send register easybell-registration
```

Asterisk can show `Registered` while Easybell's inbound routing still points at a stale or invalid contact. In that state Asterisk is locally healthy, but Easybell does not deliver the inbound `INVITE` to the current reachable contact. A clean unregister/register refreshes the provider-side contact lifecycle, which is why the manual CLI sequence immediately fixed calls.

## Runtime Fix

The Asterisk image includes `/usr/local/bin/easybell-registration-keeper.sh`, started by `docker-entrypoint.sh` inside the Asterisk container.

The keeper (`asterisk/easybell-registration-keeper.sh`):

- Waits until the Asterisk CLI is ready.
- Logs with the `[easybell-keeper]` prefix.
- Sends `pjsip send register easybell-registration` every `EASYBELL_REG_KEEPER_INTERVAL` seconds (default **60**).
- Captures the full registration row whose name contains `${REG_NAME}/` (for example `easybell-registration/sip:...`).
- Treats registration as healthy only when that row contains the standalone word `Registered` (word-boundary match). Same pattern for `Unregistered`.
- Never parses the last field of the row. A broken version logged `status=236s)` because it treated the expiry suffix `(exp. 236s)` as the status.
- If registration is not `Registered` and there are no active calls, performs a clean unregister/register.
- Every `EASYBELL_FORCE_REREGISTER_EVERY` seconds (default **240**), performs a clean unregister/register when idle, even if Asterisk reports `Registered` (refreshes provider-side contact).
- Skips any forced unregister/register when `core show channels count` cannot be parsed or `active_channels` is not `0`.
- Does not exit the container when a single Asterisk CLI command fails.

Expected logs (idle):

```text
[easybell-keeper] started registration keeper reg=easybell-registration interval=60s force_every=240s
[easybell-keeper] status=Registered active_channels=0
[easybell-keeper] periodic clean re-register
```

During an active call:

```text
[easybell-keeper] status=Registered active_channels=1
[easybell-keeper] periodic clean re-register due but active call state is not idle; skipping
```

## Easybell Inbound Authentication Policy

Easybell uses digest authentication for outbound registration from Asterisk to the provider. The registration and outbound SIP side must therefore keep:

```ini
[easybell-registration]
outbound_auth=easybell-auth

[easybell-endpoint]
outbound_auth=easybell-auth
```

Inbound INVITEs from Easybell must **not** be challenged with endpoint inbound auth. The Easybell endpoint intentionally has no `auth=easybell-auth` line. Production showed that adding endpoint inbound auth caused inbound calls to fail with:

```text
Request INVITE from sip.easybell.de failed - Failed to authenticate
```

For this provider setup, inbound Easybell traffic is trusted by source/provider matching:

```ini
[easybell-endpoint]
identify_by=ip

[easybell-identify]
endpoint=easybell-endpoint
match=${EASYBELL_REGISTRAR}
```

If Easybell publishes or support provides explicit SIP source IPs for the trunk, keep those IPs in the deployed identify match configuration. Do not restore `auth=easybell-auth` on `[easybell-endpoint]`; redeploying that line will reintroduce the inbound authentication failure.

## Production verification (final)

Verified on production after deploying the corrected keeper and module policy:

- **Soak:** After **30+ minutes**, inbound calls still connect **without** restarting the Asterisk container.
- **Registration:** `pjsip show registrations` shows `easybell-registration` **Registered**.
- **Logs:** Asterisk `ERROR`/`WARNING` grep is **clean** (see [asterisk-module-policy.md](./asterisk-module-policy.md)).
- **Keeper (idle):** Every **60** seconds, `status=Registered active_channels=0`.
- **Keeper (idle):** **Periodic clean re-register** every **240** seconds when idle.
- **Keeper (in call):** `active_channels=1`; periodic clean re-register **skipped**.
- **SIP:** `tcpdump` shows inbound `INVITE` from Easybell; Asterisk replies **100 Trying** / **200 OK**.

Unhealthy keeper log (old bug — do not deploy):

```text
[easybell-keeper] status=236s) active_channels=0
```

## Configuration

Keeper defaults in `asterisk/.env.example` (also documented in repo root `.env.example`):

```bash
EASYBELL_REGISTRATION_NAME=easybell-registration
EASYBELL_REG_KEEPER_INTERVAL=60
EASYBELL_FORCE_REREGISTER_EVERY=240
```

The PJSIP template (`asterisk/templates/pjsip.conf.template`) uses a short `expiration=300`, aggressive retry intervals, `line=yes`, `support_path=yes`, and keeps `contact_user=${EASYBELL_CONTACT_USER}` unchanged. SIP user/password/registrar/contact_user are supplied at deploy time only (not committed).

## Deploy

Use the existing Docker Compose deployment for the Asterisk service. From the deployed compose directory (with `asterisk/` build context from this repo):

```bash
docker compose build asterisk
docker compose up -d asterisk
```

Do not replace the service with ad-hoc `docker run` commands and do not add host cron. The keeper is part of the Asterisk image/runtime.

## Verification

Check keeper and Asterisk logs:

```bash
docker logs --tail=120 technolohit-asterisk | egrep -i 'easybell-keeper|Registered|Unregistered|ERROR|WARNING' || true
```

Check the registration table:

```bash
docker exec technolohit-asterisk asterisk -rx "pjsip show registrations"
```

Verify Easybell endpoint auth policy:

```bash
docker exec technolohit-asterisk asterisk -rx "pjsip show endpoint easybell-endpoint" \
  | egrep -i 'Endpoint:|OutAuth|InAuth|Auth|identify_by|Identify|Match' || true
```

Expected:

- Outbound auth exists, usually shown as `OutAuth: easybell-auth`.
- No inbound auth is configured for the endpoint. There should be no `InAuth: easybell-auth` and no endpoint `auth=easybell-auth`.
- `identify_by` is `ip`.
- `[easybell-identify]` points Easybell provider traffic at `easybell-endpoint`.

Watch for inbound SIP traffic during a test call:

```bash
sudo timeout 30 tcpdump -ni any -vvv 'udp and port 5060'
```

Healthy behavior:

- `pjsip show registrations` shows `easybell-registration` as `Registered`.
- Keeper logs `status=Registered active_channels=0` about once per minute (never `status=236s)` or similar).
- About every 240 seconds when idle, logs `periodic clean re-register`.
- During a test call: keeper logs `active_channels=1` and skips forced re-register; `tcpdump` shows an inbound `INVITE` and the dialplan hands the call to AudioSocket.

## Boundaries

This fix does not change:

- Easybell credentials.
- `EASYBELL_CONTACT_USER` format.
- The inbound `from-easybell` dialplan behavior.
- voice-bridge.
- Postgres schema.
- n8n workflows.
- Monitoring rules.
