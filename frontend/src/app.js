
import { WatchTogetherClient } from './client.js';
import { VideoCall } from './webrtc.js';

// ── Config ────────────────────────────────────────────────────────────────
const APP_CONFIG = window.WATCH_TOGETHER_CONFIG ?? {};

function normalizeBaseUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/g, '') : '';
}

function deriveWsBaseUrl(httpBaseUrl) {
  if (!httpBaseUrl) return '';
  return httpBaseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

const BACKEND_BASE_URL =
  normalizeBaseUrl(APP_CONFIG.backendBaseUrl) ||
  normalizeBaseUrl(APP_CONFIG.apiBaseUrl) ||
  window.location.origin;
const API_BASE_URL = normalizeBaseUrl(APP_CONFIG.apiBaseUrl) || BACKEND_BASE_URL;
const WS_BASE_URL = normalizeBaseUrl(APP_CONFIG.wsBaseUrl) || deriveWsBaseUrl(BACKEND_BASE_URL);
const SERVER_ORIGIN = API_BASE_URL;
const SERVER_URL = `${WS_BASE_URL}/ws`;

async function wakeBackend() {
  try {
    await fetch(`${BACKEND_BASE_URL}/health`, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
    });
  } catch (err) {
    console.warn('Backend wake-up ping failed:', err);
  }
}

function setCreateRoomLoading(isLoading) {
  if (!createRoomBtn) return;
  createRoomPending = isLoading;
  createRoomBtn.disabled = isLoading;
  createRoomBtn.classList.toggle('is-loading', isLoading);
  if (createRoomBtnLabel) {
    createRoomBtnLabel.textContent = isLoading ? 'Creating room...' : '✦ Create a room';
  }
}

// ── DOM references ─────────────────────────────────────────────────────────
const movieVideo    = document.getElementById('movie-video');     // <video> for the movie file
const localVideo    = document.getElementById('local-video');     // <video muted> PiP self-view
const remoteVideo   = document.getElementById('remote-video');    // <video> friend's face

const fileInput     = document.getElementById('file-input');
const playPauseBtn  = document.getElementById('play-pause-btn');
const seekBar       = document.getElementById('seek-bar');

const muteBtn       = document.getElementById('mute-btn');
const cameraBtn     = document.getElementById('camera-btn');
const endCallBtn    = document.getElementById('end-call-btn');
const muteIcon      = document.getElementById('mute-icon');
const cameraIcon    = document.getElementById('camera-icon');
const watchBackBtn  = document.getElementById('watch-back-btn');
const lobbyBackBtn  = document.getElementById('lobby-back-btn');

const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn   = document.getElementById('join-room-btn');
const roomCodeInput = document.getElementById('room-code-input');
const readyBtn      = document.getElementById('ready-btn');
const landingAlert  = document.getElementById('landing-alert');
const createRoomBtnLabel = createRoomBtn?.querySelector('.btn-label');

const syncToast     = document.getElementById('sync-toast');
const reactionBtns  = document.querySelectorAll('[data-reaction]');

// ── App state ─────────────────────────────────────────────────────────────
let client   = null;
let call     = null;
let callStarting = false;
let isHost   = false;
let myName   = 'You';
let myFileName = null;
let roomCode = null;
let peerPresent = false;
let createRoomPending = false;
let syncPlaybackRateTimer = null;
let syncToastCooldownUntil = 0;

const SOFT_SYNC_THRESHOLD_SEC = 0.8;
const HARD_SYNC_THRESHOLD_SEC = 4;
const SYNC_TOAST_THRESHOLD_SEC = 6;
const SYNC_TOAST_COOLDOWN_MS = 12000;
const SYNC_RATE_RESET_MS = 2200;
const FAST_CATCHUP_RATE = 1.08;
const SLOW_CATCHUP_RATE = 0.94;

function resetReadyState({ disable = true } = {}) {
  if (!readyBtn) return;
  readyBtn.dataset.ready = 'false';
  readyBtn.textContent = "I'm ready 🍿";
  readyBtn.classList.remove('active');
  readyBtn.disabled = disable;
}

