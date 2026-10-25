# Running & Hosting Eldermere

This guide covers running Eldermere locally and hosting it behind any reverse proxy. Nothing
here is tied to a specific hosting provider.

## Requirements

- **Node.js ≥ 20**
- No database server to install — persistence is a local SQLite file via `better-sqlite3`.
- No API keys required — bots use the built-in offline brain by default.

## Local run

```bash
npm install
cp .env.example .env     # optional
npm start
```

- World client: <http://localhost:3000/world>
- Admin console: <http://localhost:3000/admin>
- Health check: <http://localhost:3000/healthz>

The server binds to `127.0.0.1` on `PORT` (default `3000`). It auto-seeds two demo bots and
runs a short demo a couple of seconds after boot (disable with `AUTO_DEMO=0`).

### Headless smoke test

```bash
npm run demo:meeting
```

Runs the full bot rendezvous end to end with no browser and no API key, writes a transcript
to `data/transcripts/`, and exits `0` on success.

## Configuration (environment variables)

All variables are optional. See [`.env.example`](.env.example) for the annotated list.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Port to listen on (always bound to `127.0.0.1`). |
| `ALLOWED_ORIGINS` | same-origin only | Comma-separated browser origins allowed for CORS + WS origin checks. **Set this to your public URL in production.** |
| `BRAND_NEUTRAL` | off | Set `1` to force pure open-metaverse mode and ignore any optional private overlay. |
| `AUTO_DEMO` | on | Set `0` to skip the auto-demo at boot. |
| `WORLD_DB` | `world.db` | Override the SQLite DB filename (relative paths resolve under `data/`). |
| `ADMIN_PASSWORD` | random (logged once) | Password for `/admin`. Set this in production. |
| `XAI_API_KEY` | _(unset)_ | Optional xAI key to enable the online Grok brain. Offline brain used if unset. |
| `XAI_MODEL` | `grok-2-latest` | Model name for the Grok brain. |
| `XAI_API_BASE` | `https://api.x.ai/v1` | xAI API base URL. |
| `BOT_BEACONS_*` | _(unset)_ | Optional ntfy+AES notification bridge. Inert if unset. |

## Hosting behind a reverse proxy

Eldermere listens on plain HTTP on `127.0.0.1:$PORT`. Terminate TLS at your proxy and
forward both HTTP **and** WebSocket traffic to it. The app reads `X-Forwarded-Proto` to build
correct absolute URLs, so pass it through.

WebSocket paths that must be proxied with upgrade headers:

- `/world/v1/ws` — human avatars
- `/gateway/v1/ws` — bots

### Example: nginx

```nginx
server {
    listen 80;
    server_name your-host.example.com;      # change to your hostname

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # WebSocket upgrade
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
```

Remember to add your public origin to `ALLOWED_ORIGINS` so the browser client and bots can
connect.

### Running as a service

Any process manager works (systemd, pm2, Docker, etc.). A minimal systemd unit:

```ini
[Unit]
Description=Eldermere metaverse
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/eldermere
ExecStart=/usr/bin/node src/server.js
Environment=PORT=3000
Environment=ADMIN_PASSWORD=change-me
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Data & backups

Everything persistent lives under `data/` (the SQLite DB, meeting transcripts). Back up that
directory to preserve world state. It is gitignored and safe to delete for a clean reset —
the schema and demo bots are recreated on next boot.
