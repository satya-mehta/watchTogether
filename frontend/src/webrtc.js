/**
 * WatchTogether — WebRTC Video Call Module
 *
 * Fully peer-to-peer. The server (wsHandler) is used only as a signalling
 * relay to exchange SDP offers/answers and ICE candidates. After the
 * handshake, all audio/video flows directly between browsers.
 *
 * Usage:
 *   import { VideoCall } from './webrtc.js';
 *
 *   const call = new VideoCall(client, localVideoEl, remoteVideoEl);
 *   await call.start(isHost);   // pass true on the host side
 *   call.toggleMute();
 *   call.toggleCamera();
 *   call.end();
 *
 * The `client` param is a WatchTogetherClient instance (from client.js).
 * Signalling is wired automatically via client.sendSignal / client.on('webrtc_signal').
 *
 * Events emitted:
 *   started              { hasVideo, hasAudio }
 *   show_pip             {}
 *   connected            {}
 *   remote_stream        { stream }
 *   peer_disconnected    {}
 *   mute_changed         { muted }
 *   camera_changed       { hidden }
 *   camera_unavailable   {}
 *   media_unavailable    {}
 *   ice_state            { state }
 *   quality_changed      { tier }   — 'high' | 'medium' | 'low' | 'audio_only'
 *   ice_failed           {}
 *   ended                {}
 */