function clearOwnFileSelection() {
  const yourFileDrop = document.getElementById('your-file-drop');
  const yourFileLabel = document.getElementById('your-file-label');
  const yourIconEl = document.querySelector('#your-file-drop .fd-icon');
  if (yourFileDrop) yourFileDrop.classList.remove('loaded');
  if (yourFileLabel) yourFileLabel.innerHTML = 'Tap to pick<br>your video file';
  if (yourIconEl) yourIconEl.textContent = '🎬';
}

function setSyncStatus(message, tone = 'idle') {
  const syncLabel = document.getElementById('sync-label');
  const syncDot = document.getElementById('sync-dot');
  if (syncLabel) syncLabel.textContent = message;
  if (syncDot) syncDot.className = `sdot ${tone}`;
}

function getVideoDurationSec() {
  return Number.isFinite(movieVideo.duration) ? movieVideo.duration : null;
}

function clampVideoPosition(positionSec) {
  const safePosition = Math.max(0, Number(positionSec) || 0);
  const durationSec = getVideoDurationSec();
  return durationSec == null ? safePosition : Math.min(safePosition, durationSec);
}

function isAtVideoEnd(positionSec = movieVideo.currentTime) {
  const durationSec = getVideoDurationSec();
  return durationSec != null && durationSec > 0 && positionSec >= durationSec - 0.25;
}

function clearSyncPlaybackRate() {
  clearTimeout(syncPlaybackRateTimer);
  syncPlaybackRateTimer = null;
  if (movieVideo.playbackRate !== 1) movieVideo.playbackRate = 1;
}

function schedulePlaybackRateReset() {
  clearTimeout(syncPlaybackRateTimer);
  syncPlaybackRateTimer = setTimeout(() => {
    movieVideo.playbackRate = 1;
    syncPlaybackRateTimer = null;
  }, SYNC_RATE_RESET_MS);
}

function getCompensatedSyncPosition(positionSec, playing, serverTs) {
  const basePos = clampVideoPosition(positionSec);
  if (!playing || typeof serverTs !== 'number') return basePos;
  const latencySec = Math.max(0, Date.now() - serverTs) / 1000;
  return clampVideoPosition(basePos + latencySec);
}

function maybeShowSyncToast(message, driftSec) {
  if (driftSec < SYNC_TOAST_THRESHOLD_SEC) return;
  const now = Date.now();
  if (now < syncToastCooldownUntil) return;
  syncToastCooldownUntil = now + SYNC_TOAST_COOLDOWN_MS;
  showToast(message, 'info');
}

function applyHardSync({ targetPos, playing, announce = false, driftSec = 0 }) {
  clearSyncPlaybackRate();
  movieVideo.currentTime = targetPos;
  if (announce) {
    maybeShowSyncToast(`Resyncing… (${driftSec.toFixed(1)}s drift)`, driftSec);
  }
  const shouldPauseAtEnd = isAtVideoEnd(targetPos);
  if (playing && !shouldPauseAtEnd) {
    movieVideo.play().catch(() => {});
  } else {
    movieVideo.pause();
  }
}

async function handleSyncCorrection({ positionSec, playing, serverTs, drift, source = 'sync' }) {
  const targetPos = getCompensatedSyncPosition(positionSec, playing, serverTs);
  const localPos = clampVideoPosition(movieVideo.currentTime);
  const signedDrift = targetPos - localPos;
  const driftSec = Math.abs(Number.isFinite(drift) ? drift : signedDrift);
  const shouldPauseAtEnd = isAtVideoEnd(targetPos);

  if (source === 'sync' && playing && targetPos < 0.5 && localPos > 5) {
    console.warn('[Sync] Ignoring suspicious reset-to-zero correction', { targetPos, localPos, driftSec });
    return;
  }

  if (!playing) {
    clearSyncPlaybackRate();
    if (Math.abs(signedDrift) > 0.15) movieVideo.currentTime = targetPos;
    if (!movieVideo.paused) movieVideo.pause();
    return;
  }

  if (shouldPauseAtEnd) {
    applyHardSync({ targetPos, playing: false, announce: false, driftSec });
    return;
  }

  if (source === 'command') {
    applyHardSync({ targetPos, playing: true, announce: false, driftSec });
    return;
  }

  if (movieVideo.seeking) return;

  if (driftSec >= HARD_SYNC_THRESHOLD_SEC || movieVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
    applyHardSync({ targetPos, playing: true, announce: true, driftSec });
    return;
  }

  if (movieVideo.paused) {
    applyHardSync({ targetPos, playing: true, announce: false, driftSec });
    return;
  }

  if (driftSec < SOFT_SYNC_THRESHOLD_SEC) {
    clearSyncPlaybackRate();
    return;
  }

  movieVideo.playbackRate = signedDrift > 0 ? FAST_CATCHUP_RATE : SLOW_CATCHUP_RATE;
  schedulePlaybackRateReset();
}

