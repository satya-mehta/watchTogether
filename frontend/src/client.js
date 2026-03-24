/**
 * WatchTogether Client SDK
 * Handles all WebSocket communication,
 * reconnection, and sync logic so UI code stays clean.
 *
 * Usage:
 *   const client = new WatchTogetherClient('ws://localhost:3001/ws');
 *   client.on('play_pause', ({ playing, positionSec }) => { ... });
 *   client.join({ roomCode: 'COZY-4827', name: 'Sarah', isHost: false });
 */

// How often to send a sync heartbeat (ms)
// BUG FIX: was 2500ms. At 2.5s intervals, drift can grow to ~2s between
// checks on a slow device before we even detect it. 1500ms gives tighter
// correction without hammering the server.
const SYNC_INTERVAL_MS = 1500;

// How often to ping /health to keep Render backend awake (ms) — 10 minutes
const KEEPALIVE_INTERVAL_MS = 600000;

// BUG FIX: after a seek or sync_nudge, suppress outgoing sync_checks for
// this long so the local video element has time to seek before we start
// reporting our position again. Avoids the phantom-drift feedback loop.
const SYNC_SUPPRESS_AFTER_SEEK_MS = 1500;

const PARTICIPANT_ID_STORAGE_KEY = 'watchTogetherParticipantId';

// ── State constants ────────────────────────────────────────────────────────
// These are the canonical state values for the three state dimensions.
// Import these from this module if you need to compare against them in app.js.

