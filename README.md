# Watch Together

Real-time watch party app for syncing playback between two people — works with both **local video files** and **YouTube videos**. Includes lobby readiness, emoji reactions, shareable room links, a peer-to-peer WebRTC video call, and cinematic auto-hiding player controls.

The project is split into a static frontend and a separate Node/WebSocket backend so you can deploy the UI to Netlify/Vercel and the server to Render.

## Screenshots

| | |
|---|---|
| ![Homepage](frontend/assets/screenshots/ss01.png) | ![Guide](frontend/assets/screenshots/ss02.png) |
| Dashboard | New User Guide |
| ![Lobby](frontend/assets/screenshots/ss03.png) | ![Player](frontend/assets/screenshots/ss04.png) |
| Lobby | Player |

## Highlights

- **Cinematic player UI**: the timeline and controls stay visible when needed, fade away after 3 seconds of inactivity, and instantly return on mouse movement.
- **Safe interaction states**: controls stay visible while hovering, clicking, or dragging the seek bar, so the timeline never disappears mid-adjustment.
- **Works across both modes**: the same polished player experience applies to local files and YouTube watch sessions.

## Quick start

Backend:

```bash
cd backend
npm install
npm run dev
# or
npm start
```

Frontend:

- Open `frontend/index.html` locally with a static server, or deploy `frontend/` to Vercel or other.
- Point `frontend/config.js` at your deployed backend URL when frontend and backend are on different domains.

- Backend URL: `http://localhost:3001`
- WebSocket endpoint: `ws://localhost:3001/ws`
- Health check: `http://localhost:3001/health`

## Prerequisites

- **Node.js**: 14.0.0 or higher
- **npm**: 6.0.0 or higher
- **Modern browser**: Chrome, Firefox, Safari, or Edge (WebRTC support required)
- For WebRTC video call: microphone and camera access (browser will prompt)

## Configuration

### Frontend

Edit `frontend/config.js` to point to your deployed backend:

**Local development:**
```js
window.WATCH_TOGETHER_CONFIG = {
  backendBaseUrl: 'http://localhost:3001',
};
```

**Production (Render):**
```js
window.WATCH_TOGETHER_CONFIG = {
  backendBaseUrl: 'https://your-render-app-name.onrender.com',
};
```

The frontend will automatically convert the HTTP URL to WebSocket (`ws://` or `wss://`).

## Deployment

### Live App

The app is deployed and running live:
- **Frontend**: https://watchtogetherlive.vercel.app
- **Backend**: Deployed on Render (configured in frontend/config.js)

### Local Development

For local testing with both frontend and backend on the same machine:

```bash
# Terminal 1 - Backend
cd backend
npm install
npm run dev

# Terminal 2 - Frontend
cd frontend
npx http-server -p 3000
```

Then open `http://localhost:3000` and point `config.js` to `http://localhost:3001`.

## Developer testing routes

The frontend includes a **developer-only player testing mode** that is enabled only when the URL includes `?dev=player`. Normal room creation, joining, sync, and WebRTC flows stay unchanged unless that flag is present.

Use these routes while running the frontend locally:

- `?dev=player`
  Opens the watch screen immediately in **local video mode**.
  Default local video source: `sample.mp4`
  Fake PiP: enabled

- `?dev=player&video=test.mp4`
  Opens the watch screen in **local video mode** and loads a custom local video URL/path into `#movie-video`.

- `?dev=player&mode=youtube&yt=dQw4w9WgXcQ`
  Opens the watch screen in **YouTube mode** and loads the given YouTube video ID using the existing YouTube player flow.

- `?dev=player&pip=0`
  Opens player dev mode but hides the PiP bubble so layout can be tested without the call overlay.

- `?dev=player&mode=youtube&yt=dQw4w9WgXcQ&pip=0`
  Useful when testing fullscreen and control layout in YouTube mode without PiP.

### Supported query parameters

- `dev=player`
  Required flag that enables dev player mode.

- `mode=local|youtube`
  Chooses which player mode to enter.
  Default: `local`

- `video=<path-or-url>`
  Local video source used in local mode.
  Default: `sample.mp4`