function leaveWatchToLobby({ clearFile = false, keepCall = true, notice = '' } = {}) {
  clearSyncPlaybackRate();
  movieVideo.pause();
  movieVideo.currentTime = 0;
  if (clearFile) {
    movieVideo.removeAttribute('src');
    movieVideo.load();
    myFileName = null;
    if (fileInput) fileInput.value = '';
    clearOwnFileSelection();
  }
  if (!keepCall) {
    call?.end();
    call = null;
    showCallUI(false);
  } else if (call) {
    showCallUI(true);
  }
  showLobby(roomCode);
  resetReadyState({ disable: true });
  client?.setReady(false);
  setSyncStatus(notice || (clearFile ? 'Pick your video file to check for sync' : 'Your friend is choosing a different file.'), clearFile ? 'idle' : 'warn');
}

function getPeerDisplayName() {
  return document.getElementById('friend-name')?.textContent?.trim() || 'Your friend';
}

async function ensureVideoCall() {
  if (!client || call || callStarting || !peerPresent) return;
  callStarting = true;
  try {
    await startVideoCall();
  } finally {
    callStarting = false;
  }
}

function normalizeRoomCode(value) {
  return value.trim().replace(/^\/+|\/+$/g, '').toUpperCase();
}

function getRoomCodeFromPath() {
  const code = normalizeRoomCode(window.location.pathname);
  return /^[A-Z0-9-]{4,20}$/.test(code) ? code : null;
}

function showLandingNotice(message) {
  if (!landingAlert) return;
  landingAlert.textContent = message;
  landingAlert.classList.add('show');
}

function clearLandingNotice() {
  landingAlert?.classList.remove('show');
  if (landingAlert) landingAlert.textContent = '';
}

function showLandingScreen() {
  document.getElementById('screen-lobby')?.classList.remove('active');
  document.getElementById('screen-watch')?.classList.remove('active');
  document.getElementById('screen-landing')?.classList.add('active');
}

function resetToLanding(message = '') {
  roomCode = null;
  isHost = false;
  peerPresent = false;
  myFileName = null;
  client = null;
  call = null;
  callStarting = false;
  roomCodeInput.value = '';
  window.history.replaceState({}, '', '/');
  showLandingScreen();
  if (message) showLandingNotice(message);
}

