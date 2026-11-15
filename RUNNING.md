# How the scheduled job in this repo runs

This file tells you what runs automatically in this repo and how to run it on a different machine. Use it if you move the job off GitHub Actions.

The service itself runs on Railway. GitHub Actions runs only a health check.

## Summary

| Item | Value |
|---|---|
| Workflow file | `.github/workflows/viewer-health.yml` |
| Starts when | 2 times each hour, at :17 and :47. Also by hand. |
| Runs | One `curl` to `https://pp.musicsideproject.com/health` |
| Fails when | `/health` answers with an error (for example 503 when the collector falls behind), after 3 retries |
| Secrets | None |

When a scheduled run fails, GitHub sends an email to the person who last changed the schedule. That email is the alert. If you move the check, you must make a different alert.

**Note:** GitHub turns off a schedule after 60 days with no activity in the repo. If the repo is quiet, turn the workflow on again in the Actions tab.

## Run the check locally

These steps are for a Linux server, for example your Ubuntu server.

### 1. The check
```bash
curl --fail-with-body --silent --show-error \
  --max-time 60 --retry 3 --retry-delay 60 --retry-all-errors \
  https://pp.musicsideproject.com/health
```

### 2. An alert
A local timer does not send an email. Add an alert when the check fails. For example, with a systemd service:

```ini
# /etc/systemd/system/pp-health.service
[Service]
Type=oneshot
ExecStart=/usr/bin/curl --fail-with-body --silent --show-error --max-time 60 --retry 3 --retry-delay 60 --retry-all-errors https://pp.musicsideproject.com/health
OnFailure=pp-health-alert.service
```

`pp-health-alert.service` can send a push notice (for example with ntfy) or an email.

### 3. Schedule
```ini
# /etc/systemd/system/pp-health.timer
[Timer]
OnCalendar=*-*-* *:17,47:00
Persistent=true

[Install]
WantedBy=timers.target
```

If you run the check locally, you can keep the GitHub check too. Two checks do no harm.