- `yt=<youtube-video-id>`
  YouTube video ID used in YouTube mode.
  Example: `dQw4w9WgXcQ`

- `pip=0`
  Disables the PiP bubble in dev mode.
  Any other value, or omission, keeps PiP visible.

### Console helper

Dev mode also exposes a browser console helper:

```js
window.devPlayer({ mode: 'local', videoSrc: 'sample.mp4', showPip: true });
window.devPlayer({ mode: 'youtube', ytId: 'dQw4w9WgXcQ', showPip: false });
```

There is also a convenience loader for YouTube-only testing:

```js
window.loadYouTubeVideo('dQw4w9WgXcQ');
```

### Notes

- Dev mode is URL-gated and does **not** run unless `?dev=player` is present.
- It uses a local no-op client stub so the player UI can be exercised without creating a room.
- The watch screen is opened directly, the sync chip is forced to `synced`, and PiP can be shown or hidden for layout testing.
- If the YouTube API or video load fails, the app logs a warning to the console instead of crashing the normal app flow.

## How it works

### Local file mode (default)

1. Create a room and share the generated room code or room link.
2. Both people join the same room.
3. Each person picks the same local video file from their own device — nothing is uploaded.
4. The server compares file durations to confirm both sides picked the same movie.
5. Once both people mark ready, the app starts a synchronised countdown.
6. Both peers land on the watch screen **paused at position 0** — either person can press play to start, and the play command syncs the other side automatically.
7. Play, pause, seek, react, and video chat in sync, with player controls that fade away after inactivity and reappear as soon as you move the mouse.

### YouTube mode

1. Either person clicks the **YouTube** toggle in their player card. The other peer's UI automatically mirrors the switch — no action needed on their side.
2. Either person pastes a YouTube link. The video title and thumbnail appear immediately, and the link is broadcast to the other peer automatically — they see the same preview without pasting anything themselves.
3. The server confirms both sides have loaded the same video duration.
4. Both people mark ready and the synchronised countdown begins. Both peers land on the watch screen **paused** — either person presses play to start in sync.
5. Play, pause, and seek controls stay in sync exactly like local file mode, with the same auto-hiding timeline behavior on the watch screen.

> **Note on embedding:** YouTube videos with embedding disabled by the uploader (common for music videos and major studio trailers) will show a clear error message. The error is shown only to the person who pasted the link — the other peer sees a separate "cannot be embedded" notice. Use a different video in that case.

## Architecture

```text
Browser A (vercel)       Render backend              Browser B (vercel)
     |                        |                             |
     |── POST /api/rooms ────►|                             |
     |◄── { roomCode } ───────|                             |
     |                        |                             |
     |── WS join ────────────►|◄──── WS join ──────────────|
     |◄── joined snapshot ────|──── joined snapshot ──────►|
     |                        |                             |
     |  ── LOCAL FILE MODE ──────────────────────────────── |
     |── file_ready ─────────►|─── peer_file_ready ───────►|
     |◄══ duration_check ═════|════ duration_check ════════►|
     |                        |                             |
     |  ── YOUTUBE MODE ─────────────────────────────────── |
     |── mode_change ────────►|─── peer_mode_change ───────►|
     |── youtube_link ───────►|─── peer_youtube_link ──────►|
     |── file_ready ─────────►|─── peer_file_ready ───────►|
     |◄══ duration_check ═════|════ duration_check ════════►|
     |                        |                             |
     |  ── BOTH MODES ────────────────────────────────────  |
     |── ready_toggle ───────►|─── peer_ready ────────────►|
     |◄══ countdown_start ════|════ countdown_start ═══════►|
     |                        |                             |
     |── play_pause / seek ──►|─── relay to peer ─────────►|
     |── sync_check ─────────►|◄── sync_nudge ─────────────|
     |── reaction ───────────►|─── reaction ──────────────►|
     |── webrtc_signal ──────►|─── webrtc_signal ─────────►|
```

## Project structure

