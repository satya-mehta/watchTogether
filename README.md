# Watch Together

Real-time watch party app for syncing local video playback between two people, with lobby readiness, reactions, shareable room links, and a peer-to-peer WebRTC video call.

The Node server serves both the API/WebSocket backend and the frontend UI.

## Quick start

```bash
npm install
npm run dev
# or
npm start
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

- App URL: `http://localhost:3001`
- WebSocket endpoint: `ws://localhost:3001/ws`
- Health check: `http://localhost:3001/health`

## How it works

1. Create a room and share the generated room code or room link.
2. Both people join the same room.
3. Each person picks the same local video file.
4. The server compares file durations to catch mismatches.
5. Once both people mark ready, the app starts a countdown.
6. Play, pause, seek, react, and video chat in sync.

## Screenshots

![Homepage](/assets/screenshots/ss01.png)
<p align="center">Dashboard Screenshot</p>

---

![Guide](/assets/screenshots/ss02.png)
<p align="center">New User Guide Screenshot</p>

---

![Lobby](/assets/screenshots/ss03.png)
<p align="center">Lobby Screenshot</p>

---

![Player](/assets/screenshots/ss04.png)
<p align="center">Player Screenshot</p>

---

## Architecture

```text
Browser A (host)          Node server                 Browser B (guest)
     |                        |                             |
     |── POST /api/rooms ────►|                             |
     |◄── { roomCode } ───────|                             |
     |                        |                             |
     |── open /ROOM-CODE ────►|                             |
     |                        |◄──── open /ROOM-CODE ──────|
     |                        |                             |
     |── WS join ────────────►|                             |
     |◄── joined snapshot ────|                             |
     |                        |◄──── WS join ──────────────|
     |◄── peer_joined ────────|                             |
     |                        |──── joined snapshot ──────►|
     |                        |                             |
     |── file_ready ─────────►|                             |
     |                        |─── peer_file_ready ───────►|
     |◄══ duration_check ═════|════ duration_check ═══════►|
     |                        |                             |
     |── ready_toggle ───────►|─── peer_ready ────────────►|
     |◄══ countdown_start ════|════ countdown_start ══════►|
     |                        |                             |
     |── play_pause / seek ──►|─── relay to peer ─────────►|
     |                        |                             |
     |── sync_check ─────────►|                             |
     |◄── sync_nudge ─────────|                             |
     |                        |                             |
     |── reaction ───────────►|─── reaction ──────────────►|
     |── webrtc_signal ──────►|─── webrtc_signal ─────────►|
```

## Project structure

```text
.
├── index.html          # frontend UI
├── src/
│   ├── app.js          # browser app logic
│   ├── client.js       # websocket client SDK
│   ├── index.js        # express + ws server entrypoint
│   ├── roomManager.js  # in-memory room state
│   ├── webrtc.js       # peer-to-peer video call module
│   └── wsHandler.js    # websocket protocol handling
└── assets/screenshots/ # README images
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
| `file_ready` | `durationSec, fileName` | Report the selected local file |
| `ready_toggle` | `isReady` | Toggle ready state in the lobby |
| `play_pause` | `playing, positionSec, timestamp` | Send play/pause command |
| `seek` | `positionSec` | Send seek command |
| `sync_check` | `positionSec` | Ask the server to compare drift |
| `reaction` | `emoji` | Send an emoji reaction |
| `webrtc_signal` | `signal` | Relay SDP/ICE data for WebRTC |
| `return_to_lobby` | none | Return both users to the file-pick lobby |

### Server → Client

| Type | Payload fields | Description |
|------|----------------|-------------|
| `joined` | `roomCode, peers, playState, masterId, yourPeerId` | Room snapshot after joining |
| `peer_joined` | `peerId, name, isHost` | Another user joined |
| `peer_left` | `peerId, name` | Another user disconnected |
| `peer_file_ready` | `peerId, durationSec, fileName` | Peer selected a file |
| `duration_check` | `match, diff, durations` | Duration comparison result |
| `peer_ready` | `peerId, isReady` | Peer toggled readiness |
| `countdown_start` | `positionSec` | Countdown before watch screen |
| `play_pause` | `playing, positionSec, masterId, serverTs` | Relayed playback command |
| `seek` | `positionSec, masterId, serverTs` | Relayed seek command |
| `sync_nudge` | `positionSec, drift, playing` | Server-detected drift correction |
| `reaction` | `emoji, fromPeerId` | Relayed emoji reaction |
| `webrtc_signal` | `signal, fromPeerId` | Relayed WebRTC signal |
| `return_to_lobby` | `peerId, name` | Peer changed file / returned to lobby |
| `error` | `message` | Server-side error |

## Frontend integration

```js
import { WatchTogetherClient } from './src/client.js';

const client = new WatchTogetherClient(
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
);

await client.connect();
client.join({ roomCode: 'COOL-1234', name: 'You', isHost: true });

video.addEventListener('loadedmetadata', () => {
  client.fileReady(video.duration, file.name);
});

client.setPositionGetter(() => video.currentTime);

client.on('play_pause', async ({ playing, positionSec, serverTs }) => {
  const latencySec = (Date.now() - serverTs) / 1000;
  video.currentTime = positionSec + (playing ? latencySec : 0);
  if (playing) await video.play().catch(() => {});
  else video.pause();
});

client.on('seek', ({ positionSec }) => {
  video.currentTime = positionSec;
});

client.on('apply_sync', async ({ positionSec, playing }) => {
  video.currentTime = positionSec;
  if (playing) await video.play().catch(() => {});
  else video.pause();
});

client.on('reaction', ({ emoji }) => {
  showFloatingReaction(emoji);
});
```

## WebRTC video call

`src/webrtc.js` provides a peer-to-peer call layer on top of the same WebSocket connection. The server only relays signaling messages; audio and video flow directly between browsers after negotiation succeeds.

### Usage

```js
import { VideoCall } from './src/webrtc.js';

const call = new VideoCall(client, localVideoEl, remoteVideoEl);

await call.start(isHost);

call.on('connected', () => {
  console.log('P2P call live');
});

call.on('remote_stream', ({ stream }) => {
  console.log('Remote stream ready', stream);
});

call.toggleMute();
call.toggleCamera();
call.end();
```

### Events

| Event | Detail |
|-------|--------|
| `started` | `{ hasVideo, hasAudio }` |
| `connected` | none |
| `remote_stream` | `{ stream }` |
| `peer_disconnected` | none |
| `mute_changed` | `{ muted }` |
| `camera_changed` | `{ hidden }` |
| `camera_unavailable` | none |
| `media_unavailable` | none |
| `ice_state` | `{ state }` |
| `ended` | none |

### STUN / TURN

The module currently uses public STUN servers. For production use across stricter NATs or mobile/corporate networks, add a TURN server to `ICE_SERVERS` in `src/webrtc.js`.

## Sync behavior

- Either user can control playback.
- The server keeps an authoritative `playState` and extrapolates current position while playing.
- Drift larger than 2 seconds triggers a `sync_nudge`.
- Duration matching is used as a lightweight check that both users picked the same file.
- If one user leaves, playback is paused for the remaining user.
- Returning to the lobby resets readiness and playback state.

## Notes

- Rooms are stored in memory only.
- Each room supports up to 2 peers.
- Room links such as `/COOL-1234` open the same frontend and auto-join flow.