function leaveRoomAndGoHome(message = '') {
  clearSyncPlaybackRate();
  movieVideo.pause();
  movieVideo.currentTime = 0;
  movieVideo.removeAttribute('src');
  movieVideo.load();
  if (fileInput) fileInput.value = '';
  clearOwnFileSelection();
  resetReadyState({ disable: true });
  setSyncStatus('Pick your video file to check for sync', 'idle');
  call?.end();
  call = null;
  showCallUI(false);
  client?.disconnect();
  resetToLanding(message);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. ROOM CREATION / JOINING
// ═════════════════════════════════════════════════════════════════════════════

createRoomBtn?.addEventListener('click', async () => {
  if (createRoomPending) return;
  setCreateRoomLoading(true);
  clearLandingNotice();
  showLandingNotice('Waking up the server and creating your room...');
  try {
    const res = await fetch(`${SERVER_ORIGIN}/api/rooms`, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Create room failed (${res.status})`);

    const data = await res.json();
    roomCode = data.roomCode;
    isHost   = true;
    myName   = prompt('Your name?') || 'You';

    showLobby(roomCode);
    await connectAndJoin();
  } catch (err) {
    console.error('Create room failed:', err);
    showLandingNotice('The server is still waking up. Please wait a moment and try again.');
  } finally {
    setCreateRoomLoading(false);
  }
});

joinRoomBtn?.addEventListener('click', async () => {
  clearLandingNotice();
  const code = roomCodeInput?.value.trim().toUpperCase();
  if (!code) return alert('Enter a room code');

  // Validate the room exists before connecting
  const res = await fetch(`${SERVER_ORIGIN}/api/rooms/${code}`);
  if (!res.ok) return alert('Room not found or full');

  roomCode = code;
  isHost   = false;
  myName   = prompt('Your name?') || 'Guest';

  showLobby(roomCode);
  await connectAndJoin();
});

async function connectAndJoin() {
  client = new WatchTogetherClient(SERVER_URL);
  await client.connect();
  client.join({ roomCode, name: myName, isHost });

  // Wire up all event listeners
  wireClientEvents();
  wireVideoControls();
  wireReactions();
}

async function autoJoinFromPath() {
  const rawPath = normalizeRoomCode(window.location.pathname);
  if (!rawPath) return;

  const code = getRoomCodeFromPath();
  if (!code) {
    resetToLanding('That invite link is not a valid room code.');
    return;
  }

  roomCode = code;
  roomCodeInput.value = code;

  try {
    const res = await fetch(`${SERVER_ORIGIN}/api/rooms/${code}`);
    if (!res.ok) {
      resetToLanding('That room was not found or is already full.');
      return;
    }

    isHost = false;
    clearLandingNotice();
    myName = prompt('Your name?') || 'Guest';
    showLobby(roomCode);
    await connectAndJoin();
  } catch (err) {
    console.error('Auto-join failed:', err);
    resetToLanding('Could not auto-join that room right now. Please try again.');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. CLIENT (SYNC) EVENTS
// ═════════════════════════════════════════════════════════════════════════════

function wireClientEvents() {

  client.on('joined', (data) => {
    console.log('Joined room', data.roomCode, 'as', data.yourPeerId);
    peerPresent = data.peers.some((peer) => peer.peerId !== data.yourPeerId);
    updatePeerList(data.peers);
    // Show file status and ready state for any peer that already has loaded data
    data.peers.forEach(peer => {
      if (peer.peerId !== data.yourPeerId) {
        if (peer.fileDuration) {
          updatePeerFileStatus(peer.peerId, peer.fileDuration, peer.fileName);
        }
        if (peer.isReady) {
          updatePeerReadyState(peer.peerId, peer.isReady);
        }
      }
    });
    if (peerPresent) ensureVideoCall();
  });

  client.on('peer_joined', (data) => {
    peerPresent = true;
    showToast(`${data.name} joined the room 🎉`);
    addPeerToUI(data);
    ensureVideoCall();
  });

  client.on('peer_left', (data) => {
    peerPresent = false;
    showToast(`${data.name} left the room`);
    removePeerFromUI(data.peerId);
    call?.end();
    call = null;
    // Video auto-pauses server-side; mirror it here
    movieVideo.pause();
    setSyncStatus('Waiting for your friend to join', 'idle');
  });

  // ── File loading ─────────────────────────────────────────────────────────
  client.on('peer_file_ready', (data) => {
    updatePeerFileStatus(data.peerId, data.durationSec, data.fileName);
    resetReadyState({ disable: true });
    setSyncStatus(`${getPeerDisplayName()} changed their file. Re-check sync before starting.`, 'warn');
    const fileLabel = data.fileName ? ` "${data.fileName}"` : '';
    showToast(`${getPeerDisplayName()} picked a different file${fileLabel}`, 'info');
  });

  client.on('duration_check', ({ match, diff }) => {
    if (match) {
      showToast('Files match ✓ — same movie confirmed', 'success');
      readyBtn.disabled = false;
      setSyncStatus('Files match. Both of you can get ready.', 'ok');
    } else {
      showToast(`Duration mismatch: ${diff.toFixed(1)}s difference — check your files`, 'warn');
      setSyncStatus(`Duration mismatch: ${diff.toFixed(1)}s difference — check your files`, 'warn');
    }
  });

  // ── Lobby ready ──────────────────────────────────────────────────────────
  client.on('peer_ready', ({ peerId, isReady }) => {
    updatePeerReadyState(peerId, isReady);
  });

  client.on('countdown_start', ({ positionSec }) => {
    movieVideo.currentTime = positionSec;
    startCountdown(() => {
      showWatchScreen();
      showCallUI(!!call);
    });
  });

  client.on('return_to_lobby', ({ name }) => {
    leaveWatchToLobby({
      clearFile: false,
      keepCall: true,
      notice: `${name || getPeerDisplayName()} went back to pick a different file.`
    });
    showToast(`${name || getPeerDisplayName()} went back to file selection`, 'info');
  });

  // ── Playback sync ────────────────────────────────────────────────────────

  // A play/pause command relayed from the master peer
  client.on('play_pause', async ({ playing, positionSec, serverTs }) => {
    try {
      await handleSyncCorrection({ positionSec, playing, serverTs, source: 'command' });
    } catch (e) {
      console.warn('play() blocked by browser autoplay policy:', e.message);
    }
  });

  // A seek command from the master peer
  client.on('seek', ({ positionSec }) => {
    clearSyncPlaybackRate();
    movieVideo.currentTime = clampVideoPosition(positionSec);
  });

  client.on('sync_nudge', async ({ positionSec, playing, serverTs, drift }) => {
    try {
      await handleSyncCorrection({ positionSec, playing, serverTs, drift, source: 'sync' });
    } catch (e) {
      console.warn('sync correction failed:', e.message);
    }
  });

  // ── Reactions ─────────────────────────────────────────────────────────
  client.on('reaction', ({ emoji }) => {
    spawnFloatingReaction(emoji);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. VIDEO FILE CONTROLS (play / pause / seek)
// ═════════════════════════════════════════════════════════════════════════════

function wireVideoControls() {

  // File picker → load into <video> and tell server
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const isNewSelection = myFileName && myFileName !== file.name;
    myFileName = file.name;
    resetReadyState({ disable: true });
    client?.setReady(false);
    setSyncStatus('Checking your new file against your friend\'s copy…', 'idle');
    movieVideo.src = URL.createObjectURL(file);
    movieVideo.addEventListener('loadedmetadata', () => {
      client.fileReady(movieVideo.duration, file.name);
      seekBar && (seekBar.max = movieVideo.duration);
      // Update user's own file icon to checkmark
      const yourIconEl = document.querySelector('#your-file-drop .fd-icon');
      if (yourIconEl) {
        yourIconEl.textContent = '✅';
      }
      setSyncStatus('Waiting for your friend to load the same file', 'idle');
      if (isNewSelection) {
        showToast('New file selected. Waiting for your friend to re-check sync.');
      }
    }, { once: true });
  });

  // ── Play / Pause ─────────────────────────────────────────────────────────
  playPauseBtn?.addEventListener('click', () => {
    const nowPlaying = !movieVideo.paused;
    clearSyncPlaybackRate();
    // Toggle locally first for snappy feel
    if (nowPlaying) movieVideo.pause();
    else            movieVideo.play().catch(() => {});
    // Tell server/peer (we become master for this action)
    client.playPause(!nowPlaying, movieVideo.currentTime);
  });

  // Keyboard shortcut: space bar
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      playPauseBtn?.click();
    }
  });

  // ── Seek bar ─────────────────────────────────────────────────────────────
  let isSeeking = false;

  seekBar?.addEventListener('mousedown', () => { isSeeking = true; });

  seekBar?.addEventListener('input', () => {
    clearSyncPlaybackRate();
    movieVideo.currentTime = Number(seekBar.value);
  });

  seekBar?.addEventListener('mouseup', () => {
    isSeeking = false;
    clearSyncPlaybackRate();
    client.seek(movieVideo.currentTime);  // broadcast final position
  });

  // Keep seek bar in sync with playback
  movieVideo.addEventListener('timeupdate', () => {
    if (!isSeeking && seekBar) seekBar.value = movieVideo.currentTime;
  });

  movieVideo.addEventListener('ended', () => {
    clearSyncPlaybackRate();
    const finalPosition = clampVideoPosition(movieVideo.duration || movieVideo.currentTime);
    if (seekBar) seekBar.value = finalPosition;
    client?.playPause(false, finalPosition);
  });

  movieVideo.addEventListener('waiting', () => {
    clearSyncPlaybackRate();
  });

  movieVideo.addEventListener('stalled', () => {
    clearSyncPlaybackRate();
  });

  // ── Sync heartbeat ───────────────────────────────────────────────────────
  // Tell the client where to read the video position from
  client.setPositionGetter(() => clampVideoPosition(movieVideo.currentTime));

  // ── Ready button ─────────────────────────────────────────────────────────
  readyBtn?.addEventListener('click', () => {
    const nowReady = readyBtn.dataset.ready !== 'true';
    readyBtn.dataset.ready = nowReady;
    readyBtn.textContent   = nowReady ? "✓ Let's go!" : "I'm ready 🍿";
    client.setReady(nowReady);

    if (nowReady && !peerPresent) {
      showToast('Waiting for your friend to join, load the same file, and get ready');
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. WEBRTC VIDEO CALL
// ═════════════════════════════════════════════════════════════════════════════

async function startVideoCall() {
  if (call) return call;
  call = new VideoCall(client, localVideo, remoteVideo);

  call
    .on('started', ({ hasVideo, hasAudio }) => {
      console.log('Call started — video:', hasVideo, 'audio:', hasAudio);
      showCallUI(true);
    })
    .on('connected', () => {
      showToast('Video call connected 📹');
    })
    .on('peer_disconnected', () => {
      showToast('Call disconnected — reconnecting…');
    })
    .on('camera_unavailable', () => {
      showToast('Camera not available — audio only');
    })
    .on('ended', () => {
      showCallUI(false);
      call = null;
    });

  // Host is the WebRTC offer initiator; guest auto-answers via 'peer_joined' signal
  await call.start(isHost);
  return call;
}

// ── Mute button ─────────────────────────────────────────────────────────────
muteBtn?.addEventListener('click', () => {
  if (!call) return;
  const muted = call.toggleMute();
  muteBtn.classList.toggle('active', muted);
  if (muteIcon) muteIcon.textContent = muted ? 'mic_off' : 'mic';
  muteBtn.title = muted ? 'Unmute microphone' : 'Mute microphone';
  muteBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
});

// ── Camera toggle ────────────────────────────────────────────────────────────
cameraBtn?.addEventListener('click', () => {
  if (!call) return;
  const hidden = call.toggleCamera();
  cameraBtn.classList.toggle('active', hidden);
  if (cameraIcon) cameraIcon.textContent = hidden ? 'videocam_off' : 'videocam';
  cameraBtn.title = hidden ? 'Show camera' : 'Hide camera';
  cameraBtn.setAttribute('aria-label', hidden ? 'Show camera' : 'Hide camera');

  // Show/hide local video element
  localVideo.style.opacity = hidden ? '0' : '1';
});

// ── End call ─────────────────────────────────────────────────────────────────
endCallBtn?.addEventListener('click', () => {
  call?.end();
  call = null;
});

watchBackBtn?.addEventListener('click', () => {
  client?.returnToLobby();
  leaveWatchToLobby({
    clearFile: true,
    keepCall: true,
    notice: 'Pick your video file to check for sync'
  });
});

lobbyBackBtn?.addEventListener('click', () => {
  leaveRoomAndGoHome();
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. REACTIONS
// ═════════════════════════════════════════════════════════════════════════════

function wireReactions() {
  reactionBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.reaction;
      spawnFloatingReaction(emoji);   // show locally immediately
      client.react(emoji);            // broadcast to peer
    });
  });
}

function spawnFloatingReaction(emoji) {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.style.cssText = `
    position: fixed;
    bottom: 80px;
    left: ${15 + Math.random() * 60}%;
    font-size: 32px;
    pointer-events: none;
    z-index: 9999;
    animation: floatUp 2.5s ease-out forwards;
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. UI HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function showLobby(code) {
  clearLandingNotice();
  document.getElementById('screen-landing')?.classList.remove('active');
  document.getElementById('screen-watch')?.classList.remove('active');
  document.getElementById('screen-lobby')?.classList.add('active');
  const codeEl = document.getElementById('lobby-room-code');
  if (codeEl) codeEl.textContent = code;
  const roomPath = `/${code}`;
  if (window.location.pathname !== roomPath) {
    window.history.replaceState({}, '', roomPath);
  }
  window.setRoomCode(code);  // Update share link in HTML
}

function showCallUI(visible) {
  document.getElementById('call-controls')?.style.setProperty('display', visible ? 'flex' : 'none');
  const pipBubble = document.getElementById('pip-bubble');
  pipBubble?.style.setProperty('display', visible ? 'block' : 'none');
  if (visible) {
    if (pipBubble) {
      pipBubble.style.left = '';
      pipBubble.style.top = '20px';
      pipBubble.style.right = '20px';
    }
    muteBtn?.classList.remove('active');
    cameraBtn?.classList.remove('active');
    if (muteBtn) {
      muteBtn.title = 'Mute microphone';
      muteBtn.setAttribute('aria-label', 'Mute microphone');
    }
    if (cameraBtn) {
      cameraBtn.title = 'Hide camera';
      cameraBtn.setAttribute('aria-label', 'Hide camera');
    }
    if (muteIcon) muteIcon.textContent = 'mic';
    if (cameraIcon) cameraIcon.textContent = 'videocam';
    localVideo.style.opacity = '1';
  }
}

function showWatchScreen() {
  document.getElementById('screen-landing')?.classList.remove('active');
  document.getElementById('screen-lobby')?.classList.remove('active');
  document.getElementById('screen-watch')?.classList.add('active');
}

function updatePeerList(peers) {
  peers.forEach(p => {
    if (p.peerId !== client.peerId) addPeerToUI(p);
  });
}

function addPeerToUI(peer) {
  const el = document.getElementById('friend-card');
  if (!el) return;
  el.querySelector('.pname').textContent = peer.name;
  el.querySelector('.pav').textContent   = peer.name.slice(0, 2).toUpperCase();
  const fileLabelEl = document.getElementById('friend-file-label');
  const friendIconEl = document.querySelector('#friend-card .file-drop .fd-icon');
  if (fileLabelEl) fileLabelEl.innerHTML = 'Waiting for<br>your friend to choose a file';
  if (friendIconEl) friendIconEl.textContent = '🎬';
}

function removePeerFromUI(peerId) {
  const el = document.getElementById('friend-card');
  if (!el) return;
  el.querySelector('.pname').textContent = 'Waiting…';
  el.querySelector('.pav').textContent   = '?';
  const fileLabelEl = document.getElementById('friend-file-label');
  const friendIconEl = document.querySelector('#friend-card .file-drop .fd-icon');
  if (fileLabelEl) fileLabelEl.innerHTML = 'Waiting for<br>your friend to join';
  if (friendIconEl) friendIconEl.textContent = '🌙';
}

function updatePeerFileStatus(peerId, durationSec, fileName = null) {
  const el = document.getElementById('friend-file-label');
  const friendIconEl = document.querySelector('#friend-card .file-drop .fd-icon');
  if (el) {
    let display = `File loaded &nbsp;<span class="fd-dur">${formatDur(durationSec)}</span>`;
    if (fileName) {
      const truncated = truncateFileName(fileName, 20);
      display = `${truncated} &nbsp;<span class="fd-dur">${formatDur(durationSec)}</span>`;
    }
    el.innerHTML = display;
  }
  if (friendIconEl) {
    friendIconEl.textContent = '✅';
  }
}

function truncateFileName(fileName, maxLength = 20) {
  if (fileName.length <= maxLength) return fileName;
  const lastDotIndex = fileName.lastIndexOf('.');
  if (lastDotIndex === -1) return fileName.substring(0, maxLength - 3) + '...';
  const ext = fileName.substring(lastDotIndex);
  const nameLength = maxLength - 3 - ext.length;
  return fileName.substring(0, nameLength) + '...' + ext;
}

function updatePeerReadyState(peerId, isReady) {
  const el = document.getElementById('friend-ready-indicator');
  if (el) el.textContent = isReady ? '✓ Ready' : 'Not ready';
}

let countdownTimer = null;
function startCountdown(onDone) {
  const el = document.getElementById('countdown-number');
  const overlay = document.getElementById('countdown-overlay');
  overlay?.classList.add('show');
  let n = 3;
  if (el) el.textContent = n;
  countdownTimer = setInterval(() => {
    n--;
    if (n === 0) {
      clearInterval(countdownTimer);
      overlay?.classList.remove('show');
      onDone();
    } else {
      if (el) el.textContent = n;
    }
  }, 1000);
}

let toastTimer = null;
function showToast(msg, variant = 'info') {
  if (!syncToast) return;
  syncToast.textContent = msg;
  syncToast.className   = `sync-toast show ${variant}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => syncToast.classList.remove('show'), 4000);
}

function formatDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// Add keyframe for floating reactions if not already in CSS
const style = document.createElement('style');
style.textContent = `@keyframes floatUp { from { opacity:1; transform:translateY(0) scale(1); } to { opacity:0; transform:translateY(-160px) scale(1.5); } }`;
document.head.appendChild(style);

void wakeBackend();
autoJoinFromPath();
