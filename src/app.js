
import { WatchTogetherClient } from './client.js';
import { VideoCall } from './webrtc.js';

// ── Config ────────────────────────────────────────────────────────────────
const SERVER_ORIGIN = window.location.origin;
const SERVER_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

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

const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn   = document.getElementById('join-room-btn');
const roomCodeInput = document.getElementById('room-code-input');
const readyBtn      = document.getElementById('ready-btn');
const landingAlert  = document.getElementById('landing-alert');

const syncToast     = document.getElementById('sync-toast');
const reactionBtns  = document.querySelectorAll('[data-reaction]');

// ── App state ─────────────────────────────────────────────────────────────
let client   = null;
let call     = null;
let isHost   = false;
let myName   = 'You';
let myFileName = null;
let roomCode = null;
let peerPresent = false;

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
  roomCodeInput.value = '';
  window.history.replaceState({}, '', '/');
  showLandingScreen();
  if (message) showLandingNotice(message);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. ROOM CREATION / JOINING
// ═════════════════════════════════════════════════════════════════════════════

createRoomBtn?.addEventListener('click', async () => {
  clearLandingNotice();
  // Ask the server to create a room and get a code back
  const res  = await fetch(`${SERVER_ORIGIN}/api/rooms`, { method: 'POST' });
  const data = await res.json();
  roomCode = data.roomCode;
  isHost   = true;
  myName   = prompt('Your name?') || 'You';

  showLobby(roomCode);
  await connectAndJoin();
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
  });

  client.on('peer_joined', (data) => {
    peerPresent = true;
    showToast(`${data.name} joined the room 🎉`);
    addPeerToUI(data);
  });

  client.on('peer_left', (data) => {
    peerPresent = false;
    showToast(`${data.name} left the room`);
    removePeerFromUI(data.peerId);
    // Video auto-pauses server-side; mirror it here
    movieVideo.pause();
  });

  // ── File loading ─────────────────────────────────────────────────────────
  client.on('peer_file_ready', (data) => {
    updatePeerFileStatus(data.peerId, data.durationSec, data.fileName);
  });

  client.on('duration_check', ({ match, diff }) => {
    if (match) {
      showToast('Files match ✓ — same movie confirmed', 'success');
      readyBtn.disabled = false;
    } else {
      showToast(`Duration mismatch: ${diff.toFixed(1)}s difference — check your files`, 'warn');
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
      // Countdown finished — host initiates call, guest auto-answers
      startVideoCall();
    });
  });

  // ── Playback sync ────────────────────────────────────────────────────────

  // A play/pause command relayed from the master peer
  client.on('play_pause', async ({ playing, positionSec, serverTs }) => {
    // Compensate for round-trip latency
    const latencyMs = Date.now() - serverTs;
    const compensatedPos = positionSec + (playing ? latencyMs / 1000 : 0);

    movieVideo.currentTime = Math.max(0, compensatedPos);
    try {
      if (playing) await movieVideo.play();
      else         movieVideo.pause();
    } catch (e) {
      console.warn('play() blocked by browser autoplay policy:', e.message);
    }
  });

  // A seek command from the master peer
  client.on('seek', ({ positionSec }) => {
    movieVideo.currentTime = positionSec;
  });

  // Server detected drift > 2s — snap back into sync
  client.on('apply_sync', async ({ positionSec, playing }) => {
    showToast(`Resyncing… (${Math.abs(movieVideo.currentTime - positionSec).toFixed(1)}s drift)`);
    movieVideo.currentTime = positionSec;
    if (playing && movieVideo.paused)  await movieVideo.play().catch(() => {});
    if (!playing && !movieVideo.paused) movieVideo.pause();
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
    myFileName = file.name;
    movieVideo.src = URL.createObjectURL(file);
    movieVideo.addEventListener('loadedmetadata', () => {
      client.fileReady(movieVideo.duration, file.name);
      seekBar && (seekBar.max = movieVideo.duration);
      // Update user's own file icon to checkmark
      const yourIconEl = document.querySelector('#your-file-drop .fd-icon');
      if (yourIconEl) {
        yourIconEl.textContent = '✅';
      }
    }, { once: true });
  });

  // ── Play / Pause ─────────────────────────────────────────────────────────
  playPauseBtn?.addEventListener('click', () => {
    const nowPlaying = !movieVideo.paused;
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
    movieVideo.currentTime = Number(seekBar.value);
  });

  seekBar?.addEventListener('mouseup', () => {
    isSeeking = false;
    client.seek(movieVideo.currentTime);  // broadcast final position
  });

  // Keep seek bar in sync with playback
  movieVideo.addEventListener('timeupdate', () => {
    if (!isSeeking && seekBar) seekBar.value = movieVideo.currentTime;
  });

  // ── Sync heartbeat ───────────────────────────────────────────────────────
  // Tell the client where to read the video position from
  client.setPositionGetter(() => movieVideo.currentTime);

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
    });

  // Host is the WebRTC offer initiator; guest auto-answers via 'peer_joined' signal
  await call.start(isHost);
}

// ── Mute button ─────────────────────────────────────────────────────────────
muteBtn?.addEventListener('click', () => {
  if (!call) return;
  const muted = call.toggleMute();
  muteBtn.textContent = muted ? '🔇 Unmute' : '🎙 Mute';
  muteBtn.classList.toggle('active', muted);
});

// ── Camera toggle ────────────────────────────────────────────────────────────
cameraBtn?.addEventListener('click', () => {
  if (!call) return;
  const hidden = call.toggleCamera();
  cameraBtn.textContent = hidden ? '📵 Show cam' : '📷 Hide cam';
  cameraBtn.classList.toggle('active', hidden);

  // Show/hide local video element
  localVideo.style.opacity = hidden ? '0' : '1';
});

// ── End call ─────────────────────────────────────────────────────────────────
endCallBtn?.addEventListener('click', () => {
  call?.end();
  call = null;
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
  document.getElementById('pip-bubble')?.style.setProperty('display', visible ? 'block' : 'none');
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
}

function removePeerFromUI(peerId) {
  const el = document.getElementById('friend-card');
  if (!el) return;
  el.querySelector('.pname').textContent = 'Waiting…';
  el.querySelector('.pav').textContent   = '?';
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

autoJoinFromPath();
