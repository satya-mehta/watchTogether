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
 *   await call.start();          // host calls this
 *   // guest just waits — call auto-answers when it receives an offer
 *   call.toggleMute();
 *   call.toggleCamera();
 *   call.end();
 *
 * The `client` param is a WatchTogetherClient instance (from client.js).
 * Signalling is wired automatically via client.sendSignal / client.on('webrtc_signal').
 */

// Public STUN servers — free, no account needed
// For production add TURN servers (Twilio, Metered, coturn) so peers behind
// strict NATs can still connect.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
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
    this.pc        = null;       // RTCPeerConnection
    this.localStream  = null;   // MediaStream (camera + mic)
    this.isInitiator  = false;
    this._started     = false;
    this._pendingCandidates = []; // buffer ICE until remote desc is set

    // Wire incoming signals from the server relay
    this.client.on('webrtc_signal', (data) => this._onSignal(data.signal));
    // When a peer joins the room, the host initiates the call
    this.client.on('peer_joined',   () => { if (this.isInitiator && this._started) this._createOffer(); });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Start the call.
   * Host calls this immediately; guest can also call it to pre-warm the camera.
   * Pass isInitiator=true on the host side so it sends the first offer.
   */
  async start(isInitiator = false) {
    this.isInitiator = isInitiator;
    this._started    = true;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
      });
    } catch (err) {
      // Camera/mic denied — fall back to audio-only, then no-media
      console.warn('[WebRTC] getUserMedia failed, trying audio only:', err.message);
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this._emit('camera_unavailable');
      } catch {
        this.localStream = new MediaStream(); // empty — call continues without media
        this._emit('media_unavailable');
      }
    }

    // Show local preview (muted to avoid echo)
    this.localEl.srcObject = this.localStream;
    this.localEl.muted     = true;
    this.localEl.autoplay  = true;
    this.localEl.playsInline = true;

    this._createPeerConnection();

    // Host sends the offer; guest waits for it
    if (isInitiator) await this._createOffer();

    this._emit('started', { hasVideo: this.hasVideo, hasAudio: this.hasAudio });
  }

  /** Mute / unmute your microphone. Returns new muted state. */
  toggleMute() {
    const track = this._getTrack('audio');
    if (!track) return true;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    this._emit('mute_changed', { muted });
    return muted;
  }

  /** Turn camera on / off. Returns new hidden state. */
  toggleCamera() {
    const track = this._getTrack('video');
    if (!track) return true;
    track.enabled = !track.enabled;
    const hidden = !track.enabled;
    this._emit('camera_changed', { hidden });
    return hidden;
  }

  get isMuted()    { return !this._getTrack('audio')?.enabled ?? true; }
  get isCamOff()   { return !this._getTrack('video')?.enabled ?? true; }
  get hasVideo()   { return (this.localStream?.getVideoTracks().length ?? 0) > 0; }
  get hasAudio()   { return (this.localStream?.getAudioTracks().length ?? 0) > 0; }

  /** Hang up and release all resources. */
  end() {
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.pc          = null;
    this.localStream = null;
    this.localEl.srcObject  = null;
    this.remoteEl.srcObject = null;
    this._emit('ended');
    console.log('[WebRTC] Call ended');
  }

  // ── Peer connection setup ───────────────────────────────────────────────

  _createPeerConnection() {
    if (this.pc) { this.pc.close(); }

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local tracks to the connection
    this.localStream.getTracks().forEach(track => {
      this.pc.addTrack(track, this.localStream);
    });

    // When we get remote tracks, attach them to the remote video element
    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track:', event.track.kind);
      if (!this.remoteEl.srcObject) {
        this.remoteEl.srcObject = new MediaStream();
      }
      this.remoteEl.srcObject.addTrack(event.track);
      this.remoteEl.autoplay   = true;
      this.remoteEl.playsInline = true;
      this._emit('remote_stream', { stream: this.remoteEl.srcObject });
    };

    // Send ICE candidates to peer via server relay
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
        this._emit('connected');
      } else if (state === 'failed') {
        console.warn('[WebRTC] ICE failed — attempting restart');
        this._iceRestart();
      } else if (state === 'disconnected') {
        this._emit('peer_disconnected');
      }
    };

    this.pc.onnegotiationneeded = async () => {
      // Only the initiator renegotiates; avoid offer collision
      if (this.isInitiator) await this._createOffer();
    };
  }

  // ── Offer / Answer ──────────────────────────────────────────────────────

  async _createOffer() {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true,
      });
      await this.pc.setLocalDescription(offer);
      this.client.sendSignal({ type: 'offer', sdp: offer });
      console.log('[WebRTC] Offer sent');
    } catch (err) {
      console.error('[WebRTC] createOffer failed:', err);
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
          // Guest receives offer before calling start() — auto-start camera first
          await this.start(false);
        }
        await this._createAnswer(signal.sdp);
        break;

      case 'answer':
        console.log('[WebRTC] Received answer');
        if (this.pc?.signalingState !== 'stable') {
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await this._flushPendingCandidates();
        }
        break;

      case 'ice_candidate':
        if (!signal.candidate) break;
        if (this.pc?.remoteDescription) {
          await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(console.warn);
        } else {
          // Buffer candidates until remote description is set
          this._pendingCandidates.push(signal.candidate);
        }
        break;

      case 'ice_restart':
        if (this.isInitiator) await this._createOffer();
        break;
    }
  }

  async _flushPendingCandidates() {
    for (const c of this._pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
    }
    this._pendingCandidates = [];
  }

  async _iceRestart() {
    if (!this.pc || !this.isInitiator) return;
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.client.sendSignal({ type: 'offer', sdp: offer });
      this.client.sendSignal({ type: 'ice_restart' });
    } catch (err) {
      console.error('[WebRTC] ICE restart failed:', err);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _getTrack(kind) {
    return this.localStream?.getTracks().find(t => t.kind === kind) ?? null;
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(Object.assign(new Event(type), { detail }));
  }

  /** Subscribe to events. Chainable. */
  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail ?? {}));
    return this;
  }
}
