# Watch Together — Backend

Real-time movie sync server. Node.js + WebSockets.

## Quick start

```bash
npm install
npm run dev       # with --watch live reload
# or
npm start
```

Server runs at `http://localhost:3001`.  
WebSocket endpoint: `ws://localhost:3001/ws`

---

## Architecture

```
Browser A (host)          Server                  Browser B (guest)
     |                      |                           |
     |── POST /api/rooms ──►|                           |
     |◄─ { roomCode } ──────|                           |
     |                      |                           |
     |── WS join ──────────►|                           |
     |◄─ joined (snapshot) ─|                           |
     |                      |◄─── WS join ──────────────|
     |◄─ peer_joined ───────|                           |
     |                      |──── joined (snapshot) ───►|
     |                      |                           |
     |── file_ready ────────►── duration_check ────────►|
     |◄─────────────────────── duration_check ───────── |
     |                      |                           |
     |── ready_toggle ──────►── peer_ready ────────────►|
     |◄─────────────────────── peer_ready ──────────────|
     |                      │  (both ready)             |
     |◄─ countdown_start ───┤──── countdown_start ─────►|
     |                      |                           |
     |── play_pause ────────►──── play_pause ──────────►|  ← host is master
     |                      |                           |
     |                      |◄─── play_pause ───────────|  ← guest can also master
     |◄─ play_pause ────────|                           |
     |                      |                           |
     |── sync_check ────────►  (server compares pos)    |
     |◄─ sync_nudge ────────|  (if drift > 2s)          |
```

---

## REST API

| Method | Endpoint           | Body / Params          | Response                        |
|--------|--------------------|------------------------|---------------------------------|
| POST   | `/api/rooms`       | —                      | `{ roomCode, roomId }`          |
| GET    | `/api/rooms/:code` | code in path           | `{ roomId, peerCount }` or 404  |
| GET    | `/health`          | —                      | `{ status, rooms, peers }`      |

---

## WebSocket Message Protocol

### Client → Server

| type            | payload fields                          | description                             |
|-----------------|-----------------------------------------|-----------------------------------------|
| `join`          | `roomCode, name, isHost`                | Enter a room                            |
| `file_ready`    | `durationSec`                           | Local file loaded, report duration      |
| `ready_toggle`  | `isReady`                               | Toggle lobby ready state                |
| `play_pause`    | `playing, positionSec, timestamp`       | Play or pause (sender becomes master)   |
| `seek`          | `positionSec`                           | Seek to position                        |
| `sync_check`    | `positionSec`                           | Heartbeat — server checks for drift     |
| `reaction`      | `emoji`                                 | Send emoji reaction                     |
| `webrtc_signal` | `signal`                                | Pass WebRTC SDP/ICE to peer             |

### Server → Client

| type              | payload fields                              | description                         |
|-------------------|---------------------------------------------|-------------------------------------|
| `joined`          | `roomCode, peers, playState, yourPeerId`    | Confirmed join + room snapshot      |
| `peer_joined`     | `peerId, name, isHost`                      | Other peer connected                |
| `peer_left`       | `peerId, name`                              | Other peer disconnected             |
| `peer_file_ready` | `peerId, durationSec`                       | Other peer loaded their file        |
| `duration_check`  | `match, diff, durations`                    | Result of duration comparison       |
| `peer_ready`      | `peerId, isReady`                           | Other peer toggled ready            |
| `countdown_start` | `positionSec`                               | Both ready — start 3-2-1            |
| `play_pause`      | `playing, positionSec, masterId, serverTs`  | Relayed from master peer            |
| `seek`            | `positionSec, masterId, serverTs`           | Relayed seek command                |
| `sync_nudge`      | `positionSec, drift, playing`               | You've drifted — resync             |
| `reaction`        | `emoji, fromPeerId`                         | Relayed emoji reaction              |
| `webrtc_signal`   | `signal, fromPeerId`                        | Relayed WebRTC signal               |
| `error`           | `message`                                   | Server-side error description       |

---

## Wiring the frontend