```text
.
├── frontend/
│   ├── config.js       # frontend → backend URL config
│   ├── index.html      # frontend UI
│   ├── vercel.json     # room-link rewrite to index.html
│   ├── assets/
│   └── src/
│       ├── app.js      # browser app logic (local file + YouTube)
│       ├── client.js   # websocket client SDK
│       └── webrtc.js   # peer-to-peer video call module
└── backend/
    ├── app.js          # express app and REST routes
    ├── index.js        # http + websocket server entrypoint
    ├── roomManager.js  # in-memory room state
    ├── wsHandler.js    # websocket protocol handling
    └── package.json
```

## REST API

| Method | Endpoint | Description | Response |
|--------|----------|-------------|----------|
| `POST` | `/api/rooms` | Create a new room | `{ roomCode, roomId }` |
| `GET` | `/api/rooms/:code` | Validate a room before joining | `200 { roomId, peerCount }`, `404 { error }`, or `403 { error }` when full |
| `GET` | `/health` | Server health and live counts | `{ status, rooms, peers }` |

## WebSocket message protocol

### Client → Server

| Type | Payload fields | Description |
|------|----------------|-------------|
| `join` | `roomCode, name, isHost` | Join an existing room |
| `file_ready` | `durationSec, fileName` | Report a local file duration or YouTube video duration |
| `ready_toggle` | `isReady` | Toggle ready state in the lobby |
| `play_pause` | `playing, positionSec, timestamp` | Send play/pause command |
| `seek` | `positionSec` | Send seek command |
| `sync_check` | `positionSec` | Ask the server to compare drift |
| `reaction` | `emoji` | Send an emoji reaction |
| `webrtc_signal` | `signal` | Relay SDP/ICE data for WebRTC |
| `return_to_lobby` | none | Return both users to the lobby |
| `mode_change` | `mode` | Switch room between `'local'` and `'youtube'` mode |
| `youtube_link` | `videoId, title, duration` | Share a YouTube video with the other peer |

### Server → Client

| Type | Payload fields | Description |
|------|----------------|-------------|
| `joined` | `roomCode, peers, playState, masterId, yourPeerId, roomMode, youtubeVideoId, youtubeTitle` | Room snapshot after joining, includes current YouTube state for late joiners |
| `peer_joined` | `peerId, name, isHost` | Another user joined |
| `peer_left` | `peerId, name` | Another user disconnected |
| `peer_file_ready` | `peerId, durationSec, fileName` | Peer selected a file or loaded a YouTube video |
| `duration_check` | `match, diff, durations` | Duration comparison result |
| `peer_ready` | `peerId, isReady` | Peer toggled readiness |
| `countdown_start` | `positionSec, serverTs` | Countdown before watch screen. `serverTs` lets peers that receive the message late start from a lower count so both enter the watch screen at the same moment. |
| `play_pause` | `playing, positionSec, masterId, serverTs` | Relayed playback command |
| `seek` | `positionSec, masterId, serverTs` | Relayed seek command |
| `sync_nudge` | `positionSec, drift, playing, serverTs, masterId` | Server-detected drift correction |
| `reaction` | `emoji, fromPeerId` | Relayed emoji reaction |
| `webrtc_signal` | `signal, fromPeerId` | Relayed WebRTC signal |
| `return_to_lobby` | `peerId, name` | Peer changed file / returned to lobby |
| `peer_mode_change` | `peerId, name, mode` | A peer switched between local file and YouTube mode |
| `peer_youtube_link` | `fromPeerId, videoId, title, duration` | A peer shared a YouTube video link. `duration` is included so the receiver can enable the ready button without needing to initialise the IFrame player first. |
| `error` | `message` | Server-side error. `Room full` and `Room not found` are terminal — the client stops reconnecting and returns the user to the landing screen. |

## Room lifecycle

Rooms are kept in memory on the backend. Key behaviours:

- A room is created when the host calls `POST /api/rooms` and holds its code until explicitly destroyed.
- When both peers disconnect, the room is **not destroyed immediately**. It enters a 10-minute grace window (`EMPTY_ROOM_TTL_MS`) so both users can reconnect after a network drop without losing their room code.
- The grace timer resets to zero every time someone rejoins — if a peer comes back after 8 minutes, the room gets another full 10 minutes.
- The GC runs every minute. Rooms that have been continuously empty for 10 minutes are removed.
- Rooms cap at 2 peers. A third join attempt receives `Room full`.

## YouTube integration details

