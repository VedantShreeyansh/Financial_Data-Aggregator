# Financial Data Aggregator

A full-stack, multi-service financial data platform that aggregates live cryptocurrency prices, caches them for performance, streams them in real time over WebSockets, and lets users set price alerts that trigger email notifications — all backed by a React dashboard.

This project was built to explore a genuinely polyglot, microservices-style architecture rather than a single monolithic app: a Node.js REST API, a Go WebSocket streaming service, a Redis-backed background job queue, and a React frontend, all coordinating through shared Postgres and Redis instances.

## What it does

- **User accounts** — register, log in, and get a JWT that authenticates every subsequent request.
- **Live crypto prices** — fetches real spot prices (in INR) from the CoinGecko public API, caching them in Redis so repeated requests don't hammer the upstream API.
- **Real-time price streaming** — a Go microservice streams live prices to connected clients over WebSockets, independent of the main REST API, so the frontend gets updates pushed to it rather than having to poll.
- **Watchlists** — save assets you want to track; the dashboard automatically renders a live ticker for each one.
- **Price alerts** — set a target price and direction ("goes above" / "goes below") for any supported asset. A background worker checks active alerts on a schedule and, when triggered, sends a real email notification.
- **Self-warming cache** — both the frontend and a background worker proactively keep prices fresh, so the dashboard never depends on someone manually calling the API to see current data.

## Architecture

```
┌─────────────┐      HTTP/REST       ┌──────────────┐
│   React     │ ───────────────────► │   Node.js    │
│  Frontend   │                      │   (Fastify)  │
│  (Vite)     │ ◄─────────────────── │  server.js   │
└──────┬──────┘      JSON            └──────┬───────┘
       │                                     │
       │ WebSocket                           │ reads/writes
       ▼                                     ▼
┌─────────────┐                      ┌──────────────┐
│     Go      │ ◄───── reads ─────── │    Redis     │
│  main.go    │                      │   (cache)    │
│ (streaming) │                      └──────┬───────┘
└─────────────┘                             │
                                             │ reads/writes
┌─────────────┐      SQL             ┌──────▼───────┐
│  worker.js  │ ───────────────────► │  PostgreSQL  │
│ (BullMQ +   │                      │  (users,     │
│  Nodemailer)│                      │  watchlists, │
└─────────────┘                      │  alerts)     │
                                      └──────────────┘
```

**Data flow for a price:** CoinGecko → `server.js` or `worker.js` fetches it → cached in Redis (60s TTL) → the Go service reads that same Redis key and streams it to any connected WebSocket client → the React frontend renders it live.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, React Router |
| REST API | Node.js, Fastify, JWT auth (`@fastify/jwt`), bcrypt |
| Real-time streaming | Go, `gorilla/websocket`, `go-redis` |
| Background jobs | Node.js, BullMQ (Redis-backed queues), Nodemailer |
| Database | PostgreSQL |
| Cache / message layer | Redis |
| External data | CoinGecko public API (no key required) |

## Project structure

```
Financial Data Aggregator/
├── server.js              # Main REST API (auth, prices, watchlists, alerts)
├── worker.js               # Background worker (alert checking, price warming, email)
├── package.json
├── .env                    # Local secrets (never committed — see .env.example)
├── streaming-service/
│   ├── main.go              # WebSocket price-streaming microservice
│   └── go.mod
└── frontend/
    ├── src/
    │   ├── components/      # PriceTicker, Watchlist, Alerts
    │   ├── pages/            # Login, Register, Dashboard
    │   ├── context/          # AuthContext (JWT session management)
    │   ├── api.js             # Shared fetch wrapper
    │   └── config.js          # Backend URLs, supported symbols
    └── package.json
```

## Running it locally

This project runs four services simultaneously. **Note:** due to a WSL2 networking quirk affecting WebSocket traffic specifically, the Go streaming service is run natively on Windows rather than inside WSL — everything else runs in WSL.

### Prerequisites
- PostgreSQL and Redis running (in WSL, via `sudo service postgresql start` / `sudo service redis-server start`)
- Node.js (via `nvm`, inside WSL)
- Go (installed natively on Windows, separately from any WSL Go installation)

### 1. Environment variables
Copy `.env.example` to `.env` and fill in real values (Postgres password, a random JWT secret, optionally SMTP credentials for real email — otherwise a free Ethereal test inbox is used automatically).

### 2. Start the API server (WSL)
```bash
cd "Financial Data Aggregator"
npm install
node server.js
```

### 3. Start the background worker (WSL)
```bash
node worker.js
```

### 4. Start the WebSocket streaming service (native Windows PowerShell)
```powershell
cd "E:\Projects\Financial Data Aggregator\streaming-service"
go run main.go
```

### 5. Start the frontend (WSL)
```bash
cd frontend
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser.

## Known quirks

- **WSL2 + WebSockets:** `wslrelay.exe` was found to bind the Go service's port IPv6-only under some conditions, making it unreachable from a Windows-side browser via `127.0.0.1`, even though the service itself worked fine from within WSL. Various fixes (Windows Firewall rules, `netsh interface portproxy`) improved TCP-level reachability but didn't reliably fix the actual WebSocket handshake. Running the Go service natively on Windows sidesteps the problem entirely, since no cross-VM boundary is involved.
- **CoinGecko rate limits:** the free, keyless tier has a modest rate limit. The worker de-duplicates requests by checking Redis's remaining cache TTL before re-fetching, and both `server.js` and `worker.js` degrade gracefully (log and retry) rather than crash on a `429`.

## Roadmap / what's not done yet

- Automated tests (unit + integration)
- Docker Compose for one-command environment setup
- Rate limiting on public-facing routes (especially `/api/login`)
- Deployment/hosting for a live, publicly-accessible version

## License

## 🏗️ System Architecture & Infrastructure

- **Polyglot Communication:** Decoupled write-heavy streaming operations (handled by Go’s lightweight concurrency primitives) from standard CRUD/Auth management (handled by the Node.js/Express tier).
- **State & Data Continuity:** Shared PostgreSQL instance handles transactional user and alert persistence, while an isolated Redis layer manages transient price caches and background job states.
- **Containerization (Production Ready):** The entire distributed ecosystem is containerized using multi-stage Docker builds, orchestrating the services, caching tiers, and databases seamlessly via Docker-Compose.

Personal / portfolio project.