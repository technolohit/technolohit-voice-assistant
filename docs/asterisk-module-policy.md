# Asterisk Module Policy

The production Easybell to AudioSocket path keeps Asterisk `autoload=yes`, but unused modules are explicitly `noload`ed in `asterisk/templates/modules.conf`.

This keeps required dependencies easy to load while preventing startup noise from unused modules from triggering false monitoring alerts such as `AppContainerErrorLogsHigh`.

**Canonical file:** `asterisk/templates/modules.conf` (copied to `/etc/asterisk/modules.conf` at container start).

Required modules for the current voice path must remain loadable:

- `app_audiosocket.so`
- `chan_audiosocket.so`
- `res_audiosocket.so`
- `chan_pjsip.so`
- `res_pjsip.so`
- `res_pjsip_outbound_registration.so`
- `res_pjsip_session.so`
- `pbx_config.so`
- `format_sln.so`
- codec basics such as `codec_alaw.so`, `codec_ulaw.so`, `codec_slin.so`, and resampling basics

Do not change Easybell registration or the `from-easybell` dialplan for this module-noise cleanup.

For the Easybell registration lifecycle keeper and stale inbound routing runbook, see [Asterisk Easybell Registration](asterisk-easybell-registration.md).

## Production verification

After deploying `modules.conf` from this repo with the keeper fix:

- `docker logs technolohit-asterisk` filtered for `ERROR`/`WARNING` is **clean** during normal operation (no false alerts from unused module load failures).
- Inbound calls work with PJSIP + AudioSocket modules loaded; see [asterisk-easybell-registration.md](./asterisk-easybell-registration.md) for SIP/keeper checks.

Rebuild only the Asterisk image when changing this file; do not edit modules inside a running container without rebuilding.
