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
const SYNC_INTERVAL_MS = 2500;

class WatchTogetherClient extends EventTarget {
  constructor(serverUrl) {
    super();
    this.serverUrl   = serverUrl;
    this.ws          = null;
    this.peerId      = null;
    this.roomCode    = null;
    this.syncTimer   = null;
    this._getPos     = null; // set by caller: () => currentVideoPositionSec
    this._reconnectDelay = 1000;
    this._shouldReconnect = true;
    this._listenerCounts = new Map();
    this._bufferedWebrtcSignals = [];
  }

  // ── Connection ────────────────────────────────────────────────────────
  connect() {
    return new Promise((resolve, reject) => {
      this._shouldReconnect = true;
      this.ws = new WebSocket(this.serverUrl);

      this.ws.onopen = () => {
        console.log('[WT] Connected');
        this._reconnectDelay = 1000;
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
          this._emit('disconnected');
          this._stopSync();
          return;
        }
        console.warn('[WT] Disconnected — reconnecting in', this._reconnectDelay, 'ms');
        this._emit('disconnected');
        this._stopSync();
        setTimeout(() => this._reconnect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 16000);
      };

      this.ws.onerror = reject;
    });
  }

  async _reconnect() {
    try {
      await this.connect();
      // Re-join the same room after reconnect
      if (this.roomCode) this._send('join', { roomCode: this.roomCode, name: this._myName, isHost: this._isHost });
    } catch { /* will retry via onclose */ }
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Join a room. Call after connect(). */
  join({ roomCode, name, isHost = false }) {
    this.roomCode = roomCode;
    this._myName  = name;
    this._isHost  = isHost;
    this._send('join', { roomCode, name, isHost });
  }

  /** Tell the server your file is loaded and its duration in seconds. */
  fileReady(durationSec, fileName = null) {
    this._send('file_ready', { durationSec, fileName });
  }

  /** Toggle your ready state in the lobby. */
  setReady(isReady) {
    this._send('ready_toggle', { isReady });
  }

  /**
   * Send a play or pause command.
   * You become master. The server relays this to the other peer.
   */
  playPause(playing, positionSec) {
    this._send('play_pause', { playing, positionSec, timestamp: Date.now() });
  }

  /** Seek to a position. */
  seek(positionSec) {
    this._send('seek', { positionSec });
  }

  /** Send an emoji reaction. */
  react(emoji) {
    this._send('reaction', { emoji });
  }

  /** Pass a WebRTC signal (SDP or ICE candidate) to the peer. */
  sendSignal(signal) {
    this._send('webrtc_signal', { signal });
  }

  /** Ask the other peer to return to the lobby. */
  returnToLobby() {
    this._send('return_to_lobby');
  }

  /**
   * Register the function that returns the current video position.
   * Used for periodic sync checks.
   * e.g.: client.setPositionGetter(() => videoEl.currentTime)
   */
  setPositionGetter(fn) {
    this._getPos = fn;
    this._startSync();
  }

  /** Subscribe to server events and receive an unsubscribe callback. */
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

  /** Subscribe to server events. Same API as addEventListener. */
  on(type, handler) {
    this.listen(type, handler);
    return this; // chainable
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
        break;

      case 'peer_joined':
        this._emit('peer_joined', rest);
        break;

      case 'peer_left':
        this._emit('peer_left', rest);
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

      // ── Sync commands from the other peer (relayed by server) ─────────
      case 'play_pause':
        this._emit('play_pause', rest);
        break;

      case 'seek':
        this._emit('seek', rest);
        break;

      // ── Server tells us we've drifted ─────────────────────────────────
      case 'sync_nudge':
        this._emit('sync_nudge', rest);
        break;

      case 'reaction':
        this._emit('reaction', rest);
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

      case 'error':
        console.error('[WT] Server error:', rest.message);
        this._emit('error', rest);
        break;
    }
  }

  _startSync() {
    this._stopSync();
    this.syncTimer = setInterval(() => {
      if (!this._getPos) return;
      const pos = this._getPos();
      if (typeof pos === 'number' && !isNaN(pos)) {
        this._send('sync_check', { positionSec: pos });
      }
    }, SYNC_INTERVAL_MS);
  }

  _stopSync() {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
  }

  disconnect() {
    this._shouldReconnect = false;
    this.roomCode = null;
    this.peerId = null;
    this._bufferedWebrtcSignals.length = 0;
    this._stopSync();
    this.ws?.close();
    this.ws = null;
  }
}

export { WatchTogetherClient };

// Export for both ESM and CJS
if (typeof module !== 'undefined') module.exports = { WatchTogetherClient };