/** @typedef {'connected'|'reconnecting'|'disconnected'} SignalingState */
function generateParticipantId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `pt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreateParticipantId() {
  try {
    const existing = window.localStorage?.getItem(PARTICIPANT_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = generateParticipantId();
    window.localStorage?.setItem(PARTICIPANT_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return generateParticipantId();
  }
}

class WatchTogetherClient extends EventTarget {
  constructor(serverUrl, backendBaseUrl = null) {
    super();
    this.serverUrl = serverUrl;
    this.backendBaseUrl = backendBaseUrl;
    this.ws = null;
    this.peerId = null;
    this.participantId = getOrCreateParticipantId();
    this.roomCode = null;
    this.syncTimer = null;
    this.keepaliveTimer = null;
    this._getPos = null;
    this._reconnectDelay = 1000;
    this._shouldReconnect = true;
    this._listenerCounts = new Map();
    this._bufferedWebrtcSignals = [];
    this._isReconnectAttempt = false;

    // BUG FIX: track when to suppress sync_check sends (after seek/nudge)
    this._syncSuppressUntil = 0;

    // ── Signaling state ─────────────────────────────────────────────────
    // Presence and call lifecycle are owned by the integration layer.

    /** @type {SignalingState} */
    this.signalingState = 'disconnected';
  }

  // ── State helpers ─────────────────────────────────────────────────────

  _setSignalingState(state) {
    this.signalingState = state;
    this._emit('signaling_state_change', { state });
  }

  _emitSignalingState(state, detail = {}) {
    this._setSignalingState(state);
    this._emit('signaling_state', { state, ...detail });
    this._emit(state, { state, ...detail });
  }

  // ── Connection ────────────────────────────────────────────────────────
  connect() {
    return new Promise((resolve, reject) => {
      this._shouldReconnect = true;
      this.ws = new WebSocket(this.serverUrl);

      this.ws.onopen = () => {
        console.log('[WT] Connected');
        this._reconnectDelay = 1000;
        this._startKeepalive();
        this._emitSignalingState('connected', { resumed: this._isReconnectAttempt });
        this._isReconnectAttempt = false;
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handle(msg);
        } catch (e) {
          console.error('[WT] Bad message', e);
        }
      };

      this.ws.onclose = () => {
        if (!this._shouldReconnect) {
          console.log('[WT] Disconnected');
          this._emitSignalingState('disconnected');
          this._stopSync();
          this._stopKeepalive();
          return;
        }
        console.warn('[WT] Disconnected — reconnecting in', this._reconnectDelay, 'ms');
        this._emitSignalingState('reconnecting', { retryInMs: this._reconnectDelay });
        this._stopSync();
        this._stopKeepalive();
        setTimeout(() => this._reconnect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 16000);
      };

      this.ws.onerror = reject;
    });
  }

  async _reconnect() {
    try {
      this._isReconnectAttempt = true;
      await this.connect();
      if (this.roomCode) {
        this._send('join', {
          roomCode: this.roomCode,
          name: this._myName,
          isHost: this._isHost,
          participantId: this.participantId,
        });
      }
    } catch { /* will retry via onclose */ }
  }

  // ── Public API ────────────────────────────────────────────────────────

  join({ roomCode, name, isHost = false }) {
    this.roomCode = roomCode;
    this._myName = name;
    this._isHost = isHost;
    this._send('join', { roomCode, name, isHost, participantId: this.participantId });
  }

  updateName(name) {
    this._myName = name;
    this._send('update_name', { name });
  }

  fileReady(durationSec, fileName = null) {
    this._send('file_ready', { durationSec, fileName });
  }

  setReady(isReady) {
    this._send('ready_toggle', { isReady });
  }

  playPause(playing, positionSec) {
    this._send('play_pause', { playing, positionSec, timestamp: Date.now() });
  }

  seek(positionSec) {
    // BUG FIX: suppress our own sync_checks right after we send a seek, so
    // we don't report a stale position before the local video has seeked.
    this._syncSuppressUntil = Date.now() + SYNC_SUPPRESS_AFTER_SEEK_MS;
    this._send('seek', { positionSec });
  }

  requestSyncCheck(positionSec = this._getPos?.()) {
    if (typeof positionSec === 'number' && !isNaN(positionSec)) {
      this._send('sync_check', { positionSec });
    }
  }

  react(emoji) {
    this._send('reaction', { emoji });
  }

  // Send a chat message to the other peer in the room.
  // Returns the messageId so the caller can render the message optimistically
  // and later deduplicate if it somehow arrives back via a relay.
  sendChat(text) {
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._send('chat_message', {
      text,
      messageId,
      participantId: this.participantId,
    });
    return messageId;
  }

  sendSignal(signal) {
    this._send('webrtc_signal', { signal });
  }

  returnToLobby() {
    this._send('return_to_lobby');
  }

  sendCameraToggle({ isCameraOn, isMicOn }) {
    this._send('camera_toggle', { isCameraOn, isMicOn });
  }

  sendMicToggle({ isCameraOn, isMicOn }) {
    this._send('mic_toggle', { isCameraOn, isMicOn });
  }

  syncMediaState({ isCameraOn, isMicOn }) {
    this._send('sync_media_state', {
      participantId: this.participantId,
      isCameraOn,
      isMicOn,
    });
  }

  setPositionGetter(fn) {
    this._getPos = fn;
    this._startSync();
  }

  listen(type, handler, { replayBuffered = true } = {}) {
    const wrapped = (e) => handler(e.detail);
    this.addEventListener(type, wrapped);
    this._listenerCounts.set(type, (this._listenerCounts.get(type) || 0) + 1);

    if (type === 'webrtc_signal' && replayBuffered && this._bufferedWebrtcSignals.length > 0) {
      const bufferedSignals = [...this._bufferedWebrtcSignals];
      this._bufferedWebrtcSignals.length = 0;
      queueMicrotask(() => {
        bufferedSignals.forEach((detail) => handler(detail));
      });
    }

    return () => {
      this.removeEventListener(type, wrapped);
      const nextCount = Math.max((this._listenerCounts.get(type) || 1) - 1, 0);
      if (nextCount === 0) this._listenerCounts.delete(type);
      else this._listenerCounts.set(type, nextCount);
    };
  }

  on(type, handler) {
    this.listen(type, handler);
    return this;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _send(type, payload = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(Object.assign(new Event(type), { detail }));
  }

  _handle(msg) {
    const { type, ...rest } = msg;
    console.debug('[WT ←]', type, rest);

    switch (type) {
      case 'joined':
        this.peerId = rest.yourPeerId;
        this._emit('joined', rest);
        if (rest.rejoined) this._emit('rejoined', rest);
        break;

      case 'peer_joined':
        this._emit('peer_joined', rest);
        break;

      case 'peer_reconnecting':
        this._emit('peer_reconnecting', rest);
        break;

      case 'peer_reconnected':
        this._emit('peer_reconnected', rest);
        break;

      case 'peer_left':
        this._emit('peer_left', rest);
        break;

      case 'peer_name_updated':
        this._emit('peer_name_updated', rest);
        break;

      case 'peer_file_ready':
        this._emit('peer_file_ready', rest);
        break;

      case 'duration_check':
        this._emit('duration_check', rest);
        break;

      case 'peer_ready':
        this._emit('peer_ready', rest);
        break;

      case 'countdown_start':
        this._emit('countdown_start', rest);
        break;

      case 'play_pause':
        this._emit('play_pause', rest);
        break;

      case 'seek':
        // BUG FIX: when we receive a seek from the other peer, suppress our
        // own sync_checks for a moment so we don't immediately report our
        // pre-seek position and trigger a phantom nudge back.
        this._syncSuppressUntil = Date.now() + SYNC_SUPPRESS_AFTER_SEEK_MS;
        this._emit('seek', rest);
        break;

      case 'sync_nudge':
        // sync_nudge is only ever sent to the non-master (the peer with drift).
        // Suppress sync_checks so we don't immediately re-report a stale position
        // before the seek has landed.
        if (rest.masterId && rest.masterId !== this.peerId) {
          this._syncSuppressUntil = Date.now() + SYNC_SUPPRESS_AFTER_SEEK_MS;
        }
        this._emit('sync_nudge', rest);
        this._emit('apply_sync', rest);
        break;

      case 'reaction':
        this._emit('reaction', rest);
        break;

      case 'chat_message':
        this._emit('chat_message', rest);
        break;

      case 'camera_toggle':
        this._emit('camera_toggle', rest);
        break;

      case 'mic_toggle':
        this._emit('mic_toggle', rest);
        break;

      case 'sync_media_state':
        this._emit('sync_media_state', rest);
        break;

      case 'webrtc_signal':
        if ((this._listenerCounts.get('webrtc_signal') || 0) > 0) {
          this._emit('webrtc_signal', rest);
        } else {
          this._bufferedWebrtcSignals.push(rest);
          if (this._bufferedWebrtcSignals.length > 12) {
            this._bufferedWebrtcSignals.shift();
          }
        }
        break;

      case 'return_to_lobby':
        this._emit('return_to_lobby', rest);
        break;

      // YouTube room-level events — were missing, causing silent drops
      case 'peer_mode_change':
        this._emit('peer_mode_change', rest);
        break;

      case 'peer_youtube_link':
        this._emit('peer_youtube_link', rest);
        break;

      case 'error':
        console.error('[WT] Server error:', rest.message);
        // If the server says the room is full or gone, continuing to reconnect
        // and re-join will never succeed — it just floods the server with
        // failing join attempts (the "Not in a room" spam in the logs).
        if (rest.message === 'Room full' || rest.message === 'Room not found') {
          this._shouldReconnect = false;
          this.roomCode = null;
        }
        this._emit('error', rest);
        break;
    }
  }

  _startSync() {
    this._stopSync();
    this.syncTimer = setInterval(() => {
      if (!this._getPos) return;

      // BUG FIX: don't send position reports while in suppress window
      if (Date.now() < this._syncSuppressUntil) return;

      const pos = this._getPos();
      if (typeof pos === 'number' && !isNaN(pos)) {
        this._send('sync_check', { positionSec: pos });
      }
    }, SYNC_INTERVAL_MS);
  }

  _stopSync() {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
  }

  _startKeepalive() {
    this._stopKeepalive();
    if (!this.backendBaseUrl) return;

    this.keepaliveTimer = setInterval(() => {
      this._pingHealth();
    }, KEEPALIVE_INTERVAL_MS);

    this._pingHealth();
  }

  _stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  async _pingHealth() {
    if (!this.backendBaseUrl) return;
    try {
      const response = await fetch(`${this.backendBaseUrl}/health`, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
      });
      if (response.ok) {
        const data = await response.json();
        console.log('[WT] Keep-alive ping — backend healthy:', data.status,
          `(${data.rooms} rooms, ${data.peers} peers)`);
      }
    } catch (err) {
      console.warn('[WT] Keep-alive ping failed:', err.message);
    }
  }

  disconnect() {
    this._shouldReconnect = false;
    this.roomCode = null;
    this.peerId = null;
    this._bufferedWebrtcSignals.length = 0;
    this._stopSync();
    this._stopKeepalive();
    this._send('leave_room');
    const socket = this.ws;
    this.ws = null;
    if (socket) socket.close();
    else this._emitSignalingState('disconnected');
  }
}

export { WatchTogetherClient };