```js
import { WatchTogetherClient } from './src/client.js';

const client = new WatchTogetherClient('ws://localhost:3001/ws');
const video  = document.querySelector('video');

await client.connect();
client.join({ roomCode: 'COZY-4827', name: 'You', isHost: true });

// Tell server your file duration after picking a file
video.addEventListener('loadedmetadata', () => {
  client.fileReady(video.duration);
});

// Give client a way to read your video position (for sync heartbeat)
client.setPositionGetter(() => video.currentTime);

// Mirror play/pause from the other peer
client.on('play_pause', ({ playing, positionSec, serverTs }) => {
  // Compensate for network latency
  const latency = (Date.now() - serverTs) / 1000;
  video.currentTime = positionSec + (playing ? latency : 0);
  playing ? video.play() : video.pause();
});

// Mirror seeks
client.on('seek', ({ positionSec }) => {
  video.currentTime = positionSec;
});

// Apply sync nudges from server
client.on('apply_sync', ({ positionSec, playing }) => {
  video.currentTime = positionSec;
  playing ? video.play() : video.pause();
});

// Show your friend's reactions
client.on('reaction', ({ emoji }) => {
  showFloatingReaction(emoji);
});

// Send your own controls
document.getElementById('play-btn').onclick = () => {
  const playing = !video.paused;
  video.paused ? video.play() : video.pause();
  client.playPause(!video.paused, video.currentTime);
};

// WebRTC signals (peer-to-peer video call)
client.on('webrtc_signal', ({ signal }) => {
  peerConnection.addIceCandidate(signal) // or setRemoteDescription etc.
});
```

---

## WebRTC Video Call (`src/webrtc.js`)

Fully peer-to-peer — the server only relays SDP and ICE signals. All audio/video flows directly between browsers after the handshake.

### How the handshake works

```
Host                      Server (relay)                Guest
 |                             |                          |
 |── webrtc_signal (offer) ───►|── webrtc_signal ────────►|
 |                             |                          | (creates answer)
 |◄─ webrtc_signal (answer) ───|◄─ webrtc_signal ─────────|
 |                             |                          |
 |◄──────── ICE candidates exchanged both ways ──────────►|
 |                             |                          |
 |◄══════════ direct P2P audio+video stream ═════════════►|
```

### Usage

```js
import { VideoCall } from './src/webrtc.js';

const call = new VideoCall(client, localVideoEl, remoteVideoEl);

// Host calls start(true) — sends the first offer
// Guest calls start(false) or just waits (auto-answers on receiving offer)
await call.start(isHost);

call.on('connected', () => console.log('P2P call live!'));
call.on('remote_stream', ({ stream }) => { /* peer's video is flowing */ });

// Controls
call.toggleMute();     // returns new muted state
call.toggleCamera();   // returns new hidden state
call.end();            // hang up, release camera/mic
```

### Events emitted

| Event              | Detail                    | Description                            |
|--------------------|---------------------------|----------------------------------------|
| `started`          | `{ hasVideo, hasAudio }`  | Camera/mic acquired, connection set up |
| `connected`        | —                         | ICE handshake complete, P2P is live    |
| `remote_stream`    | `{ stream }`              | Peer's MediaStream is ready            |
| `peer_disconnected`| —                         | ICE dropped (reconnecting)             |
| `mute_changed`     | `{ muted }`               | Your mic toggled                       |
| `camera_changed`   | `{ hidden }`              | Your camera toggled                    |
| `camera_unavailable`| —                        | Fell back to audio-only                |
| `media_unavailable`| —                        | No camera or mic at all                |
| `ended`            | —                         | Call ended                             |

### TURN servers (production)

The module uses Google's free STUN servers. For peers behind strict NATs (corporate networks, some mobile carriers) you need TURN servers:

```js
// In webrtc.js, replace ICE_SERVERS with:
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls:       'turn:your-turn-server.com:3478',
    username:   'your-username',
    credential: 'your-password',
  },
];
```

Free options: Metered (metered.ca), Cloudflare Calls, or self-host coturn.

---

## Running the full app

```bash
# 1. Install and start the server
npm install
npm run dev

# 2. Serve the frontend (any static server works)
npx serve .          # serves index.html at http://localhost:3000
# or
python3 -m http.server 3000

# 3. Open in two browser tabs (or two devices on the same network)
#    Tab A: Create a room → copy the code
#    Tab B: Paste the code → Join
```

---

## Sync design decisions

- **Master/follower** — whoever presses play/pause/seek becomes master for that action. No permanent master. Both peers can control.
- **Server-authoritative position** — the server tracks `positionSec` + `lastUpdatedAt` and extrapolates forward. Used for drift detection.
- **2s tolerance** — small drifts (buffering, tab switching) are ignored. Beyond 2s, `sync_nudge` fires.
- **Latency compensation** — `serverTs` is included in play/pause relays so the receiving peer can add back estimated latency.
- **Duration fingerprint** — server checks that both file durations are within 2s of each other before allowing ready state. Not a cryptographic guarantee, but catches wrong-file mistakes.
- **Auto-pause on peer_left** — if your partner disconnects, your video pauses automatically.