// ── ICE / TURN configuration ──────────────────────────────────────────────
//
// ICE (Interactive Connectivity Establishment) works in three layers,
// tried in order from cheapest to most expensive:
//
//   1. host candidates      — direct LAN IP. Works only when both peers are
//                             on the same local network (rare for real users).
//
//   2. srflx candidates     — public IP discovered via STUN. Works for ~80%
//                             of connections: home routers, basic NATs, most
//                             mobile networks. Zero bandwidth cost.
//
//   3. relay candidates     — media routed through a TURN server. Required
//                             for the remaining ~15–20%: symmetric NAT,
//                             corporate firewalls, carrier-grade NAT (mobile
//                             operators like Jio/BSNL in India), or any
//                             network that blocks all inbound UDP.
//
// HOW FALLBACK ACTUALLY WORKS:
//   The browser runs ICE connectivity checks on ALL gathered candidates in
//   parallel, ranked by priority (host > srflx > relay). It picks the
//   highest-priority pair that succeeds. TURN is never used unless every
//   direct path fails — so for the 80% of users who can connect directly,
//   the TURN server is contacted to allocate a relay address (during
//   pre-gathering) but is never used to carry actual media. Cost = zero.
//
// WHEN TURN IS ACTUALLY TRIGGERED:
//   • One or both peers are behind a symmetric NAT (common on 4G/5G)
//   • Corporate or university network blocking UDP entirely
//   • Carrier-grade NAT (CGNAT) — very common on Indian mobile operators
//   • VPN in use that blocks P2P UDP
//   Without a working TURN server, these users see ICE failed and cannot call.
//
// WHY OPENRELAY:
//   openrelay.metered.ca is the public demo relay from the Metered.ca team.
//   Credentials are intentionally public — it is meant for exactly this use
//   case: open-source and personal projects that need a free relay without
//   account setup. It is less reliable than a private account (shared
//   bandwidth, no SLA) but is fully functional and covers all transport
//   protocols. Upgrade path: create a free Metered.ca account and swap in
//   your private credentials when you want a guaranteed SLA.
//
const ICE_SERVERS = [
  // ── STUN (free, unlimited, no credentials needed) ────────────────────
  // Multiple providers for redundancy — if Google's STUN is blocked,
  // Cloudflare's will succeed. Both run on standard UDP port 3478/19302.
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun2.l.google.com:19302' },

  // ── TURN — OpenRelay public server (free, no account needed) ─────────
  // Four entries cover every transport protocol so no firewall can block all:
  //   :80  UDP  — primary; low latency, most routers allow it
  //   :443 UDP  — fallback; some firewalls allow 443 UDP when :80 is blocked
  //   :443 TCP  — fallback; works when UDP is blocked entirely
  //   turns:443 — TLS-encrypted relay; works on the strictest firewalls that
  //               only allow HTTPS traffic (indistinguishable from a website)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

// ── Quality tiers ──────────────────────────────────────────────────────────
// Each tier defines the video constraints sent via RTCRtpSender.setParameters().
// Audio is never degraded — only video resolution and frame rate are reduced.
// 'audio_only' disables the video track entirely (track.enabled = false) to
// free all bandwidth for audio continuity.
const QUALITY_TIERS = {
  high: {
    label: 'high',
    maxWidth: 640,
    maxHeight: 480,
    maxFps: 24,
    maxKbps: 600,
  },
  medium: {
    label: 'medium',
    maxWidth: 320,
    maxHeight: 240,
    maxFps: 15,
    maxKbps: 250,
  },
  low: {
    label: 'low',
    maxWidth: 160,
    maxHeight: 120,
    maxFps: 10,
    maxKbps: 80,
  },
  audio_only: {
    label: 'audio_only',
    maxWidth: 0,
    maxHeight: 0,
    maxFps: 0,
    maxKbps: 0,
  },
};

// How many consecutive poor samples before stepping down a tier
const DOWNGRADE_THRESHOLD = 3;
// How many consecutive good samples before stepping up a tier
const UPGRADE_THRESHOLD = 8;
// Polling interval for quality stats (ms)
const QUALITY_POLL_MS = 3000;
// Packet loss % above which we consider quality poor
const LOSS_BAD_PCT = 8;
// Packet loss % below which we consider quality good enough to upgrade
const LOSS_GOOD_PCT = 2;
// Round-trip time (ms) above which quality is poor
const RTT_BAD_MS = 400;
// Round-trip time (ms) below which quality is good
const RTT_GOOD_MS = 200;
// Minimum time (ms) between quality tier changes to avoid thrashing
const QUALITY_CHANGE_COOLDOWN_MS = 12000;

// How long 'disconnected' must persist before we attempt an ICE restart (ms).
// The old value was 2500ms — too short. Mobile networks and congested WiFi
// regularly produce 1–3s ICE disconnects that self-recover without any
// intervention. Firing a restart at 2500ms was cancelling recoveries that
// would have succeeded on their own, creating the endless
// disconnect→restart→peer_left→peer_joined loop visible in the logs.
const ICE_DISCONNECT_RESTART_DELAY_MS = 8500;

export class VideoCall extends EventTarget {
  constructor(client, localEl, remoteEl) {
    super();
    this.client = client;
    this.localEl = localEl;
    this.remoteEl = remoteEl;
    this.pc = null;
    this.localStream = null;
    this.isInitiator = false;
    this._started = false;
    this._pendingCandidates = [];
    this._remotePlayBlocked = false;
    this._boundRemotePlaybackRetry = () => this._retryRemotePlayback();
    this._boundVisibilityMediaRetry = () => this._retryPendingLocalMedia();
    this._unsubscribeClientEvents = [];
    this._remoteStreamTimer = null;
    this._disconnectTimer = null;
    this._videoSender = null;
    this._audioSender = null;
    this._cameraSwitching = false;
    this._cameraEnabled = true;
    this._ensureMediaPromise = null;
    this._shouldRetryVideo = false;
    this._shouldRetryAudio = false;
    this._makingOffer = false;
    this._iceRestartCount = 0;

    this._startPromise = null;
    this._signalQueue = [];
    this._processingQueue = false;

    // ── Adaptive quality state ──────────────────────────────────────────
    this._currentTier = 'high';
    this._qualityPollTimer = null;
    this._poorSampleCount = 0;
    this._goodSampleCount = 0;
    this._lastQualityChangeAt = 0;
    this._lastStats = null;  // previous RTCStatsReport snapshot
    this._videoDisabledForQuality = false; // true when tier = audio_only

    // Wire incoming signals
    this._unsubscribeClientEvents.push(
      this.client.listen('webrtc_signal', (data) => this._onSignal(data.signal))
    );
  }

  // ── Public API ────────────────────────────────────────────────────────

  async start(isInitiator = false) {
    if (this._startPromise) return this._startPromise;

    this.isInitiator = isInitiator;

    this._startPromise = (async () => {
      this._started = true;
      this.localStream = new MediaStream();

      await this.ensureMedia({
        audio: true,
        video: true,
        reason: 'start',
        emitFailureEvents: true,
      });

      this._attachLocalPreview();
      document.addEventListener('visibilitychange', this._boundVisibilityMediaRetry, true);

      this._createPeerConnection(); //  NOW inside promise
      this._armRemoteStreamWatchdog();

      this._emit('started', { hasVideo: this.hasVideo, hasAudio: this.hasAudio });
      this._emit('show_pip');

      if (this.isInitiator) {
        queueMicrotask(() => {
          if (this._started && this.pc) this._createOffer();
        });
      }
    })();

    return this._startPromise;
  }

  toggleMute() {
    const track = this._getTrack('audio');
    if (!track) {
      this._shouldRetryAudio = true;
      this.ensureMedia({
        audio: true,
        video: false,
        reason: 'toggle-mute',
        emitFailureEvents: true,
      }).catch(() => { });
      return false;
    }
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    this._emit('mute_changed', { muted });
    return muted;
  }

  toggleCamera() {
    const hasVideoTrack = this._hasUsableTrack('video');
    if (this._cameraEnabled && hasVideoTrack) {
      this._cameraEnabled = false;
      this._shouldRetryVideo = false;
      this._releaseCamera();
    } else {
      this._cameraEnabled = true;
      this._shouldRetryVideo = true;
      this._resumeCamera();
    }
    return !this._cameraEnabled;
  }

  async _releaseCamera() {
    if (this._cameraSwitching) return;
    this._cameraSwitching = true;
    try {
      const videoTrack = this._getTrack('video');
      if (videoTrack) videoTrack.enabled = false;
      if (this.localEl) this.localEl.style.opacity = '0';
      this._emit('camera_changed', { hidden: true });
      console.log('[WebRTC] Camera disabled (track muted, no renegotiation)');
    } catch (err) {
      console.error('[WebRTC] Error disabling camera:', err);
    } finally {
      this._cameraSwitching = false;
    }
  }

  async _resumeCamera() {
    if (this._cameraSwitching) return;
    this._cameraSwitching = true;
    try {
      const existingTrack = this._getTrack('video');
      if (existingTrack) {
        // Only re-enable if quality tier hasn't suppressed it
        if (!this._videoDisabledForQuality) {
          existingTrack.enabled = true;
        }
        if (this.localEl) {
          this.localEl.style.opacity = this._videoDisabledForQuality ? '0' : '1';
          this.localEl.play().catch(() => { });
        }
        this._emit('camera_changed', { hidden: false });
        console.log('[WebRTC] Camera re-enabled (track unmuted, no renegotiation)');
        return;
      }

      await this.ensureMedia({
        audio: false,
        video: true,
        reason: 'camera-resume',
        emitFailureEvents: true,
      });
      if (!this._hasUsableTrack('video')) {
        this._cameraEnabled = false;
        this._shouldRetryVideo = true;
        return;
      }
      this._attachLocalPreview();
      if (this.localEl) this.localEl.style.opacity = '1';

      this._emit('camera_changed', { hidden: false });
      console.log('[WebRTC] Camera resumed via late track attach');
    } catch (err) {
      console.error('[WebRTC] Error resuming camera:', err);
      this._cameraEnabled = false;
      this._shouldRetryVideo = true;
      this._emit('camera_unavailable');
    } finally {
      this._cameraSwitching = false;
    }
  }

  get isMuted() { return !this._getTrack('audio')?.enabled ?? true; }
  get isCamOff() { return !this._cameraEnabled || !this._hasUsableTrack('video'); }
  get hasVideo() { return (this.localStream?.getVideoTracks().length ?? 0) > 0; }
  get hasAudio() { return (this.localStream?.getAudioTracks().length ?? 0) > 0; }
  get qualityTier() { return this._currentTier; }
  get iceState() { return this.pc?.iceConnectionState || 'new'; }

  requestOffer({ iceRestart = false } = {}) {
    return this._createOffer({ iceRestart });
  }

  end() {
    this._stopQualityMonitor();
    // -- clean up queue and promises on call end --
    this._startPromise = null;
    this._signalQueue = [];
    this._processingQueue = false;
    this._pendingCandidates = [];
    this._unsubscribeClientEvents.forEach(u => { try { u(); } catch { } });
    this._unsubscribeClientEvents = [];
    clearTimeout(this._remoteStreamTimer);
    clearTimeout(this._disconnectTimer);
    this._remoteStreamTimer = null;
    this._disconnectTimer = null;
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.pc = null;
    this.localStream = null;
    this._videoSender = null;
    this._audioSender = null;
    this._makingOffer = false;
    this._iceRestartCount = 0;
    this._cameraSwitching = false;
    this._cameraEnabled = true;
    this._remotePlayBlocked = false;
    this._videoDisabledForQuality = false;
    this._currentTier = 'high';
    this._poorSampleCount = 0;
    this._goodSampleCount = 0;
    this._lastStats = null;
    if (this.localEl) this.localEl.srcObject = null;
    if (this.remoteEl) this.remoteEl.srcObject = null;
    document.removeEventListener('pointerup', this._boundRemotePlaybackRetry, true);
    document.removeEventListener('touchend', this._boundRemotePlaybackRetry, true);
    document.removeEventListener('keydown', this._boundRemotePlaybackRetry, true);
    document.removeEventListener('visibilitychange', this._boundRemotePlaybackRetry, true);
    document.removeEventListener('visibilitychange', this._boundVisibilityMediaRetry, true);
    document.removeEventListener('fullscreenchange', this._boundRemotePlaybackRetry, true);
    this._emit('ended');
    console.log('[WebRTC] Call ended');
    this._started = false;
  }

  // ── Peer connection setup ─────────────────────────────────────────────

  _createPeerConnection() {
    if (this.pc) this.pc.close();
    this._makingOffer = false;

    // iceTransportPolicy: 'all' — allow both direct (host/srflx) and relay
    // (TURN) candidates. The browser always tries direct paths first; relay
    // is only selected if no direct path succeeds. Setting this explicitly
    // makes the policy visible and prevents accidental relay-only configs.
    //
    // iceCandidatePoolSize: 10 — pre-gather candidates in the background
    // before the call even starts. By the time the peer clicks "ready",
    // all STUN and TURN relay addresses are already allocated. This removes
    // the 1–3 second visible gathering delay from call setup time.
    this.pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 10,
    });

    const tracks = this.localStream?.getTracks() ?? [];
    if (tracks.length > 0) {
      tracks.forEach(track => {
        const sender = this.pc.addTrack(track, this.localStream);
        if (track.kind === 'video') this._videoSender = sender;
        if (track.kind === 'audio') this._audioSender = sender;
      });
    } else {
      this._videoSender = this.pc.addTransceiver('video', { direction: 'recvonly' }).sender;
      this._audioSender = this.pc.addTransceiver('audio', { direction: 'recvonly' }).sender;
    }

    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track:', event.track.kind);
      const attachRemoteStream = () => {
        if (!this.remoteEl) return;
        try {
          const [remoteStream] = event.streams;
          if (remoteStream) {
            this.remoteEl.srcObject = remoteStream;
          } else {
            if (!this.remoteEl.srcObject) {
              this.remoteEl.srcObject = new MediaStream();
            }
            const existing = this.remoteEl.srcObject.getTracks();
            if (!existing.some(t => t.id === event.track.id)) {
              this.remoteEl.srcObject.addTrack(event.track);
            }
          }
          this.remoteEl.autoplay = true;
          this.remoteEl.playsInline = true;
          this.remoteEl.muted = false;
        } catch (err) {
          console.error('[WebRTC] Failed to attach remote stream:', err.message);
          return;
        }
        this._bindRemotePlaybackRetry();
        this.remoteEl.onloadedmetadata = () => this._attemptRemotePlayback('loadedmetadata');
        this._attemptRemotePlayback('track');
        clearTimeout(this._remoteStreamTimer);
        this._remoteStreamTimer = null;
        this._emit('remote_stream', { stream: this.remoteEl.srcObject });
      };

      attachRemoteStream();
      event.track.onunmute = () => {
        console.log('[WebRTC] Remote track unmuted:', event.track.kind);
        attachRemoteStream();
        if (event.track.kind === 'video') this._emit('remote_camera_on');
      };
      event.track.onmute = () => {
        if (event.track.kind === 'video') this._emit('remote_camera_off');
      };
      event.track.onended = () => {
        if (event.track.kind === 'video') {
          console.log('[WebRTC] Remote video track ended');
          this._emit('remote_camera_off');
        }
      };
    };

    // ── ICE candidate gathering + connection-type logging ─────────────
    //
    // onicecandidate fires once per gathered candidate.
    // candidate.type tells us which layer was used:
    //   'host'  — local LAN IP, no internet traversal needed
    //   'srflx' — server-reflexive (STUN); public IP, basic NAT traversal
    //   'relay' — TURN relay; browser could not find any direct path
    //
    // Logging relay candidates here does NOT mean TURN is being used for
    // media — it just means the browser allocated a relay address as a
    // fallback option. Whether relay is actually selected depends on which
    // candidate pair succeeds during connectivity checks (logged below in
    // oniceconnectionstatechange via _logSelectedCandidatePair).
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        const { type, protocol, address } = event.candidate;
        const label =
          type === 'relay' ? '🔄 relay (TURN)' :
            type === 'srflx' ? '🌐 srflx (STUN)' :
              type === 'host' ? '🏠 host (local)' : type;
        console.log(`[ICE] Gathered candidate: ${label} | ${protocol} | ${address ?? '(hidden)'}`);
        this.client.sendSignal({ type: 'ice_candidate', candidate: event.candidate });
      } else {
        // null candidate = gathering complete
        console.log('[ICE] Candidate gathering complete');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      console.log('[WebRTC] ICE state:', state);
      this._emit('ice_state', { state });

      if (state === 'connected' || state === 'completed') {
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = null;
        this._iceRestartCount = 0;
        this._emit('connected');
        // Log which candidate pair was actually selected so we know whether
        // TURN relay is being used for this call's media path.
        this._logSelectedCandidatePair();
        // Start quality monitoring once we have a stable connection
        this._startQualityMonitor();
      } else if (state === 'failed') {
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = null;
        console.warn('[WebRTC] ICE failed — waiting for app-level recovery');
        this._stopQualityMonitor();
      } else if (state === 'disconnected') {
        this._emit('peer_disconnected');
        this._stopQualityMonitor();
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = null;
      } else if (state === 'checking') {
        this._armRemoteStreamWatchdog();
      }
    };

    this.pc.onnegotiationneeded = async () => {
      if (!this.pc || !this._started) return;
      if (!this.isInitiator && !this.pc.remoteDescription) return;
      await this._createOffer({ allowPolitePeer: true });
    };
  }

  // ── Selected candidate pair logger ───────────────────────────────────
  //
  // Called once the connection reaches 'connected' or 'completed'.
  // Reads the active candidate pair from getStats() and logs the exact
  // connection type being used for media so you can confirm in DevTools
  // whether TURN relay was selected or a direct path succeeded.
  //
  // Example console output:
  //   [ICE] ✅ Connected via: srflx ↔ srflx  (STUN — direct P2P)
  //   [ICE] ✅ Connected via: relay ↔ srflx  (TURN relay active)
  //   [ICE] ✅ Connected via: host ↔ host    (LAN — same network)
  async _logSelectedCandidatePair() {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      let localType = null;
      let remoteType = null;
      let protocol = null;
      let rttMs = null;

      // Build a lookup map of all candidates by their statsId so we can
      // resolve the local/remote candidate from the winning candidate pair.
      const candidates = {};
      stats.forEach(report => {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates[report.id] = report;
        }
      });

      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.nominated) {
          const local = candidates[report.localCandidateId];
          const remote = candidates[report.remoteCandidateId];
          localType = local?.candidateType ?? '?';
          remoteType = remote?.candidateType ?? '?';
          protocol = local?.protocol ?? '?';
          rttMs = typeof report.currentRoundTripTime === 'number'
            ? Math.round(report.currentRoundTripTime * 1000)
            : null;
        }
      });

      if (!localType) {
        console.log('[ICE] ✅ Connected (candidate pair details unavailable in this browser)');
        return;
      }

      const isRelay = localType === 'relay' || remoteType === 'relay';
      const tag = isRelay ? '🔄 TURN relay active' : '⚡ Direct P2P (no relay)';
      const rttStr = rttMs !== null ? ` | RTT ${rttMs}ms` : '';
      console.log(`[ICE] ✅ Connected via: ${localType} ↔ ${remoteType} | ${protocol}${rttStr} — ${tag}`);

      if (isRelay) {
        console.warn('[ICE] ⚠️  TURN is carrying media. Call quality depends on relay bandwidth.');
      }
    } catch {
      // getStats() can fail if the PC closed between 'connected' and the async read
    }
  }

  // ── Offer / Answer ────────────────────────────────────────────────────

  async _createOffer({ iceRestart = false, allowPolitePeer = false } = {}) {
    if (!this.pc) return;
    if (!this._started) return;
    if (iceRestart && !this.isInitiator) return;
    if (!this.isInitiator && !allowPolitePeer) return;
    if (!this.isInitiator && allowPolitePeer && !this.pc.remoteDescription) return;
    if (this._makingOffer) {
      console.log('[WebRTC] Skipping redundant _createOffer (already making one)');
      return;
    }

    this._makingOffer = true;
    try {
      const offer = await this.pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true,
        iceRestart,
      });
      if (this.pc.signalingState !== 'stable') {
        console.warn('[WebRTC] signalingState changed before setLocalDescription — aborting offer');
        return;
      }
      await this.pc.setLocalDescription(offer);
      this.client.sendSignal({ type: 'offer', sdp: offer });
      console.log(iceRestart ? '[WebRTC] ICE restart offer sent' : '[WebRTC] Offer sent');
    } catch (err) {
      console.error('[WebRTC] createOffer failed:', err);
    } finally {
      this._makingOffer = false;
    }
  }

  async _createAnswer(offer) {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      await this._flushPendingCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.client.sendSignal({ type: 'answer', sdp: answer });
      console.log('[WebRTC] Answer sent');
    } catch (err) {
      console.error('[WebRTC] createAnswer failed:', err);
    }
  }

  // ── Incoming signal handler ───────────────────────────────────────────

  // ── Incoming signal handler ───────────────────────────────────────────

  // --- CHANGED: Replaced direct processing with a queueing system ---
  async _onSignal(signal) {
    if (!signal) return;

    // ✅ FIX 1: Start on ANY first signal (not just offer)
    if (!this._started) {
      this.start(signal.type === 'offer' ? false : this.isInitiator);
    }

    // Push to queue
    this._signalQueue.push(signal);

    // Trigger processing
    this._processSignalQueue();
  }

  async _processSignalQueue() {
    // Prevent concurrent loops
    if (this._processingQueue) return;
    this._processingQueue = true;
    try {
      // ✅ FIX 2: Microtask gap to allow start() to set _startPromise
      if (!this._startPromise) {
        await Promise.resolve();
      }

      // Now safely wait for initialization
      if (this._startPromise) {
        await this._startPromise;
      }

      // Process signals in order
      while (this._signalQueue.length > 0) {
        const signal = this._signalQueue.shift();
        try {
          await this._handleSignal(signal);
        } catch (err) {
          console.error('[WebRTC] Signal processing error:', err);
        }
      }
    } finally {
      this._processingQueue = false;
    }

    this._processingQueue = false;
  }

  async _handleSignal(signal) {
    switch (signal.type) {
      case 'offer':
        console.log('[WebRTC] Received offer');
        {
          const collision = this._makingOffer || this.pc?.signalingState !== 'stable';
          if (collision) {
            if (this.isInitiator) {
              console.log('[WebRTC] Offer collision — impolite peer ignoring incoming offer');
              break;
            }
            console.log('[WebRTC] Offer collision — polite peer rolling back');
            if (this.pc) await this.pc.setLocalDescription({ type: 'rollback' }).catch(() => { });
            this._makingOffer = false;
          }
        }
        await this._createAnswer(signal.sdp);
        break;

      case 'answer':
        console.log('[WebRTC] Received answer');
        if (this.pc?.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await this._flushPendingCandidates();
        } else {
          console.warn('[WebRTC] Ignoring answer — unexpected signalingState:', this.pc?.signalingState);
        }
        break;

      case 'ice_candidate':
        if (!signal.candidate) break;
        if (this.pc?.remoteDescription) {
          await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(console.warn);
        } else {
          this._pendingCandidates.push(signal.candidate);
        }
        break;
    }
  }
  // ------------------------------------------------------------------

  async _flushPendingCandidates() {
    for (const c of this._pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
    }
    this._pendingCandidates = [];
  }

  async _iceRestart() {
    if (!this.pc || !this.isInitiator) return;

    const MAX_RESTARTS = 4;
    this._iceRestartCount = (this._iceRestartCount || 0) + 1;
    if (this._iceRestartCount > MAX_RESTARTS) {
      console.warn(`[WebRTC] Gave up after ${MAX_RESTARTS} ICE restarts`);
      this._emit('ice_failed');
      return;
    }

    try {
      console.log(`[WebRTC] Requesting ICE restart (attempt ${this._iceRestartCount}/${MAX_RESTARTS})`);
      await this._createOffer({ iceRestart: true });
    } catch (err) {
      console.error('[WebRTC] ICE restart failed:', err);
    }
  }

  // ── Adaptive quality monitor ──────────────────────────────────────────

  _startQualityMonitor() {
    this._stopQualityMonitor();
    // Only the initiator adjusts their own outbound video quality.
    // The non-initiator's quality is governed by their own monitor.
    // Both run independently and adapt their own sending side.
    if (!this._videoSender) return;
    this._qualityPollTimer = setInterval(() => this._pollQuality(), QUALITY_POLL_MS);
    console.log('[WebRTC] Quality monitor started');
  }

  _stopQualityMonitor() {
    if (this._qualityPollTimer) {
      clearInterval(this._qualityPollTimer);
      this._qualityPollTimer = null;
    }
  }

  async _pollQuality() {
    if (!this.pc || !this._videoSender) return;
    if (this.pc.iceConnectionState !== 'connected' &&
      this.pc.iceConnectionState !== 'completed') return;

    try {
      const stats = await this.pc.getStats(this._videoSender);
      const { lossPercent, rttMs } = this._extractQualityMetrics(stats);
      this._lastStats = stats;

      const isPoor = lossPercent > LOSS_BAD_PCT || rttMs > RTT_BAD_MS;
      const isGood = lossPercent < LOSS_GOOD_PCT && rttMs < RTT_GOOD_MS;

      if (isPoor) {
        this._goodSampleCount = 0;
        this._poorSampleCount++;
        console.log(`[WebRTC] Quality poor: loss=${lossPercent.toFixed(1)}% rtt=${rttMs}ms (${this._poorSampleCount}/${DOWNGRADE_THRESHOLD})`);
        if (this._poorSampleCount >= DOWNGRADE_THRESHOLD) {
          this._poorSampleCount = 0;
          this._stepDownQuality();
        }
      } else if (isGood) {
        this._poorSampleCount = 0;
        this._goodSampleCount++;
        console.log(`[WebRTC] Quality good: loss=${lossPercent.toFixed(1)}% rtt=${rttMs}ms (${this._goodSampleCount}/${UPGRADE_THRESHOLD})`);
        if (this._goodSampleCount >= UPGRADE_THRESHOLD) {
          this._goodSampleCount = 0;
          this._stepUpQuality();
        }
      } else {
        // Neutral — decay both counters slowly so we don't get stuck
        this._poorSampleCount = Math.max(0, this._poorSampleCount - 1);
        this._goodSampleCount = Math.max(0, this._goodSampleCount - 1);
      }
    } catch (err) {
      // getStats() can throw if the PC is closing — ignore silently
    }
  }

  _extractQualityMetrics(stats) {
    let lossPercent = 0;
    let rttMs = 0;
    let foundOutbound = false;
    let foundCandidatePair = false;

    stats.forEach(report => {
      // Outbound video RTP for packet loss
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        const sent = (report.packetsSent ?? 0);
        const lost = (report.packetsLost ?? 0);
        if (sent + lost > 0) {
          lossPercent = (lost / (sent + lost)) * 100;
          foundOutbound = true;
        }
      }
      // Active candidate pair for round-trip time
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        if (typeof report.currentRoundTripTime === 'number') {
          rttMs = report.currentRoundTripTime * 1000;
          foundCandidatePair = true;
        }
      }
    });

    return { lossPercent, rttMs, foundOutbound, foundCandidatePair };
  }

  _tierOrder() {
    return ['high', 'medium', 'low', 'audio_only'];
  }

  _stepDownQuality() {
    const now = Date.now();
    if (now - this._lastQualityChangeAt < QUALITY_CHANGE_COOLDOWN_MS) return;

    const order = this._tierOrder();
    const idx = order.indexOf(this._currentTier);
    if (idx >= order.length - 1) return; // already at lowest

    const nextTier = order[idx + 1];
    this._applyQualityTier(nextTier);
  }

  _stepUpQuality() {
    const now = Date.now();
    if (now - this._lastQualityChangeAt < QUALITY_CHANGE_COOLDOWN_MS) return;

    const order = this._tierOrder();
    const idx = order.indexOf(this._currentTier);
    if (idx <= 0) return; // already at highest

    const nextTier = order[idx - 1];
    this._applyQualityTier(nextTier);
  }

  async _applyQualityTier(tierName) {
    if (tierName === this._currentTier) return;
    if (!this._videoSender) return;

    const tier = QUALITY_TIERS[tierName];
    if (!tier) return;

    const prevTier = this._currentTier;
    this._currentTier = tierName;
    this._lastQualityChangeAt = Date.now();

    console.log(`[WebRTC] Quality tier: ${prevTier} → ${tierName}`);

    // ── audio_only: disable video track entirely ──────────────────────
    if (tierName === 'audio_only') {
      const videoTrack = this._getTrack('video');
      if (videoTrack && this._cameraEnabled) {
        videoTrack.enabled = false;
        this._videoDisabledForQuality = true;
        if (this.localEl) this.localEl.style.opacity = '0';
        console.log('[WebRTC] Video disabled — audio only mode');
      }
      this._emit('quality_changed', { tier: tierName });
      return;
    }

    // ── Restore video track if coming back from audio_only ────────────
    if (prevTier === 'audio_only' && this._videoDisabledForQuality) {
      const videoTrack = this._getTrack('video');
      if (videoTrack && this._cameraEnabled) {
        videoTrack.enabled = true;
        this._videoDisabledForQuality = false;
        if (this.localEl) this.localEl.style.opacity = '1';
        console.log('[WebRTC] Video restored from audio_only');
      }
    }

    // ── Apply encoding parameters via RTCRtpSender.setParameters() ───
    // setParameters() is the standard way to change bitrate/resolution
    // mid-call without triggering renegotiation. It only affects the
    // local sending side — the remote peer adapts automatically via
    // their decoder's congestion control.
    try {
      const params = this._videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        // Some browsers don't populate encodings until after negotiation.
        // Fall back to just logging — the tier label is still tracked.
        console.warn('[WebRTC] No encodings in sender parameters — cannot apply bitrate cap');
        this._emit('quality_changed', { tier: tierName });
        return;
      }

      params.encodings.forEach(enc => {
        enc.maxBitrate = tier.maxKbps * 1000;
        enc.maxFramerate = tier.maxFps;
        // scaleResolutionDownBy: 1 = full res, 2 = half, 4 = quarter
        // Calculate from maxWidth relative to original 640px capture
        const scaleFactor = tier.maxWidth > 0 ? Math.max(1, 640 / tier.maxWidth) : 4;
        enc.scaleResolutionDownBy = scaleFactor;
        enc.active = true;
      });

      await this._videoSender.setParameters(params);
      console.log(`[WebRTC] Encoder: ${tier.maxWidth}×${tier.maxHeight} @ ${tier.maxFps}fps ${tier.maxKbps}kbps`);
    } catch (err) {
      console.warn('[WebRTC] setParameters failed (browser may not support it):', err.message);
      // Non-fatal — the tier label is still tracked for UI and future attempts
    }

    this._emit('quality_changed', { tier: tierName });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  _buildMediaConstraints({ audio = false, video = false } = {}) {
    return {
      video: video ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false,
      audio: audio ? { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 } : false,
    };
  }

  _hasUsableTrack(kind) {
    return !!this.localStream?.getTracks().find((track) => track.kind === kind && track.readyState !== 'ended');
  }

  _attachLocalPreview() {
    if (!this.localEl) return;
    try {
      this.localEl.muted = true;
      this.localEl.autoplay = true;
      this.localEl.playsInline = true;
      this.localEl.srcObject = this.localStream;
      if (this._hasUsableTrack('video') && this._cameraEnabled && !this._videoDisabledForQuality) {
        this.localEl.style.opacity = '1';
      } else {
        this.localEl.style.opacity = '0';
      }
      this.localEl.play().catch(() => { });
    } catch (err) {
      console.error('[WebRTC] Failed to attach local stream:', err.message);
    }
  }

  async ensureMedia({
    audio = true,
    video = true,
    reason = 'manual',
    emitFailureEvents = false,
  } = {}) {
    if (!this.localStream) this.localStream = new MediaStream();

    const needsAudio = !!audio && !this._hasUsableTrack('audio');
    const needsVideo = !!video && !this._hasUsableTrack('video');
    if (!needsAudio && !needsVideo) {
      if (audio) this._shouldRetryAudio = !this._hasUsableTrack('audio');
      if (video) this._shouldRetryVideo = this._cameraEnabled && !this._hasUsableTrack('video');
      this._attachLocalPreview();
      return this.localStream;
    }

    if (this._ensureMediaPromise) return this._ensureMediaPromise;

    this._ensureMediaPromise = (async () => {
      let capturedStream = null;

      try {
        capturedStream = await navigator.mediaDevices.getUserMedia(
          this._buildMediaConstraints({ audio: needsAudio, video: needsVideo })
        );
      } catch (err) {
        if (needsAudio && needsVideo) {
          console.warn('[WebRTC] getUserMedia failed, trying audio only:', err.message);
          try {
            capturedStream = await navigator.mediaDevices.getUserMedia(
              this._buildMediaConstraints({ audio: true, video: false })
            );
            if (emitFailureEvents) this._emit('camera_unavailable');
          } catch (audioErr) {
            console.warn('[WebRTC] Audio fallback unavailable:', audioErr.message);
            if (emitFailureEvents) this._emit('media_unavailable');
          }
        } else if (needsVideo) {
          console.warn(`[WebRTC] Camera unavailable during ${reason}:`, err.message);
          if (emitFailureEvents) this._emit('camera_unavailable');
        } else if (needsAudio) {
          console.warn(`[WebRTC] Microphone unavailable during ${reason}:`, err.message);
          if (emitFailureEvents) this._emit('media_unavailable');
        }
      }

      if (capturedStream) {
        await this._applyLocalTracks(capturedStream, { reason });
      } else {
        this._attachLocalPreview();
      }

      if (audio) this._shouldRetryAudio = !this._hasUsableTrack('audio');
      if (video) this._shouldRetryVideo = this._cameraEnabled && !this._hasUsableTrack('video');
      return this.localStream;
    })();

    try {
      return await this._ensureMediaPromise;
    } finally {
      this._ensureMediaPromise = null;
    }
  }

  async _applyLocalTracks(stream, { reason = 'media-update' } = {}) {
    if (!this.localStream) this.localStream = new MediaStream();

    let mediaChanged = false;
    for (const track of stream.getTracks()) {
      const sender = await this._upsertSenderTrack(track);
      if (track.kind === 'video') {
        this._videoSender = sender || this._videoSender;
        track.enabled = this._cameraEnabled && !this._videoDisabledForQuality;
      }
      if (track.kind === 'audio') this._audioSender = sender || this._audioSender;

      const existingTrack = this._getTrack(track.kind);
      if (existingTrack && existingTrack.id !== track.id) {
        this.localStream.removeTrack(existingTrack);
        try { existingTrack.stop(); } catch { }
      }
      if (!this.localStream.getTracks().some((localTrack) => localTrack.id === track.id)) {
        this.localStream.addTrack(track);
      }
      mediaChanged = true;
    }

    this._attachLocalPreview();
    if (mediaChanged && reason !== 'start') {
      this._emit('local_media_changed', {
        hasVideo: this.hasVideo,
        hasAudio: this.hasAudio,
        reason,
      });
    }
  }

  async _upsertSenderTrack(track) {
    if (!this.pc) return null;

    const senderRef = track.kind === 'video' ? '_videoSender' : '_audioSender';
    const existingSender = this[senderRef];
    if (existingSender) {
      if (existingSender.track?.id !== track.id) {
        await existingSender.replaceTrack(track);
      }
      const transceiver = this.pc.getTransceivers().find((item) => item.sender === existingSender);
      if (transceiver && transceiver.direction !== 'sendrecv') transceiver.direction = 'sendrecv';
      return existingSender;
    }

    const reusableTransceiver = this.pc.getTransceivers().find((item) => {
      const senderTrack = item.sender?.track;
      const receiverKind = item.receiver?.track?.kind;
      return !senderTrack && receiverKind === track.kind;
    });
    if (reusableTransceiver) {
      await reusableTransceiver.sender.replaceTrack(track);
      reusableTransceiver.direction = 'sendrecv';
      return reusableTransceiver.sender;
    }

    return this.pc.addTrack(track, this.localStream);
  }

  _getTrack(kind) {
    return this.localStream?.getTracks().find(t => t.kind === kind) ?? null;
  }

  _retryPendingLocalMedia() {
    if (!this._started) return;
    if (document.visibilityState === 'hidden') return;
    if (!this._shouldRetryAudio && !this._shouldRetryVideo) return;
    this.ensureMedia({
      audio: this._shouldRetryAudio,
      video: this._cameraEnabled && this._shouldRetryVideo,
      reason: 'visibility-retry',
      emitFailureEvents: false,
    }).catch(() => { });
  }

  _bindRemotePlaybackRetry() {
    document.addEventListener('pointerup', this._boundRemotePlaybackRetry, true);
    document.addEventListener('touchend', this._boundRemotePlaybackRetry, true);
    document.addEventListener('keydown', this._boundRemotePlaybackRetry, true);
    document.addEventListener('visibilitychange', this._boundRemotePlaybackRetry, true);
    document.addEventListener('fullscreenchange', this._boundRemotePlaybackRetry, true);
  }

  async _attemptRemotePlayback(source) {
    if (!this.remoteEl?.srcObject) return;
    try {
      await this.remoteEl.play();
      this._remotePlayBlocked = false;
    } catch (err) {
      this._remotePlayBlocked = true;
      console.warn(`[WebRTC] Remote play() blocked during ${source}:`, err?.message || err);
      this._emit('remote_play_blocked');
    }
  }

  _retryRemotePlayback() {
    if (document.visibilityState === 'hidden') return;
    if (!this._remotePlayBlocked) return;
    this._attemptRemotePlayback('gesture-retry');
  }

  _armRemoteStreamWatchdog() {
    clearTimeout(this._remoteStreamTimer);
    this._remoteStreamTimer = setTimeout(() => {
      this._remoteStreamTimer = null;
      const hasRemoteTracks = (this.remoteEl?.srcObject?.getTracks?.().length ?? 0) > 0;
      if (!hasRemoteTracks) {
        console.warn('[WebRTC] Remote stream missing after timeout — waiting for app-level recovery');
      }
    }, 15000);
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(Object.assign(new Event(type), { detail }));
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail ?? {}));
    return this;
  }
}
