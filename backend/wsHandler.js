const { v4: uuidv4 } = require('uuid');

// ── Tolerance window for sync checks (seconds) ────────────────────────────
const SYNC_TOLERANCE_SEC = 2;

// ── Send helper ───────────────────────────────────────────────────────────
function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

// ── Broadcast to all peers in a room except optionally one ───────────────
function broadcast(room, type, payload = {}, excludePeerId = null) {
  room.peers.forEach(({ ws, peerId }) => {
    if (peerId !== excludePeerId) send(ws, type, payload);
  });
}

// ── Build a room snapshot for a newly joined peer ─────────────────────────
function roomSnapshot(room, forPeerId) {
  const peers = [];
  room.peers.forEach(p => {
    peers.push({
      peerId:       p.peerId,
      name:         p.name,
      isHost:       p.isHost,
      fileDuration: p.fileDuration,
      fileName:     p.fileName || null,
      isReady:      p.isReady,
    });
  });
  return {
    roomCode:   room.code,
    peers,
    playState:  room.playState,
    masterId:   room.playState.masterId,
    yourPeerId: forPeerId,
  };
}

// ── Main connection handler ───────────────────────────────────────────────
function handleConnection(ws, req, roomManager) {
  let myRoom   = null;
  let myPeerId = null;

  // ── Incoming messages ───────────────────────────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return send(ws, 'error', { message: 'Invalid JSON' }); }

    const { type } = msg;

    // ── JOIN ──────────────────────────────────────────────────────────────
    // Client sends: { type:'join', roomCode, name, isHost }
    if (type === 'join') {
      const room = roomManager.findByCode(msg.roomCode?.toUpperCase());
      if (!room) return send(ws, 'error', { message: 'Room not found' });
      if (room.peers.size >= 2) return send(ws, 'error', { message: 'Room full' });

      myPeerId = uuidv4();
      myRoom   = room;
      roomManager.addPeer(room, ws, myPeerId, msg.name || 'Guest', !!msg.isHost);

      // Tell this peer their identity + current room state
      send(ws, 'joined', roomSnapshot(room, myPeerId));

      // Tell every OTHER peer someone arrived
      broadcast(room, 'peer_joined', {
        peerId: myPeerId,
        name:   msg.name || 'Guest',
        isHost: !!msg.isHost,
      }, myPeerId);

      console.log(`[WS] ${msg.name} joined ${room.code}`);
      return;
    }

    // Guard: must be in a room for all other messages
    if (!myRoom || !myPeerId) return send(ws, 'error', { message: 'Not in a room' });

    // ── FILE_READY ────────────────────────────────────────────────────────
    // Client sends: { type:'file_ready', durationSec, fileName }
    // Server checks if durations match (within tolerance), tells both peers.
    if (type === 'file_ready') {
      const peer = myRoom.peers.get(myPeerId);
      peer.fileDuration = msg.durationSec;
      peer.fileName = msg.fileName || null;

      broadcast(myRoom, 'peer_file_ready', {
        peerId:      myPeerId,
        durationSec: msg.durationSec,
        fileName:    msg.fileName || null,
      }, myPeerId);  // Exclude sender so they don't get their own message back

      // Check if both peers have loaded files
      const allPeers = [...myRoom.peers.values()];
      if (allPeers.length === 2 && allPeers.every(p => p.fileDuration !== null)) {
        const [a, b] = allPeers;
        const diff = Math.abs(a.fileDuration - b.fileDuration);
        const match = diff <= SYNC_TOLERANCE_SEC;
        broadcast(myRoom, 'duration_check', {
          match,
          diff,
          durations: { [a.peerId]: a.fileDuration, [b.peerId]: b.fileDuration },
        });
        console.log(`[Sync] ${myRoom.code} duration check: ${match ? '✓ match' : `✗ drift ${diff}s`}`);
      }
      return;
    }

    // ── READY_TOGGLE ──────────────────────────────────────────────────────
    // Client sends: { type:'ready_toggle', isReady }
    if (type === 'ready_toggle') {
      const peer  = myRoom.peers.get(myPeerId);
      peer.isReady = !!msg.isReady;

      broadcast(myRoom, 'peer_ready', { peerId: myPeerId, isReady: peer.isReady });

      // If all peers ready → countdown start signal
      const allPeers = [...myRoom.peers.values()];
      if (allPeers.length === 2 && allPeers.every(p => p.isReady)) {
        // Sync position to 0 and tell everyone to count down
        myRoom.playState = { playing: false, positionSec: 0, lastUpdatedAt: Date.now(), masterId: myRoom.playState.masterId };
        broadcast(myRoom, 'countdown_start', { positionSec: 0 });
        console.log(`[Sync] ${myRoom.code} both ready → countdown`);
      }
      return;
    }

    // ── PLAY_PAUSE ────────────────────────────────────────────────────────
    // The device that pressed play/pause becomes master for this action.
    // Client sends: { type:'play_pause', playing, positionSec, timestamp }
    if (type === 'play_pause') {
      const ps = myRoom.playState;
      ps.playing       = !!msg.playing;
      ps.positionSec   = msg.positionSec ?? roomManager.currentPosition(myRoom);
      ps.lastUpdatedAt = Date.now();
      ps.masterId      = myPeerId; // this peer is now master

      // Relay exact command to the other peer so they mirror it
      broadcast(myRoom, 'play_pause', {
        playing:     ps.playing,
        positionSec: ps.positionSec,
        masterId:    myPeerId,
        serverTs:    Date.now(), // peer can use this for latency compensation
      }, myPeerId);

      console.log(`[Sync] ${myRoom.code} ${ps.playing ? '▶' : '⏸'} @ ${ps.positionSec.toFixed(1)}s (master: ${myPeerId.slice(0,8)})`);
      return;
    }

    // ── SEEK ─────────────────────────────────────────────────────────────
    // Client sends: { type:'seek', positionSec }
    if (type === 'seek') {
      const ps = myRoom.playState;
      ps.positionSec   = msg.positionSec;
      ps.lastUpdatedAt = Date.now();
      ps.masterId      = myPeerId;

      broadcast(myRoom, 'seek', {
        positionSec: msg.positionSec,
        masterId:    myPeerId,
        serverTs:    Date.now(),
      }, myPeerId);

      console.log(`[Sync] ${myRoom.code} seek → ${msg.positionSec.toFixed(1)}s`);
      return;
    }

    // ── SYNC_CHECK ────────────────────────────────────────────────────────
    // Periodic heartbeat from client. Server compares reported position
    // against server-authoritative position and nudges if drifted.
    // Client sends: { type:'sync_check', positionSec }
    if (type === 'sync_check') {
      // Let the current master refresh the authoritative clock using its
      // actual playback position instead of a blind server-side timer.
      if (myPeerId === myRoom.playState.masterId) {
        myRoom.playState.positionSec = msg.positionSec;
        myRoom.playState.lastUpdatedAt = Date.now();
        return;
      }

      const serverPos = roomManager.currentPosition(myRoom);
      const drift     = Math.abs(msg.positionSec - serverPos);

      if (drift > SYNC_TOLERANCE_SEC) {
        send(ws, 'sync_nudge', {
          positionSec: serverPos,
          drift,
          playing:     myRoom.playState.playing,
          serverTs:    Date.now(),
          masterId:    myRoom.playState.masterId,
        });
        console.log(`[Sync] ${myRoom.code} nudging peer ${myPeerId.slice(0,8)} drift=${drift.toFixed(2)}s`);
      }
      return;
    }

    // ── REACTION ─────────────────────────────────────────────────────────
    // Client sends: { type:'reaction', emoji }
    if (type === 'reaction') {
      broadcast(myRoom, 'reaction', { emoji: msg.emoji, fromPeerId: myPeerId }, myPeerId);
      return;
    }

    if (type === 'return_to_lobby') {
      const peer = myRoom.peers.get(myPeerId);
      if (peer) peer.isReady = false;
      myRoom.playState.playing = false;
      myRoom.playState.positionSec = 0;
      myRoom.playState.lastUpdatedAt = Date.now();

      broadcast(myRoom, 'return_to_lobby', {
        peerId: myPeerId,
        name: peer?.name || 'Your friend',
      }, myPeerId);
      broadcast(myRoom, 'peer_ready', { peerId: myPeerId, isReady: false });
      console.log(`[Sync] ${myRoom.code} returning both peers to lobby`);
      return;
    }

    // ── WebRTC signalling pass-through ────────────────────────────────────
    // Relay SDP offer/answer and ICE candidates between peers for WebRTC
    // Client sends: { type:'webrtc_signal', signal: { type, sdp? / candidate? } }
    if (type === 'webrtc_signal') {
      broadcast(myRoom, 'webrtc_signal', {
        signal:     msg.signal,
        fromPeerId: myPeerId,
      }, myPeerId);
      return;
    }

    send(ws, 'error', { message: `Unknown message type: ${type}` });
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  ws.on('close', () => {
    if (!myRoom || !myPeerId) return;
    const peer = myRoom.peers.get(myPeerId);
    roomManager.removePeer(myRoom, myPeerId);

    // Notify remaining peer
    broadcast(myRoom, 'peer_left', {
      peerId: myPeerId,
      name:   peer?.name,
    });

    // Pause playback for remaining peer since sync partner is gone
    if (myRoom.peers.size > 0) {
      const serverPos = roomManager.currentPosition(myRoom);
      myRoom.playState.playing = false;
      myRoom.playState.positionSec = serverPos;
      broadcast(myRoom, 'play_pause', { playing: false, positionSec: serverPos, reason: 'peer_left' });
    }
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
}

module.exports = { handleConnection };