### Mode toggle

Each player card has a **File / YouTube** pill toggle. Clicking YouTube broadcasts `mode_change` to the server, which relays `peer_mode_change` to the other peer. Both UIs switch simultaneously — the local file panel slides out and the YouTube link input appears on both sides.

### Link sharing

Either person pastes a YouTube URL (supports `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, and `/embed/` formats). Once a valid ID is detected the app fetches the title and thumbnail via the YouTube oEmbed API (no API key required), then sends `youtube_link` to the server with the `videoId`, `title`, and `duration`. The server relays `peer_youtube_link` to the other peer, who sees the preview card populate immediately — no manual pasting needed.

Paste and input events are deduplicated so that pasting the same URL twice in quick succession only triggers one broadcast.

The IFrame player is pre-warmed in the background so it is ready when the watch screen opens. A mutex (`ytPlayerInitPromise`) ensures only one player initialisation runs at a time, preventing race conditions when the countdown arrives while the background init is still in-flight.

### Duration matching

After both peers have the video, each side sends `file_ready` with the confirmed duration. The receiver uses the duration passed in the `peer_youtube_link` broadcast (ground truth from the sender) rather than waiting for the IFrame player to report it — this prevents a race where the player briefly reports a different duration before settling, which was producing false `duration_check` mismatches.

### Autoplay policy

Both peers land on the watch screen **paused at position 0** after the countdown. Either person presses play to start; the `play_pause` sync command brings the other peer along. This avoids browser autoplay policy blocks and gives both users a deliberate start point.

### Sync engine

YouTube playback uses the same server-authoritative sync engine as local files. `sync_check` heartbeats send `ytPlayer.getCurrentTime()`, nudges call `ytPlayer.seekTo()`, and play/pause uses `ytPlayer.playVideo()` / `ytPlayer.pauseVideo()`. The polling interval is 250 ms, giving approximately 250 ms position accuracy (vs frame-accurate for local files).

All player method calls are guarded with `typeof ytPlayer.method === 'function'` checks to handle the window between the `YT.Player` object being created and `onReady` firing, which was previously causing `"pauseVideo is not a function"` crashes when navigating back to the lobby mid-init.

### Countdown alignment

`countdown_start` includes `serverTs`. Each peer subtracts `(Date.now() - serverTs)` from the 3-second countdown, so a peer that receives the message one second late starts the countdown from `2` and both arrive at the watch screen at the same real-world instant. The handler is `async` so it can await any in-progress player init before calling `seekTo`.

### Embedding restrictions

YouTube controls which videos can be embedded in third-party sites. Videos blocked by the uploader trigger IFrame API error codes 101 or 150. The error is surfaced **only to the person who pasted the link** (via their `processYtUrl` catch block) — the other peer gets a separate "This video cannot be embedded — ask your friend to try a different one" notice. This prevents the confusing situation where the wrong user sees the embedding error.

Most content from tutorial channels, TED, Kurzgesagt, Linus Tech Tips, and independent creators embeds fine. Music videos from major labels (Vevo etc.) and many official movie trailers do not.

## WebRTC video call

`frontend/src/webrtc.js` provides a peer-to-peer call layer on top of the same WebSocket connection. The server only relays signaling messages; audio and video flow directly between browsers after negotiation succeeds.

### Usage

```js
import { VideoCall } from './src/webrtc.js';

const call = new VideoCall(client, localVideoEl, remoteVideoEl);
await call.start(isHost);

call.on('connected',         () => console.log('P2P call live'));
call.on('remote_stream',     ({ stream }) => { /* stream attached */ });
call.on('remote_camera_off', () => { /* show camera-off overlay */ });
call.on('remote_camera_on',  () => { /* hide camera-off overlay */ });

call.toggleMute();
call.toggleCamera();
call.end();
```

### Camera toggle behaviour

Camera toggle uses **track enable/disable** rather than `removeTrack`/`addTrack`. This is intentional:

- `track.enabled = false` sends black frames to the remote peer with **zero renegotiation** and no ICE restart.
- `removeTrack()` would trigger `onnegotiationneeded` → a new SDP offer → ICE restart, which caused the remote video to blank out permanently and the connection to thrash on every toggle.
- `track.stop()` permanently kills the track; it can never be re-enabled.

If the OS revokes the camera (e.g. another app takes it), the slow path acquires a new track and uses `replaceTrack()` to swap it in mid-call without renegotiation.

### Events

| Event | Detail |
|-------|--------|
| `started` | `{ hasVideo, hasAudio }` |
| `connected` | none |
| `remote_stream` | `{ stream }` |
| `remote_camera_off` | none — remote peer turned camera off |
| `remote_camera_on` | none — remote peer turned camera back on |
| `peer_disconnected` | none |
| `mute_changed` | `{ muted }` |
| `camera_changed` | `{ hidden }` |
| `camera_unavailable` | none |
| `media_unavailable` | none |
| `ice_state` | `{ state }` |
| `ice_failed` | none — gave up after max restart attempts |
| `ended` | none |

### STUN / TURN

The module tries public STUN servers first (Google, Cloudflare) then falls back to Open Relay STUN/TURN for stricter NATs. For production, replace the Open Relay credentials with your own TURN service in `frontend/src/webrtc.js`.

## Sync behavior

- Either user can control playback in both local file and YouTube modes.
- The server keeps an authoritative `playState` and extrapolates the current position while playing. The extrapolated position is capped at the shortest duration reported by either peer.
- The non-master peer sends a `sync_check` heartbeat every **1.5 seconds**. The master peer uses its heartbeat to keep the server clock accurate.
- Drift larger than **2 seconds** triggers a `sync_nudge` to the non-master peer.
- After any seek or `sync_nudge`, both sides enter a **1.5-second cooldown** before drift is checked again, preventing nudge feedback loops.
- `play_pause` commands are deduplicated by content (same `playing` state and position within 80 ms) to prevent echo storms when the mirrored command bounces back from the other peer.
- `countdown_start` includes `serverTs` so peers that receive it late still enter the watch screen at the same real-world time.
- If one user leaves, playback is paused for the remaining user. A **9-second grace window** prevents a brief WebSocket drop from tearing down the WebRTC call and forcing a full ICE renegotiation on reconnect.
- Returning to the lobby resets readiness and playback state for both users.
- When the server receives `Room full` or `Room not found` during a reconnect attempt, the client immediately stops retrying and returns the user to the landing screen with a clear message, preventing the infinite reconnect loop that floods the server with `Not in a room` errors.

## Troubleshooting

### WebSocket connection fails
- Verify the backend is running: `http://localhost:3001/health`
- Confirm `frontend/config.js` points to the correct backend URL
- Ensure `CORS_ORIGIN` in the backend env includes your frontend URL

### Video call doesn't connect
- Grant camera and microphone permissions when prompted
- Some corporate networks block WebRTC UDP — deploy your own TURN server or use Twilio/Xirsys
- Check `webrtc.js` is loading in DevTools → Network

### YouTube video shows "Watch on YouTube"
- Embedding is disabled by the uploader (error 101/150) — very common for music videos and major-label trailers
- The error is shown only to the person who pasted the link. Try a different video — tutorial channels, TED, and independent creators work fine.

### Videos drift out of sync
- For local file mode: ensure both files are identical (same encode). `duration_check` will flag a mismatch.
- For YouTube mode: confirm both sides loaded the same video ID
- Keep tabs in the foreground — backgrounded tabs throttle timers, causing drift

### Room shows "not found" after a network drop
- Empty rooms survive for 10 minutes — rejoin within that window using the same link
- After a Render cold start (free tier), all rooms are gone; create a new room

### Deployed frontend can't reach backend
- Confirm `frontend/config.js` has the full Render URL (not localhost)
- Check `CORS_ORIGIN` on the backend includes the frontend domain

## Notes

- Rooms are in-memory only, capped at 2 peers, and survive 10 minutes after both peers disconnect.
- Room links (`/COOL-1234`) auto-join the room on open.
- YouTube sync accuracy is ~250 ms (IFrame API polling). Local file sync is frame-accurate.
- Both peers always start the watch screen **paused** — autoplay is intentionally disabled.
- For development history, bug deep-dives, and root cause analysis see [`devlog.md`](./devlog.md).
