# Forever Hotel shared WebSocket service

Independent NestJS application for authenticated browser update notifications.
It has its own source, lockfile, build, tests, Docker image and CI. It does not
connect to PostgreSQL, issue JWTs or run database migrations.

## Run

From the parent integration workspace:

```powershell
docker compose up -d --build shared-websocket
```

For native development use Node 22.14+, copy `.env.example` to a private `.env`,
set the real relay key to match MAD, and run:

```powershell
npm ci --ignore-scripts
npm run start:dev
```

The broker and central staff authentication endpoint must be running. For a
production build use `npm run build` and `npm start`. Default port is 4700.

## Contract

- `GET /health/ready`: 200 only after the RabbitMQ subscription is ready.
- `POST /internal/tickets/:subsystem`: private backend-only ticket exchange,
  requiring a Bearer JWT and matching `X-Relay-Key`. Returns a single-use,
  30-second opaque ticket; no JWT is placed in a URL.
- Socket.IO path `/socket.io`, reached by browsers through gateway
  `/realtime/socket.io`. Browser auth is `{ ticket }`, with an allowed Origin.
- `subscribe` accepts only configured channels; subsystem, role, session expiry
  and password-change restrictions are checked. Central session revocation is
  rechecked every five seconds.
- RabbitMQ topic exchange `hotel.realtime`, routing `<subsystem>.<event>`.
  Only configured event invalidations and boolean transport status reach clients;
  producer business/guest data is never forwarded.

`WEBSOCKET_SUBSYSTEMS_JSON` configures each subsystem's HTTP session-verification
URL, independent private relay key, browser origins and role/channel allowlists.
Allowed subsystem IDs are mad, hw, fds, foss, kms and wkms. The verifier must return
`sub`, `role`, `expiresAt` (Unix seconds) and `passwordChangeRequired: false`.
An unavailable verifier fails closed. Enable another subsystem only after its
owner implements that contract and its ticket/client integration.

## Verify

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:cov
```

Unit tests cover tickets, expiry, origins, roles, revocation, safe broker payloads,
reconnection and readiness. Cross-system tests live in API gateway:
build this service and MAD, set disposable `TEST_DATABASE_URL` and
`TEST_RABBITMQ_URL`, then run `npm run test:system` there. Set
`SHARED_WEBSOCKET_PATH` and `MAD_BACKEND_PATH` when checkouts use another layout.

This implementation is single-instance: tickets and client sessions are process
local and the durable queue is `shared.websocket`. Do not scale replicas without
an explicit ticket affinity/shared-ticket and per-instance fanout design. On
restart clients fetch a fresh ticket and reread their authoritative snapshots.
No Redis, extra SQL, or schema change is required for this extraction.

FDS and WMS native sockets are not automatically migrated by registering their
names. Their current clients/auth/event protocols need owner integration; the
root workspace currently enables MAD on this shared service.
