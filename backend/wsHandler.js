const { v4: uuidv4 } = require('uuid');

// ── Tolerance window for sync checks (seconds) ────────────────────────────
const SYNC_TOLERANCE_SEC = 2;
// ── Deduplication window for play_pause commands (ms) ────────────────────
// BUG FIX: was 300ms — too aggressive. When peer B mirrors a play/pause the
// relay arrives ~RTT ms later. 300ms blocked those legitimate mirror echoes
// AND collapsed both peers into one dedup window (they share nothing, each
// connection is its own closure, so this was never the right guard anyway).
// Real fix: deduplicate by (playing, positionSec) identity, not time alone.
const PLAY_PAUSE_DEDUP_MS = 80;

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
    roomCode:      room.code,
    peers,
    playState:     room.playState,
    masterId:      room.playState.masterId,
    yourPeerId:    forPeerId,
    roomMode:      room.youtubeVideoId ? 'youtube' : 'local',
    youtubeVideoId: room.youtubeVideoId || null,
    youtubeTitle:  room.youtubeTitle   || null,
  };
}

// ── Main connection handler ───────────────────────────────────────────────
function handleConnection(ws, req, roomManager) {
  let myRoom   = null;
  let myPeerId = null;

  // BUG FIX: track last play_pause by content (playing+position) not just time.
  // This prevents the echo storm where both peers keep re-sending the same
  // pause command back and forth after one of them mirrors it.
  let lastPlayPauseAt = 0;
  let lastPlayPausePlaying = null;
  let lastPlayPausePos = null;

  // BUG FIX: track whether we are currently inside a nudge-cooldown window.
  // Without this, every sync_check from the non-master fires a nudge, the
  // client seeks, but takes a few frames to settle — during which 4-6 more
  // nudges fire for the same drift, creating a seek storm.
  let nudgeCooldownUntil = 0;

  // ── Incoming messages ───────────────────────────────────────────────────
  ws.on('message', (raw) => {
    try {
      let msg;
      try { msg = JSON.parse(raw); }
      catch { return send(ws, 'error', { message: 'Invalid JSON' }); }

      const { type } = msg;

    // ── JOIN ──────────────────────────────────────────────────────────────
    if (type === 'join') {
      const room = roomManager.findByCode(msg.roomCode?.toUpperCase());
      if (!room) return send(ws, 'error', { message: 'Room not found' });
      if (room.peers.size >= 2) return send(ws, 'error', { message: 'Room full' });

      myPeerId = uuidv4();
      myRoom   = room;
      roomManager.addPeer(room, ws, myPeerId, msg.name || 'Guest', !!msg.isHost);

      send(ws, 'joined', roomSnapshot(room, myPeerId));

      broadcast(room, 'peer_joined', {
        peerId: myPeerId,
        name:   msg.name || 'Guest',
        isHost: !!msg.isHost,
      }, myPeerId);

      console.log(`[WS] ${msg.name} joined ${room.code}`);
      return;
    }

    if (!myRoom || !myPeerId) return send(ws, 'error', { message: 'Not in a room' });

    // ── FILE_READY ────────────────────────────────────────────────────────
    if (type === 'file_ready') {
      const peer = myRoom.peers.get(myPeerId);
      peer.fileDuration = msg.durationSec;
      peer.fileName = msg.fileName || null;

      broadcast(myRoom, 'peer_file_ready', {
        peerId:      myPeerId,
        durationSec: msg.durationSec,
        fileName:    msg.fileName || null,
      }, myPeerId);

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
    if (type === 'ready_toggle') {
      const peer  = myRoom.peers.get(myPeerId);
      peer.isReady = !!msg.isReady;

      broadcast(myRoom, 'peer_ready', { peerId: myPeerId, isReady: peer.isReady });

      const allPeers = [...myRoom.peers.values()];
      if (allPeers.length === 2 && allPeers.every(p => p.isReady)) {
        const initialMasterId = allPeers[0].peerId;
        myRoom.playState = {
          playing: false,
          positionSec: 0,
          lastUpdatedAt: Date.now(),
          masterId: initialMasterId,
        };
        broadcast(myRoom, 'countdown_start', { positionSec: 0 });
        console.log(`[Sync] ${myRoom.code} both ready → countdown (master: ${initialMasterId.slice(0,8)})`);
      }
      return;
    }

    // ── PLAY_PAUSE ────────────────────────────────────────────────────────
    // BUG FIX: old dedup checked only time (300ms window). This caused two
    // problems:
    //   1. A legitimate fast double-tap (e.g. pause then play 400ms later)
    //      was sometimes swallowed.
    //   2. When the OTHER peer mirrored the command and its echo arrived back
    //      within 300ms it was wrongly dropped, leaving one peer out of sync.
    //
    // New approach: ignore a command only if it carries the EXACT same
    // (playing, rounded position) within a tight 80ms window. This catches
    // true network duplicates without eating legitimate commands.
    if (type === 'play_pause') {
      const now = Date.now();
      const roundedPos = Math.round((msg.positionSec ?? 0) * 10); // 0.1s resolution
      const isDuplicate =
        now - lastPlayPauseAt < PLAY_PAUSE_DEDUP_MS &&
        msg.playing === lastPlayPausePlaying &&
        roundedPos  === lastPlayPausePos;

      if (isDuplicate) {
        console.log(`[Sync] ${myRoom.code} dedup play_pause from ${myPeerId.slice(0,8)}`);
        return;
      }

      lastPlayPauseAt      = now;
      lastPlayPausePlaying = msg.playing;
      lastPlayPausePos     = roundedPos;

      const ps = myRoom.playState;
      ps.playing       = !!msg.playing;
      ps.positionSec   = msg.positionSec ?? roomManager.currentPosition(myRoom);
      ps.lastUpdatedAt = now;
      ps.masterId      = myPeerId;

      // BUG FIX: reset nudge cooldown when playback state changes so the
      // non-master gets a clean slate after every play/pause.
      nudgeCooldownUntil = 0;

      broadcast(myRoom, 'play_pause', {
        playing:     ps.playing,
        positionSec: ps.positionSec,
        masterId:    myPeerId,
        serverTs:    now,
      }, myPeerId);

      console.log(`[Sync] ${myRoom.code} ${ps.playing ? '▶' : '⏸'} @ ${ps.positionSec.toFixed(1)}s (master: ${myPeerId.slice(0,8)})`);
      return;
    }

    // ── SEEK ─────────────────────────────────────────────────────────────
    // BUG FIX: after a seek the server clock was updated, but the non-master
    // peer hadn't applied it yet (takes a few frames). The old code would
    // then see 2-3s of drift on the very next sync_check and fire a nudge
    // immediately — before the seek even landed on the other client.
    // Fix: after any seek, set a nudge cooldown of 1.5s so the non-master
    // has time to apply the seek before we start drift-checking again.
    if (type === 'seek') {
      const ps = myRoom.playState;
      ps.positionSec   = msg.positionSec;
      ps.lastUpdatedAt = Date.now();
      ps.masterId      = myPeerId;

      // Give the non-master 1.5s to land the seek before nudging again
      nudgeCooldownUntil = Date.now() + 1500;

      broadcast(myRoom, 'seek', {
        positionSec: msg.positionSec,
        masterId:    myPeerId,
        serverTs:    Date.now(),
      }, myPeerId);

      console.log(`[Sync] ${myRoom.code} seek → ${msg.positionSec.toFixed(1)}s`);
      return;
    }

    // ── SYNC_CHECK ────────────────────────────────────────────────────────
    // BUG FIX: three problems fixed here:
    //
    // 1. NUDGE FEEDBACK LOOP — old code nudged on every sync_check that
    //    showed drift. The nudged client seeks, but reports stale position
    //    for a few frames, so 4-6 more nudges fire before it settles. Each
    //    nudge is a fresh seek → the client keeps jumping. Fix: per-connection
    //    nudgeCooldown (1.5s after each nudge or seek).
    //
    // 2. MASTER CLOCK DRIFT — the master sends sync_checks too, and the old
    //    code used those to update the server clock. But if the master is
    //    paused or seeking, its reported position was used as authoritative
    //    even when stale. Now we only update server clock from master when
    //    playing, and keep our own extrapolation when paused.
    //
    // 3. POST-SEEK PHANTOM DRIFT — a seek sets server positionSec correctly,
    //    but if playing=true, currentPosition() extrapolates from lastUpdatedAt
    //    which was just reset. Non-master hasn't landed the seek yet → it
    //    reports old pos → drift. Fixed by nudgeCooldown after seek.
    if (type === 'sync_check') {
      if (typeof msg.positionSec !== 'number') return;

      if (myPeerId === myRoom.playState.masterId) {
        // Only trust master's report when actually playing (not right after pause)
        if (myRoom.playState.playing) {
          myRoom.playState.positionSec   = msg.positionSec;
          myRoom.playState.lastUpdatedAt = Date.now();
        }
        return;
      }

      // Non-master: check if we're in a cooldown (seek or recent nudge)
      if (Date.now() < nudgeCooldownUntil) return;

      const serverPos = roomManager.currentPosition(myRoom);
      const drift     = Math.abs(msg.positionSec - serverPos);

      if (drift > SYNC_TOLERANCE_SEC) {
        // Set cooldown BEFORE sending nudge so back-to-back sync_checks
        // from the same client don't fire multiple nudges
        nudgeCooldownUntil = Date.now() + 1500;

        send(ws, 'sync_nudge', {
          positionSec: serverPos,
          drift,
          playing:  myRoom.playState.playing,
          serverTs: Date.now(),
          masterId: myRoom.playState.masterId,
        });

        const driftWarn = drift > 10 ? ' [LARGE DRIFT!]' : '';
        console.log(`[Sync] ${myRoom.code} nudging ${myPeerId.slice(0,8)} drift=${drift.toFixed(2)}s (peer=${msg.positionSec.toFixed(1)}s server=${serverPos.toFixed(1)}s)${driftWarn}`);
      }
      return;
    }

    // ── REACTION ─────────────────────────────────────────────────────────
    if (type === 'reaction') {
      broadcast(myRoom, 'reaction', { emoji: msg.emoji, fromPeerId: myPeerId }, myPeerId);
      return;
    }

    // ── RETURN_TO_LOBBY ───────────────────────────────────────────────────
    if (type === 'return_to_lobby') {
      const peer = myRoom.peers.get(myPeerId);
      if (peer) peer.isReady = false;
      myRoom.playState.playing     = false;
      myRoom.playState.positionSec = 0;
      myRoom.playState.lastUpdatedAt = Date.now();
      nudgeCooldownUntil = 0;

      broadcast(myRoom, 'return_to_lobby', {
        peerId: myPeerId,
        name: peer?.name || 'Your friend',
      }, myPeerId);
      broadcast(myRoom, 'peer_ready', { peerId: myPeerId, isReady: false });
      console.log(`[Sync] ${myRoom.code} returning both peers to lobby`);
      return;
    }

    // ── MODE_CHANGE ───────────────────────────────────────────────────────
    // Either peer can switch the room between local-file and YouTube mode.
    // This resets all ready / file state so both have to re-confirm.
    if (type === 'mode_change') {
      const peer = myRoom.peers.get(myPeerId);
      myRoom.peers.forEach(p => { p.isReady = false; p.fileDuration = null; p.fileName = null; });
      myRoom.playState.playing      = false;
      myRoom.playState.positionSec  = 0;
      myRoom.playState.lastUpdatedAt = Date.now();
      myRoom.youtubeVideoId = null;
      myRoom.youtubeTitle   = null;
      nudgeCooldownUntil = 0;
      // Broadcast to ALL peers so both UIs update (sender gets their own echo back)
      broadcast(myRoom, 'peer_mode_change', {
        peerId: myPeerId,
        name:   peer?.name || 'Your friend',
        mode:   msg.mode === 'youtube' ? 'youtube' : 'local',
      });
      console.log(`[Mode] ${myRoom.code} → ${msg.mode} (${peer?.name})`);
      return;
    }

    // ── YOUTUBE_LINK ──────────────────────────────────────────────────────
    // Either peer can paste the link; server stores it and fans it out so
    // BOTH clients receive peer_youtube_link and load the same video.
    if (type === 'youtube_link') {
      const peer = myRoom.peers.get(myPeerId);
      myRoom.youtubeVideoId = msg.videoId || null;
      myRoom.youtubeTitle   = msg.title   || null;
      myRoom.peers.forEach(p => { p.isReady = false; p.fileDuration = null; });
      nudgeCooldownUntil = 0;
      broadcast(myRoom, 'peer_youtube_link', {
        fromPeerId: myPeerId,
        videoId:    msg.videoId,
        title:      msg.title || null,
      });
      console.log(`[YouTube] ${myRoom.code} link: ${msg.videoId} by ${peer?.name}`);
      return;
    }

    // ── WebRTC signalling pass-through ────────────────────────────────────
    if (type === 'webrtc_signal') {
      broadcast(myRoom, 'webrtc_signal', {
        signal:     msg.signal,
        fromPeerId: myPeerId,
      }, myPeerId);
      return;
    }

    send(ws, 'error', { message: `Unknown message type: ${type}` });
    } catch (err) {
      console.error('[WS] Error processing message:', err.message);
      try { send(ws, 'error', { message: 'Server error processing message' }); } catch {}
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  ws.on('close', () => {
    try {
      if (!myRoom || !myPeerId) return;
      const peer = myRoom.peers.get(myPeerId);
      roomManager.removePeer(myRoom, myPeerId);

      broadcast(myRoom, 'peer_left', {
        peerId: myPeerId,
        name:   peer?.name,
      });

      // Pause playback for remaining peer since sync partner is gone
      if (myRoom.peers.size > 0) {
        const serverPos = roomManager.currentPosition(myRoom);
        myRoom.playState.playing     = false;
        myRoom.playState.positionSec = serverPos;
        broadcast(myRoom, 'play_pause', {
          playing:     false,
          positionSec: serverPos,
          reason:      'peer_left',
          serverTs:    Date.now(),
        });
      }
    } catch (err) {
      console.error('[WS] Error during close handler:', err.message);
    }
  });

  ws.on('error', (err) => console.error('[WS] Socket error:', err.message));
}

module.exports = { handleConnection };