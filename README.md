# Boda Dispatch

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
- [ ] Dispatcher auth
- [ ] Job CRUD
- [ ] Live job board via sockets
- [ ] Optimistic concurrency: `409 Conflict` on a stale `version`, client rebases and retries
- [ ] Offline mutation queue with `client_mutation_id` replay
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

- **Optimistic concurrency (a `version` column) over last-write-wins or CRDTs.** A job has a small set of fields with real business meaning: who it's assigned to and where it is in its lifecycle. Last-write-wins would let a dispatcher's stale screen silently undo a rider's "picked up". CRDTs merge everything automatically, but "two dispatchers assigned the job to two riders" has no correct automatic merge; a human has to choose. A compare-and-swap on `version` (`UPDATE ... WHERE id = $1 AND version = $2`) is one indexed row update with no locks held. The loser gets a `409` with the current job and can rebase. Conflicts on a single job should be rare, so the retry is cheap.
- **`client_mutation_id` + a unique index for offline replay.** A rider's app queues mutations while offline and replays them on reconnect. Because acks get lost, a mutation can arrive twice. Making the event-log insert the dedupe point means replays are idempotent without a separate idempotency store.
- **Socket.IO over raw WebSockets.** The board needs reconnection with backoff, rooms (per job, per rider), acknowledgements and a long-polling fallback for restrictive mobile networks. With raw `ws` we would rebuild all of that. The cost is a custom protocol, so clients must use a Socket.IO client, which is fine because we own every client.
- **Redis adapter for horizontal scale.** With more than one server instance, a broadcast from instance A must reach sockets connected to instance B. `@socket.io/redis-adapter` relays broadcasts through Redis pub/sub. The same Redis will later back presence. Running several instances also needs sticky sessions for the long-polling transport (or websocket-only clients).
- **PostgreSQL over MongoDB.** The core guarantees are relational: foreign keys from jobs to riders and dispatchers, check constraints (an assigned job must have a rider), a unique index for mutation dedupe, and conditional updates for optimistic concurrency, all inside transactions with the event log.
- **Shared zod schemas in a workspace package.** The server, the dashboard and (later) the rider app validate the same payloads with the same code, and socket events are typed end to end.
- **Tests run against real Postgres and Redis (Testcontainers), not mocks.** The guarantees above come from database constraints and Redis pub/sub. Mocks would test none of them.
- **Migrations run on start-up.** On a single-instance free-tier deploy, this guarantees the schema matches the code. With multiple instances it would move to a separate release step.

## Deployment

- **Server:** `render.yaml` is a Render Blueprint that creates the web service (Docker, built from the root `Dockerfile`), PostgreSQL and Key Value (Redis). Connect the repo in Render → **New → Blueprint**, then set `CORS_ORIGINS` to the dashboard's URL.
- **Dashboard:** deploy `apps/web` to Vercel (set the project root directory to `apps/web`; its `prebuild` script compiles `packages/shared` first) with `NEXT_PUBLIC_SERVER_URL` pointing at the Render service.

## License

MIT
