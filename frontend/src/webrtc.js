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
 *   started          { hasVideo, hasAudio }  — camera acquired, local preview live
 *   show_pip         {}                      — host should make pip-bubble visible now
 *   connected        {}                      — ICE connected, P2P call is live
 *   remote_stream    { stream }              — remote video/audio stream attached
 *   peer_disconnected{}
 *   mute_changed     { muted }
 *   camera_changed   { hidden }
 *   camera_unavailable {}
 *   media_unavailable  {}
 *   ice_state        { state }
 *   ended            {}
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
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
];

export class VideoCall extends EventTarget {
  /**
   * @param {WatchTogetherClient} client   - signalling transport
   * @param {HTMLVideoElement}    localEl  - <video> for your own camera (muted)
   * @param {HTMLVideoElement}    remoteEl - <video> for the peer's camera
   */
  constructor(client, localEl, remoteEl) {
    super();
    this.client    = client;
    this.localEl   = localEl;
    this.remoteEl  = remoteEl;
    this.pc        = null;
    this.localStream  = null;
    this.isInitiator  = false;
    this._started     = false;
    this._pendingCandidates = [];
    this._remotePlayBlocked = false;
    this._boundRemotePlaybackRetry = () => this._retryRemotePlayback();
    this._unsubscribeClientEvents = [];
    this._remoteStreamTimer = null;
    this._disconnectTimer  = null;
    this._videoSender = null;
    this._audioSender = null;
    this._cameraSwitching = false;
    this._cameraEnabled   = true;

    // BUG FIX: track whether we are in the middle of creating an offer.
    // Without this flag, three separate code paths can all call _createOffer()
    // at once: (1) onnegotiationneeded fires when addTrack is called in
    // _createPeerConnection, (2) start() explicitly calls _createOffer() for
    // the initiator, (3) peer_joined also triggers _createOffer(). Two
    // concurrent offers corrupt the PC signalingState → ICE never connects
    // → remote video stays blank forever.
    this._makingOffer = false;

    // Wire incoming signals
    this._unsubscribeClientEvents.push(
      this.client.listen('webrtc_signal', (data) => this._onSignal(data.signal))
    );

    // When the peer joins and we are the host, kick off negotiation.
    // onnegotiationneeded will also fire from addTrack calls, so guard
    // with _makingOffer to avoid sending a second simultaneous offer.
    this._unsubscribeClientEvents.push(
      this.client.listen('peer_joined', () => {
        if (this.isInitiator && this._started) this._createOffer();
      }, { replayBuffered: false })
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start(isInitiator = false) {
    this.isInitiator = isInitiator;
    this._started    = true;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
      });
    } catch (err) {
      console.warn('[WebRTC] getUserMedia failed, trying audio only:', err.message);
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this._emit('camera_unavailable');
      } catch {
        this.localStream = new MediaStream();
        this._emit('media_unavailable');
      }
    }

    // BUG FIX: set muted / autoplay / playsInline BEFORE assigning srcObject.
    // When srcObject is assigned, some browsers immediately attempt playback.
    // If autoplay/muted are not set yet at that moment, the attempt is
    // rejected (autoplay policy) and the local preview stays black.
    if (this.localEl) {
      try {
        this.localEl.muted      = true;   // must be true to avoid echo and pass autoplay
        this.localEl.autoplay   = true;
        this.localEl.playsInline = true;
        this.localEl.srcObject  = this.localStream;
        // play() may still be needed on iOS / certain browsers
        this.localEl.play().catch(() => {});
      } catch (err) {
        console.error('[WebRTC] Failed to attach local stream:', err.message);
      }
    } else {
      console.error('[WebRTC] localEl not found — pass the correct <video> element');
    }

    this._createPeerConnection();

    // BUG FIX: do NOT call _createOffer() explicitly here for the initiator.
    // _createPeerConnection() calls addTrack() or addTransceiver() which
    // synchronously queues a negotiationneeded event. That event fires
    // _createOffer() via onnegotiationneeded. Calling _createOffer() here
    // in addition creates a SECOND concurrent offer, corrupting state.
    // The onnegotiationneeded path (guarded by _makingOffer) is the single
    // canonical source of truth for offer creation.

    this._armRemoteStreamWatchdog();

    // Signal the UI that the local preview is ready and the pip can be shown.
    this._emit('started', { hasVideo: this.hasVideo, hasAudio: this.hasAudio });
    this._emit('show_pip');
  }

  toggleMute() {
    const track = this._getTrack('audio');
    if (!track) return true;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    this._emit('mute_changed', { muted });
    return muted;
  }

  toggleCamera() {
    this._cameraEnabled = !this._cameraEnabled;
    const hidden = !this._cameraEnabled;
    if (this._cameraEnabled) {
      this._resumeCamera();
    } else {
      this._releaseCamera();
    }
    return hidden;
  }

  async _releaseCamera() {
    if (this._cameraSwitching) return;
    this._cameraSwitching = true;
    try {
      const videoTrack = this._getTrack('video');
      if (videoTrack) {
        videoTrack.stop();
        this.localStream?.removeTrack(videoTrack);
      }
      if (this._videoSender && this.pc) {
        try { await this.pc.removeTrack(this._videoSender); } catch {}
        this._videoSender = null;
      }
      this._emit('camera_changed', { hidden: true });
      console.log('[WebRTC] Camera released');
    } catch (err) {
      console.error('[WebRTC] Error releasing camera:', err);
    } finally {
      this._cameraSwitching = false;
    }
  }

  async _resumeCamera() {
    if (this._cameraSwitching) return;
    this._cameraSwitching = true;
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      }).catch(err => {
        console.warn('[WebRTC] Camera unavailable on resume:', err.message);
        this._emit('camera_unavailable');
        throw err;
      });

      const videoTrack = videoStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('No video track in resumed stream');

      this.localStream?.addTrack(videoTrack);
      if (this.pc) {
        // addTrack returns RTCRtpSender synchronously
        this._videoSender = this.pc.addTrack(videoTrack, this.localStream);
      }

      // Refresh local preview
      if (this.localEl) {
        this.localEl.srcObject = this.localStream;
        this.localEl.play().catch(() => {});
      }

      this._emit('camera_changed', { hidden: false });
      console.log('[WebRTC] Camera resumed');
    } catch (err) {
      console.error('[WebRTC] Error resuming camera:', err);
      this._emit('camera_unavailable');
    } finally {
      this._cameraSwitching = false;
    }
  }

  get isMuted()  { return !this._getTrack('audio')?.enabled ?? true; }
  get isCamOff() { return !this._cameraEnabled; }
  get hasVideo() { return (this.localStream?.getVideoTracks().length ?? 0) > 0; }
  get hasAudio() { return (this.localStream?.getAudioTracks().length ?? 0) > 0; }

  end() {
    this._unsubscribeClientEvents.forEach(u => { try { u(); } catch {} });
    this._unsubscribeClientEvents = [];
    clearTimeout(this._remoteStreamTimer);
    clearTimeout(this._disconnectTimer);
    this._remoteStreamTimer = null;
    this._disconnectTimer   = null;
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.pc           = null;
    this.localStream  = null;
    this._videoSender = null;
    this._audioSender = null;
    this._makingOffer = false;
    this._cameraSwitching = false;
    this._cameraEnabled   = true;
    this._remotePlayBlocked = false;
    if (this.localEl)  this.localEl.srcObject  = null;
    if (this.remoteEl) this.remoteEl.srcObject = null;
    document.removeEventListener('pointerup',          this._boundRemotePlaybackRetry, true);
    document.removeEventListener('touchend',           this._boundRemotePlaybackRetry, true);
    document.removeEventListener('keydown',            this._boundRemotePlaybackRetry, true);
    document.removeEventListener('visibilitychange',   this._boundRemotePlaybackRetry, true);
    document.removeEventListener('fullscreenchange',   this._boundRemotePlaybackRetry, true);
    this._emit('ended');
    console.log('[WebRTC] Call ended');
  }

  // ── Peer connection setup ───────────────────────────────────────────────

  _createPeerConnection() {
    if (this.pc) this.pc.close();
    this._makingOffer = false;

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // BUG FIX: when getUserMedia fails and localStream is empty (no tracks),
    // addTrack() is never called, onnegotiationneeded never fires, and the
    // PC has no direction set — so even if the peer sends an offer with video,
    // the local side has no receivers for it. Fix: explicitly add sendrecv
    // transceivers when we have tracks, or recvonly transceivers when we
    // don't. This also ensures onnegotiationneeded fires reliably.
    const tracks = this.localStream?.getTracks() ?? [];
    if (tracks.length > 0) {
      tracks.forEach(track => {
        const sender = this.pc.addTrack(track, this.localStream);
        if (track.kind === 'video') this._videoSender = sender;
        if (track.kind === 'audio') this._audioSender = sender;
      });
    } else {
      // No local media — still set up bidirectional negotiation so we can
      // receive the remote peer's stream.
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      this.pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    // Remote tracks → attach to remoteEl
    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track:', event.track.kind);
      const attachRemoteStream = () => {
        if (!this.remoteEl) {
          console.error('[WebRTC] remoteEl not found!');
          return;
        }
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
          // Set attributes before play() for the same reason as local video
          this.remoteEl.autoplay    = true;
          this.remoteEl.playsInline = true;
          this.remoteEl.muted       = false;
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
      // When the remote peer turns camera off, their video track becomes muted
      event.track.onmute = () => {
        if (event.track.kind === 'video') {
          console.log('[WebRTC] Remote camera turned off');
          this._emit('remote_camera_off');
        }
      };
      event.track.onended = () => {
        if (event.track.kind === 'video') {
          console.log('[WebRTC] Remote video track ended');
          this._emit('remote_camera_off');
        }
      };
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.client.sendSignal({ type: 'ice_candidate', candidate: event.candidate });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      console.log('[WebRTC] ICE state:', state);
      this._emit('ice_state', { state });

      if (state === 'connected' || state === 'completed') {
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = null;
        this._emit('connected');
      } else if (state === 'failed') {
        console.warn('[WebRTC] ICE failed — attempting restart');
        this._iceRestart();
      } else if (state === 'disconnected') {
        this._emit('peer_disconnected');
        if (!this._disconnectTimer) {
          this._disconnectTimer = setTimeout(() => {
            this._disconnectTimer = null;
            this._iceRestart();
          }, 2500);
        }
      } else if (state === 'checking') {
        this._armRemoteStreamWatchdog();
      }
    };

    // BUG FIX: guard with _makingOffer so this handler and the peer_joined
    // handler never create two concurrent offers. Without the guard:
    //   • addTrack() → onnegotiationneeded → _createOffer()  [offer #1]
    //   • start() was also calling _createOffer() explicitly  [offer #2]
    //   • peer_joined could call _createOffer() as well       [offer #3]
    // Two simultaneous setLocalDescription calls throw InvalidStateError
    // and the PC ends up stuck in a broken state.
    this.pc.onnegotiationneeded = async () => {
      // Perfect Negotiation: allow both peers to renegotiate so that
      // camera/mic toggles by the non-host are also signalled to the remote.
      // Glare (simultaneous offers) is resolved in _onSignal below.
      await this._createOffer();
    };
  }

  // ── Offer / Answer ──────────────────────────────────────────────────────

  async _createOffer() {
    if (!this.pc) return;

    // BUG FIX: skip if already in the middle of creating an offer.
    if (this._makingOffer) {
      console.log('[WebRTC] Skipping redundant _createOffer (already making one)');
      return;
    }

    this._makingOffer = true;
    try {
      const offer = await this.pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true,
      });
      // Guard again: signalingState must still be 'stable' (no race)
      if (this.pc.signalingState !== 'stable') {
        console.warn('[WebRTC] signalingState changed before setLocalDescription — aborting offer');
        return;
      }
      await this.pc.setLocalDescription(offer);
      this.client.sendSignal({ type: 'offer', sdp: offer });
      console.log('[WebRTC] Offer sent');
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

  // ── Incoming signal handler ─────────────────────────────────────────────

  async _onSignal(signal) {
    if (!signal) return;

    switch (signal.type) {
      case 'offer':
        console.log('[WebRTC] Received offer');
        if (!this._started) {
          await this.start(false);
        }
        // Perfect Negotiation glare handling.
        // If we are also in the middle of making an offer (race), the
        // "impolite" peer (initiator) silently drops the incoming offer and
        // keeps their own. The "polite" peer (non-initiator) rolls back their
        // pending offer and accepts the incoming one instead.
        {
          const collision = this._makingOffer || this.pc?.signalingState !== 'stable';
          if (collision) {
            if (this.isInitiator) {
              // Impolite peer — ignore the colliding incoming offer.
              console.log('[WebRTC] Offer collision — impolite peer ignoring incoming offer');
              break;
            }
            // Polite peer — roll back our pending offer and answer theirs.
            console.log('[WebRTC] Offer collision — polite peer rolling back');
            await this.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
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

      // BUG FIX: removed the 'ice_restart' case entirely. The old _iceRestart()
      // was sending BOTH a new offer (correct) AND an 'ice_restart' signal that
      // told the peer to also create an offer (wrong). That caused an offer
      // collision. Now ICE restart is handled solely by the new offer.
    }
  }

  async _flushPendingCandidates() {
    for (const c of this._pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
    }
    this._pendingCandidates = [];
  }

  async _iceRestart() {
    // BUG FIX: old code sent both a new offer AND a separate 'ice_restart'
    // signal. The signal caused the peer to also create an offer — offer
    // collision. Now we just send a new offer with iceRestart:true.
    // Only the initiator creates the restart offer; the non-initiator will
    // receive it as a normal 'offer' signal and answer it.
    if (!this.pc || !this.isInitiator) return;
    try {
      this._makingOffer = true;
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.client.sendSignal({ type: 'offer', sdp: offer });
      this._armRemoteStreamWatchdog();
      console.log('[WebRTC] ICE restart offer sent');
    } catch (err) {
      console.error('[WebRTC] ICE restart failed:', err);
    } finally {
      this._makingOffer = false;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _getTrack(kind) {
    return this.localStream?.getTracks().find(t => t.kind === kind) ?? null;
  }

  _bindRemotePlaybackRetry() {
    document.addEventListener('pointerup',        this._boundRemotePlaybackRetry, true);
    document.addEventListener('touchend',         this._boundRemotePlaybackRetry, true);
    document.addEventListener('keydown',          this._boundRemotePlaybackRetry, true);
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
        console.warn('[WebRTC] Remote stream missing after timeout — retrying negotiation');
        this._iceRestart();
      }
    }, 5000);
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(Object.assign(new Event(type), { detail }));
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail ?? {}));
    return this;
  }
}
