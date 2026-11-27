# Boda Dispatch

[![CI](https://github.com/iochieng1/boda-dispatch/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iochieng1/boda-dispatch/actions/workflows/ci.yml)

**A real-time delivery dispatch board where dispatchers and boda riders share one live view of every job, even when a rider's connection drops.**

> 🚧 Work in progress. Day 1: monorepo scaffold, database schema, health checks, Socket.IO, CI.
>
> <!-- TODO: demo GIF here once the live job board works -->
>
> **Live demo:** _coming soon_

Dispatchers create delivery jobs and assign them to boda/parcel riders across Nairobi. Riders pick up, deliver, and update job status from their phones. Everyone sees changes instantly. The hard parts are concurrent edits (two dispatchers grabbing the same job) and riders on patchy mobile data whose updates arrive late, twice, or out of order.

## Features (roadmap)

- [x] npm workspaces monorepo: Fastify server, Next.js dashboard, shared zod schemas
- [x] Fastify + TypeScript server with validated config and graceful shutdown
- [x] PostgreSQL schema and migrations for riders, dispatchers, jobs (with a `version` column) and an append-only job event log (with `client_mutation_id` dedupe)
- [x] `/health` endpoint that checks Postgres and Redis
- [x] Socket.IO on the Fastify HTTP server with the Redis adapter and typed events (`server:hello`)
- [x] Dashboard page that shows live connection status (connected / reconnecting / disconnected)
- [x] CI: lint, format, typecheck, migration drift check, integration tests on real Postgres/Redis, builds, secret scanning
- [x] Dispatcher auth: argon2id passwords, 15-minute access JWTs, rotating refresh tokens with reuse detection, authenticated sockets that refresh their token without reconnecting, Next.js login page and route guard
- [x] Job CRUD: create, list (status filter, keyset pagination), edit and cancel, with the `CREATED → ASSIGNED → PICKED_UP → DELIVERED` lifecycle enforced (`409` otherwise), a `job_events` audit trail, and a dashboard form to create jobs
- [x] Live job board: `job:created` / `job:updated` events to a dispatch room (relayed across instances by the Redis adapter), a dashboard board with a column per status, and catch-up after a reconnect via `GET /v1/jobs/changes`
- [x] Optimistic concurrency: every edit and cancel sends the `baseVersion` it was made against; a stale one gets `409 VERSION_CONFLICT` with the current job, and the dashboard rebases non-overlapping edits automatically and asks the dispatcher about overlapping ones. Assigning a rider who is `BUSY` or already on an open job gets `409 RIDER_BUSY`
- [x] Offline mutation queue: the dashboard stores every create, edit and cancel in an IndexedDB outbox before sending it, replays the queue in order on reconnect, and shows an offline banner with the number of changes waiting. Each change carries a `clientMutationId`, so a replay is applied once
- [ ] Rider React Native app with offline support
- [ ] Rider location updates
- [ ] Presence (who's online, last seen)
- [ ] Load test (many sockets across multiple server instances)

## Quick start

Requires Node 24 (`nvm use`) and Docker.

```bash
npm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d     # Postgres + Redis
npm run build:shared     # server and web import the compiled shared package
npm run db:migrate
# Create a dispatcher to log in with (prompts for the password)
npm run dispatcher:create -w @boda-dispatch/server -- --email you@example.com --name "Your Name"
npm run dev:server       # http://localhost:4000/health
npm run dev:web          # http://localhost:3000
```

## Scripts

Run from the repo root.

| Command                                  | What it does                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev:server` / `npm run dev:web` | Start the server or dashboard with hot reload                                         |
| `npm test`                               | Unit tests plus server integration tests (starts throwaway Postgres/Redis containers) |
| `npm run lint` / `npm run typecheck`     | Static checks across every workspace                                                  |
| `npm run format:check`                   | Prettier check (`npm run format` to fix)                                              |
| `npm run db:generate`                    | Generate a SQL migration after editing `apps/server/src/db/schema.ts`                 |
| `npm run db:migrate`                     | Apply migrations to `DATABASE_URL`                                                    |
| `npm run build`                          | Build shared, server and web; the server's `npm start` applies migrations, then boots |

## Project structure

```
apps/
  server/               # Fastify + Socket.IO API
    src/
      app.ts            # App factory (used by server and tests)
      server.ts         # Entry point: listen + graceful shutdown
      config.ts         # zod-validated environment variables
      realtime/         # Socket.IO server + Redis adapter
      routes/           # HTTP routes
      db/               # Drizzle schema, client, migration runner
    drizzle/            # Generated SQL migrations (committed)
    test/               # Vitest + Testcontainers integration tests
  web/                  # Next.js (App Router) dispatcher dashboard
packages/
  shared/               # zod schemas + types for socket events and jobs
```

## Trade-offs

Decisions and the reasons for them. This section grows as features land.

- **Optimistic concurrency (a `version` column) over last-write-wins or CRDTs.** A job has a small set of fields with real business meaning: who it's assigned to and where it is in its lifecycle.
  - _Last-write-wins_ needs no coordination, but a dispatcher's stale screen would silently undo someone else's change: assign a rider over another dispatcher's assignment, or reopen what a rider just picked up. Nobody would even know it happened.
  - _CRDTs_ merge every concurrent edit automatically and work fully offline, which suits text or counters. But "two dispatchers assigned the job to two different riders" has no correct automatic merge: some rule picks a winner, and the other rider rides out for nothing. The status lifecycle is also not mergeable: no CRDT can say whether `DELIVERED` and `CANCELLED` should combine.
  - _Optimistic concurrency_ makes every write name the `version` it was based on (`baseVersion`). The server writes only if that's still the current version (`UPDATE ... WHERE id = $1 AND version = $2`) and otherwise answers `409 VERSION_CONFLICT` with the job as it is now. The client then rebases, a three-way merge per field (`rebaseJobEdit` in `packages/shared`): a field only it changed is reapplied on the new version automatically; a field someone else already set to the same value is dropped; a field both changed differently goes to the dispatcher, who keeps theirs or applies their own over it. Conflicts on one job are rare, so the retry is cheap, and the dangerous case always reaches a human. Other `409`s (`JOB_CLOSED`, `INVALID_TRANSITION`, `RIDER_BUSY`) can't be fixed by a rebase, so the client shows them instead of retrying.
- **`client_mutation_id` + a unique index for offline replay.** Clients queue mutations while offline and replay them on reconnect. Because acks get lost, a mutation can arrive twice. Making the event-log insert the dedupe point means replays are idempotent without a separate idempotency store: the first event a mutation writes carries its id, and a repeat (checked under the job's row lock, or caught by the unique index when two copies of a create race) changes nothing and gets the original status code with the job as it is now, plus `Idempotent-Replayed: true`. The job as it is now, not as it was: clients keep the higher `version` anyway, so an old snapshot would only be replaced. The server checks that a repeat comes from the same dispatcher, for the same job (or, for a create, is a create); one that doesn't gets `400`. It does not compare request bodies, so a client must give every change a new id, as the dashboard does. A change that turned out to be a no-op is recorded too (an update with no changes), so its replay is recognised rather than judged against a job that has moved on.
- **An outbox, not "send now, queue on failure".** Every dashboard change goes into the IndexedDB queue first and is sent from there, so online and offline take the same path and the order of changes is the order they were made. A rebased retry keeps its mutation id, so a lost answer at any step is still deduped. A change that conflicts on replay stays in the queue, marked, until the dispatcher keeps theirs or applies their own, and later changes to the same job wait behind it (they were made on top of it); other jobs' changes carry on. The board shows each job with the dispatcher's waiting changes applied, and new changes are based on that view, so three offline edits to one job rebase onto each other instead of conflicting with themselves. Tabs share the queue, replay it one at a time under a Web Lock and tell each other about changes over a `BroadcastChannel`. Changes are stored per dispatcher and replay only for them. The page itself still needs the network to load: there is no service worker.
- **Socket.IO over raw WebSockets.** The board needs reconnection with backoff, rooms (per job, per rider), acknowledgements and a long-polling fallback for restrictive mobile networks. With raw `ws` we would rebuild all of that. The cost is a custom protocol, so clients must use a Socket.IO client, which is fine because we own every client.
- **Redis adapter for horizontal scale.** With more than one server instance, a broadcast from instance A must reach sockets connected to instance B. `@socket.io/redis-adapter` relays broadcasts through Redis pub/sub. The same Redis will later back presence. Running several instances also needs sticky sessions for the long-polling transport (or websocket-only clients).
- **PostgreSQL over MongoDB.** The core guarantees are relational: foreign keys from jobs to riders and dispatchers, check constraints (an assigned job must have a rider), a unique index for mutation dedupe, and conditional updates for optimistic concurrency, all inside transactions with the event log.
- **Short-lived access JWTs, rotating refresh tokens.** Access tokens last 15 minutes and are never stored server-side. Refresh tokens are random, stored only as SHA-256 hashes, and work once: each refresh issues a successor in the same family, and presenting a used token revokes the whole family (it was copied). On the dashboard the refresh token lives in an httpOnly, SameSite=Lax cookie on the dashboard's own origin, set by Next.js route handlers that proxy to the API, so page JavaScript only ever sees the access token. Tabs serialise refreshes with a Web Lock so they don't trip reuse detection on each other. A token re-presented within 30 seconds of its first use (`REFRESH_REUSE_GRACE_SECONDS`) is treated as a lost response and rotated again, so a reload mid-refresh doesn't end the session. Logins are rate-limited in Redis per IP and per email before any argon2 work (`LOGIN_MAX_ATTEMPTS_PER_IP`, `LOGIN_MAX_ATTEMPTS_PER_EMAIL`, `LOGIN_RATE_WINDOW_SECONDS`; set `TRUST_PROXY=true` behind a proxy).
- **Socket auth at the handshake, refresh in place.** A socket must present a valid access token to connect. Before the token expires, the client sends `auth:refresh` with its next token; the server swaps it in and the socket keeps its id and rooms. A socket whose token runs out unrefreshed gets `auth:expired` and is disconnected, so revoking a session (logout, reuse) cuts off its sockets within one token lifetime.
- **Status transitions enforced in one place, under a row lock as well as the version check.** The lifecycle is a table in `packages/shared` (`JOB_TRANSITIONS`), so the server enforces it and the dashboard can offer only valid moves. Every change runs in one transaction that does `SELECT ... FOR UPDATE`, checks `baseVersion`, the transition and the rider against the locked row, updates it with the `version` compare-and-swap and appends to `job_events`. The lock is held only for that short transaction, never across a user's think time, so this is still optimistic concurrency from the client's point of view. The lock lets the server tell the loser _why_ it lost (closed job, invalid move or stale version) from one consistent read, and keeps the audit trail in step with the job. Assigning also locks the rider's row and refuses a rider who is `BUSY` or already holds an `ASSIGNED` / `PICKED_UP` job, so two jobs racing for one rider can't both get them.
- **Keyset pagination with the last job's id as the cursor.** `GET /v1/jobs` orders by `(created_at, id)` and compares against the cursor job's own row inside Postgres, so ties and microsecond timestamps can't skip or repeat a row (a timestamp round-tripped through JavaScript would lose precision), and new jobs arriving mid-scroll don't shift pages the way `OFFSET` does.
- **Live events carry the whole job; clients keep the higher `version`.** After each committed write the server emits `job:created` or `job:updated` with the job as it now is (nothing is emitted for a no-op edit or a rejected one). Events can arrive twice or out of order, so the board replaces a job only when the incoming `version` is higher; applying an event twice is harmless.
- **Resync by `updated_at`, with an overlap.** Events sent while a dispatcher was disconnected are gone, so on every (re)connect the board calls `GET /v1/jobs/changes?since=` with the newest `updated_at` it has seen, minus 10 seconds. `updated_at` is the time a transaction began, so a slow transaction can commit after a later one the client already saw; the overlap catches those and the version check drops the repeats. The first load reads the newest 500 jobs over `GET /v1/jobs`, so very old delivered or cancelled jobs are not on the board.
- **Shared zod schemas in a workspace package.** The server, the dashboard and (later) the rider app validate the same payloads with the same code, and socket events are typed end to end.
- **Tests run against real Postgres and Redis (Testcontainers), not mocks.** The guarantees above come from database constraints and Redis pub/sub. Mocks would test none of them.
- **Migrations run on start-up.** On a single-instance free-tier deploy, this guarantees the schema matches the code. With multiple instances it would move to a separate release step.

## Deployment

- **Server:** `render.yaml` is a Render Blueprint that creates the web service (Docker, built from the root `Dockerfile`), PostgreSQL and Key Value (Redis). Connect the repo in Render → **New → Blueprint**, then set `CORS_ORIGINS` to the dashboard's URL (`JWT_SECRET` is generated for you). Create dispatchers from the service's shell with `node dist/scripts/create-dispatcher.js --email … --name …`.
- **Dashboard:** deploy `apps/web` to Vercel (set the project root directory to `apps/web`; its `prebuild` script compiles `packages/shared` first) with `NEXT_PUBLIC_SERVER_URL` pointing at the Render service.

## License

MIT
