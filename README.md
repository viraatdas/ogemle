# ogemle

A lightweight Omegle-style experiment where two random visitors get paired for a one-to-one WebRTC video chat. The app uses a minimal Node.js signaling server (WebSockets) plus a React front-end that handles camera/mic permissions, peer-connection setup, and UI feedback.

## Features

- Random pairing queue so the next person to click **Start** connects with whoever has been waiting.
- WebRTC offer/answer + ICE exchange over a tiny WebSocket signaling server.
- Local/remote video preview, camera + mic toggles, and clear status updates.
- Auto-reconnect to the signaling server when the socket drops.

## Tech stack

- **Server:** Node.js, TypeScript, `ws`, nanoid
- **Client:** Vite + React + TypeScript
- **Package manager:** pnpm workspaces

## Getting started

```bash
pnpm install          # install deps for root, server, and client
pnpm dev              # run server (ws://localhost:8080) + client (http://localhost:5173)
```

Use two browser windows/tabs to mimic two strangers. Click **Start** in both panes to watch the matching + WebRTC flow take place.

### Useful scripts

| Command | Description |
| --- | --- |
| `pnpm dev:server` | Run just the WebSocket signaling server with tsx watch |
| `pnpm dev:client` | Run the Vite dev server |
| `pnpm --filter ogemle-server build` | Type-check & emit `server/dist` |
| `pnpm --filter ogemle-client build` | Type-check the React app & build to `client/dist` |

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | Listening port for the WebSocket signaling server |
| `VITE_SIGNAL_URL` | `ws://localhost:8080` | Client-side websocket endpoint (configure when deploying) |

Copy the provided examples to get started:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Update the values per environment (e.g., point `VITE_SIGNAL_URL` at the Fly.io URL once deployed).

## Deployment

### Backend (Fly.io)

The `fly.toml` and `server/Dockerfile` bundle only the signaling server. Deploy steps:

1. Install the Fly CLI and log in: `fly auth login`.
2. From the repo root run `fly launch --copy-config --config fly.toml`, pick a unique app name (replace the default `ogemle-signaling`), and skip creating a Postgres DB.
3. Deploy with `fly deploy --config fly.toml`. The Dockerfile builds the TypeScript server and exposes port `8080`.
4. Note the public URL (`https://<your-app>.fly.dev`). The signaling websocket endpoint becomes `wss://<your-app>.fly.dev`.

When you make server changes later, re-run `fly deploy --config fly.toml`.

### Frontend (Netlify)

Netlify uses `netlify.toml` to run the workspace build. Recommended flow:

1. Create a new Netlify site from this repository.
2. In Site Settings ➝ Build & deploy ➝ Environment, add `VITE_SIGNAL_URL=wss://<your-fly-app>.fly.dev`.
3. Netlify automatically runs `corepack enable pnpm && pnpm install --frozen-lockfile && pnpm --filter ogemle-client build` and publishes `client/dist`.
4. Trigger a deploy (or push to main) and visit the assigned Netlify URL. The UI will talk to the Fly-hosted signaling server via the env var above.

## How it works

1. When you press **Start**, the client grabs camera/mic, creates a `RTCPeerConnection`, and sends `ready` to the server.
2. The server either enqueues you or instantly pairs you with whoever has been waiting longer, assigning one peer as the offerer.
3. Offer/answer/ICE payloads are forwarded through the signaling server only; media flows peer-to-peer.
4. When either side leaves or disconnects, both peers get notified and the waiting user can immediately look for someone new.

## Limitations & next steps

- No TURN servers are configured, so flows may fail behind strict NAT/firewalls—add a TURN service before going to production.
- There is zero moderation, authentication, logging, or rate limiting. Build those if you plan to ship broadly.
- Mobile layout is basic; polish and add responsive controls as needed.
- No text chat, screenshots, or analytics yet.

## Testing checklist

- Start the dev servers (`pnpm dev`) and open `http://localhost:5173` in two browser tabs.
- Click **Start** in both tabs; verify local permissions, pairing, remote video, and that mic/camera toggles work.
- Close one tab and confirm the remaining tab shows "Partner disconnected" and can immediately restart.
