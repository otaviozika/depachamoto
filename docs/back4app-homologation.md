# Back4app Free homologation

This branch is intentionally isolated from production. The container starts through
`scripts/back4app-entrypoint.js`, which refuses to run unless
`DEPLOYMENT_TARGET=back4app-homologation` is set.

The entrypoint always disables and clears credentials for iFood, Anota AI, Google
Sheets and Web Push. It also blocks outbound HTTP(S) from the Node process, except
for loopback or hosts explicitly listed in `HOMOLOGATION_ALLOWED_HTTP_HOSTS`.

## Required Back4app variables

- `DEPLOYMENT_TARGET=back4app-homologation`
- `NODE_ENV=production`
- `PORT=3000`
- `DATABASE_URL` (existing Supabase connection string)
- `SESSION_SECRET` (at least 32 characters)
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_NAME`
- `DB_POOL_MAX=5`
- `HOMOLOGATION_METRIC_INTERVAL_MS=15000`

Do not configure iFood, Anota AI, Google Sheets or VAPID credentials on Back4app.
The entrypoint still overrides them if they are added accidentally.

## Runtime evidence

Every container boot writes a JSON `boot` event with a unique `bootId`. Every 15
seconds it writes a `runtime` event with RSS, heap, effective CPU cores and event
loop latency. A changed `bootId` without an intentional deployment indicates a
restart. A missing `exit` event followed by a new boot, combined with memory near
the platform limit, is treated as a probable OOM.

## Read-only stages

Run the harness from a trusted machine using an existing homologation/admin account.
It performs authenticated Socket.IO handshakes and only GET health/live requests.
It never creates or changes orders.

Required variables:

- `TARGET_URL`
- `LOADTEST_USERNAME`
- `LOADTEST_PASSWORD`
- `LOAD_TEST_CONFIRM=BACK4APP_READ_ONLY`

Examples:

```text
STAGE=idle CLIENTS=0 DURATION_SECONDS=3600
STAGE=10-couriers CLIENTS=10 DURATION_SECONDS=1800
STAGE=20-couriers CLIENTS=20 DURATION_SECONDS=1800
STAGE=40-couriers CLIENTS=40 DURATION_SECONDS=3600
STAGE=burst CLIENTS=40 DURATION_SECONDS=600 READ_ONLY_BURST=250
STAGE=60-couriers CLIENTS=60 DURATION_SECONDS=1800
STAGE=websocket-long CLIENTS=40 DURATION_SECONDS=14400 RECONNECT_EVERY_SECONDS=600
STAGE=memory-soak CLIENTS=40 DURATION_SECONDS=43200 RECONNECT_EVERY_SECONDS=900
```

Run `node scripts/back4app-homologation.js` after setting the variables. Each run
writes one JSON report.

## Approval criteria at 40 clients

| Metric | Approved | Attention | Rejected |
| --- | --- | --- | --- |
| Maximum RAM | `< 210 MB`, no sustained growth | `210-230 MB` | `>= 230 MB`, OOM, or sustained growth |
| Average CPU | `< 0.12` CPU | `0.12-0.18` | `> 0.18` sustained or recurring `0.25` saturation |
| HTTP P95 | `< 350 ms` | `350-500 ms` | `> 500 ms` |
| HTTP P99 | `< 700 ms` | `700-1000 ms` | `> 1000 ms` |
| HTTP 5xx | `< 0.1%` | `0.1-0.5%` | `> 0.5%` |
| Socket success | `>= 99.5%` | `99-99.5%` | `< 99%` |
| Reconnect P95 | `< 5 s` | `5-10 s` | `> 10 s` |
| OOM / spontaneous restart | `0` | n/a | `>= 1` |

Order burst and zero lost/duplicated order validation remain blocked while this
deployment shares the production Supabase database. Run the repository's mutating
staging tests only after assigning an isolated database or an isolated Supabase
branch to the Back4app container.

