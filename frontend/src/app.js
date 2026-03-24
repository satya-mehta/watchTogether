import { WatchTogetherClient } from './client.js';
import { VideoCall } from './webrtc.js';
import { Chat } from './chat.js';
import {
  getDisplayInitials,
  getOrCreateDisplayName,
  persistDisplayName,
  sanitizeDisplayName,
} from './profile.js';

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
const movieVideo = document.getElementById('movie-video');     // <video> for the movie file
const localVideo = document.getElementById('local-video');     // <video muted> PiP self-view
const remoteVideo = document.getElementById('remote-video');    // <video> friend's face

const fileInput = document.getElementById('file-input');
const subtitleInput = document.getElementById('subtitle-input');
const subtitlePicker = document.getElementById('subtitle-picker');
const subtitleFileLabel = document.getElementById('subtitle-file-label');
const subtitleClearBtn = document.getElementById('subtitle-clear-btn');
const playPauseBtn = document.getElementById('play-pause-btn');
const seekBar = document.getElementById('seek-bar');
const captionsSelect = document.getElementById('captions-select');
const audioTrackSelect = document.getElementById('audio-track-select');
const captionsHelp = document.getElementById('captions-help');
const audioTrackHelp = document.getElementById('audio-track-help');
const captionsField = captionsSelect?.closest('.track-field');
const audioTrackField = audioTrackSelect?.closest('.track-field');

const muteBtn = document.getElementById('mute-btn');
const cameraBtn = document.getElementById('camera-btn');
const endCallBtn = document.getElementById('end-call-btn');
const muteIcon = document.getElementById('mute-icon');
const cameraIcon = document.getElementById('camera-icon');
const watchBackBtn = document.getElementById('watch-back-btn');
const lobbyBackBtn = document.getElementById('lobby-back-btn');

const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const roomCodeInput = document.getElementById('room-code-input');
const readyBtn = document.getElementById('ready-btn');
const landingAlert = document.getElementById('landing-alert');
const createRoomBtnLabel = createRoomBtn?.querySelector('.btn-label');
const versionBadge = document.getElementById('version-badge');
const selfNameInline = document.getElementById('self-name-inline');
const selfNameText = document.getElementById('self-name-text');
const selfNameEditBtn = document.getElementById('self-name-edit-btn');
const selfNameEditIcon = document.getElementById('self-name-edit-icon');
const yourAvatar = document.getElementById('your-avatar');
const friendAvatar = document.getElementById('friend-avatar');
const remoteMicBadge = document.getElementById('remote-mic-badge');
const remoteNameChip = document.getElementById('remote-name-chip');
const remoteCamOffName = document.getElementById('remote-cam-off-name');
const remoteCamOffAvatar = document.getElementById('remote-cam-off-avatar');
const pipCallControls = document.getElementById('pip-call-controls');
const pipRemoteStage = document.getElementById('pip-remote-stage');
const pipLocalStage = document.getElementById('pip-local-stage');

const syncToast = document.getElementById('sync-toast');
const reactionBtns = document.querySelectorAll('[data-reaction]');
const screenEls = {
  landing: document.getElementById('screen-landing'),
  lobby: document.getElementById('screen-lobby'),
  watch: document.getElementById('screen-watch'),
};

function clearVideoAspectMetadata(videoEl, containerEl) {
  if (videoEl) {
    videoEl.style.removeProperty('width');
    videoEl.style.removeProperty('height');
    delete videoEl.dataset.aspectRatio;
    delete videoEl.dataset.orientation;
  }
  if (containerEl) {
    delete containerEl.dataset.aspectRatio;
    delete containerEl.dataset.orientation;
  }
}

function syncVideoAspectMetadata(videoEl, containerEl) {
  if (!videoEl || !containerEl) return;
  const { videoWidth, videoHeight } = videoEl;
  if (!videoWidth || !videoHeight) {
    clearVideoAspectMetadata(videoEl, containerEl);
    return;
  }

  const ratio = videoWidth / videoHeight;
  const orientation =
    ratio > 1.05
      ? 'landscape'
      : ratio < 0.95
        ? 'portrait'
        : 'square';
  const ratioText = ratio.toFixed(3);

  videoEl.dataset.aspectRatio = ratioText;
  videoEl.dataset.orientation = orientation;
  containerEl.dataset.aspectRatio = ratioText;
  containerEl.dataset.orientation = orientation;

  const { width: containerWidth, height: containerHeight } = containerEl.getBoundingClientRect();
  if (!containerWidth || !containerHeight) return;

  const containerRatio = containerWidth / containerHeight;
  if (ratio > containerRatio) {
    videoEl.style.width = '100%';
    videoEl.style.height = 'auto';
    return;
  }

  videoEl.style.width = 'auto';
  videoEl.style.height = '100%';
}

function wireVideoAspectMetadata(videoEl, containerEl) {
  if (!videoEl || !containerEl) return;
  const sync = () => syncVideoAspectMetadata(videoEl, containerEl);
  videoEl.addEventListener('loadedmetadata', sync);
  videoEl.addEventListener('resize', sync);
  videoEl.addEventListener('emptied', () => clearVideoAspectMetadata(videoEl, containerEl));
  if ('ResizeObserver' in window) {
    new ResizeObserver(sync).observe(containerEl);
  }
  sync();
}

wireVideoAspectMetadata(remoteVideo, pipRemoteStage);
wireVideoAspectMetadata(localVideo, pipLocalStage);

// ── App state ─────────────────────────────────────────────────────────────
let client = null;
let call = null;
let callStarting = false;
let isHost = false;
let myName = getOrCreateDisplayName();
let myFileName = null;
let roomCode = null;
let peerPresent = false;
let createRoomPending = false;
let syncPlaybackRateTimer = null;
let syncToastCooldownUntil = 0;
let playbackRetryPending = false;
let videoControlsWired = false;
let reactionsWired = false;
let recentAuthoritativeSeek = null;
let playbackHealthTimer = null;
let frameCallbackPending = false;
let lastPlaybackProgressAt = 0;
let lastRenderedFrameAt = 0;
let lastFreezeRecoveryAt = 0;
let freezeRecoveryCount = 0;
let lastSentPlayPauseCommand = null;
// To break the sync echo loop we track the last play-state the sync engine
// APPLIED (not just received). We suppress native play/pause events only when
// the event matches the state we just applied AND the event fires within a
// short window after the apply. This means a real user tap in the opposite
// direction (e.g. tap pause 500ms after sync applied play) still goes through
// because the state doesn't match.
let lastAppliedSyncState = null;  // { playing: bool, at: number }
const SYNC_ECHO_SUPPRESS_MS = 800; // window to absorb the echo event after applying
let trackRefreshFrame = null;
let trackRefreshTimeout = null;
let localSubtitleTrackEl = null;
let localSubtitleObjectUrl = null;
let localSubtitleFileName = null;
// ── Global state object (single source of truth) ─────────────────────────
const state = {
  signalingState: 'disconnected',
  presenceState: 'offline',
  callState: 'idle',
};
const appState = state;
const uiState = {
  activeScreen: 'landing',
  isEditingName: false,
};
const remotePeerState = {
  participantId: null,
  name: 'Your friend',
  isCameraOn: true,
  isMicOn: true,
};
const localMediaState = {
  isCameraOn: true,
  isMicOn: true,
};
const participantNames = new Map();
let remoteVideoTrackHidden = false;
let pendingMediaSyncReason = '';
let cameraUITimer = null;
let lastSeekAt = 0;
const PRESENCE_OFFLINE_TIMEOUT_MS = 10000;
const RESUME_AFTER_RECOVERY_DELAY_MS = 4000;
const RESUME_AFTER_ICE_DISCONNECT_DELAY_MS = 8500;
const RESUME_AFTER_ICE_FAILED_DELAY_MS = 2500;
let reconnectTimeout = null;
let resumeCheckTimer = null;
let resumeLockTimer = null;
let isResuming = false;
let lastIceConnectionState = 'new';
let callHasEverConnected = false;
let callConnectionAnnounced = false;
let iceUnhealthySince = 0;

// ── YouTube mode state ────────────────────────────────────────────────────
let roomMode = 'local';  // 'local' | 'youtube'
let ytVideoId = null;     // current YouTube video ID
let ytPlayer = null;     // YT.Player instance
let ytApiReady = false;
let ytPlayerReady = false;
let ytCurrentTime = 0;
let activeVideoId = null; // for fixing rejoin architecture
let ytDuration = 0;
let ytIsPaused = true;
let ytPollingTimer = null;
let ytApiLoadPromise = null;
let ytPlayerInitPromise = null; // mutex — only one initYtPlayer() runs at a time
let isSeeking = false;  // moved to module level so ytPolling can read it

// ── Chat ─────────────────────────────────────────────────────────────────
// Singleton — created once, mounted when watch screen first becomes active,
// reset on every room leave so a fresh session starts with an empty log.
const chat = new Chat({
  client: null,          // filled in by wireClientEvents after connect
  myName,
  getPeerName: () => getPeerDisplayName(),
  resolveParticipantName: (participantId, fallbackName) => resolveParticipantName(participantId, fallbackName),
});
// Let chat.js surface a subtle toast when a message arrives off-panel.
// We hook this after showToast is defined — the assignment happens at bottom
// of module initialisation, here we just reserve the slot.
window._showChatToast = null; // filled in below showToast definition

const SOFT_SYNC_THRESHOLD_SEC = 0.8;
const HARD_SYNC_THRESHOLD_SEC = 4;
const SYNC_TOAST_THRESHOLD_SEC = 6;
const SYNC_TOAST_COOLDOWN_MS = 12000;
const SYNC_RATE_RESET_MS = 2200;
const FAST_CATCHUP_RATE = 1.04;
const SLOW_CATCHUP_RATE = 0.985;
const AUTHORITATIVE_SEEK_WINDOW_MS = 4000;
const AUTHORITATIVE_SEEK_TOLERANCE_SEC = 1.75;
const PLAYBACK_FREEZE_THRESHOLD_MS = 2500;
const PLAYBACK_RECOVERY_COOLDOWN_MS = 1800;
const CONTROL_DEDUPE_WINDOW_MS = 300;

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

function setTrackHelpText(element, message, tone = 'info') {
  if (!element) return;
  element.textContent = message;
  element.dataset.tone = tone;
}

function setTrackFieldVisibility(field, isVisible) {
  if (field) field.style.display = isVisible ? '' : 'none';
}

function resetSubtitlePickerState({ clearInput = true } = {}) {
  subtitlePicker?.classList.remove('loaded');
  if (subtitleFileLabel) subtitleFileLabel.textContent = 'Add your own local .srt or .vtt file';
  if (subtitleClearBtn) subtitleClearBtn.disabled = true;
  if (clearInput && subtitleInput) subtitleInput.value = '';
}

function setSubtitlePickerState(message, { loaded = false } = {}) {
  subtitlePicker?.classList.toggle('loaded', loaded);
  if (subtitleFileLabel) subtitleFileLabel.textContent = message;
  if (subtitleClearBtn) subtitleClearBtn.disabled = !loaded;
  if (subtitleInput) subtitleInput.value = '';
}

function revokeLocalSubtitleUrl() {
  if (!localSubtitleObjectUrl) return;
  URL.revokeObjectURL(localSubtitleObjectUrl);
  localSubtitleObjectUrl = null;
}

function detachLocalSubtitleTrack({ clearInput = true } = {}) {
  if (localSubtitleTrackEl?.track) localSubtitleTrackEl.track.mode = 'disabled';
  localSubtitleTrackEl?.remove();
  localSubtitleTrackEl = null;
  revokeLocalSubtitleUrl();
  localSubtitleFileName = null;
  resetSubtitlePickerState({ clearInput });
  queueTrackControlRefresh();
}

function convertSrtToVtt(srtText) {
  const normalized = String(srtText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '');
  const convertedTimestamps = normalized.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${convertedTimestamps.trim()}\n`;
}

async function attachLocalSubtitleFile(file) {
  if (!file) {
    detachLocalSubtitleTrack();
    return;
  }

  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['srt', 'vtt'].includes(extension || '')) {
    throw new Error('Only .srt and .vtt subtitles are supported right now.');
  }

  setSubtitlePickerState(`Preparing ${truncateFileName(file.name, 28)}…`);
  let subtitleText = await file.text();
  if (!subtitleText.trim()) {
    throw new Error('That subtitle file is empty.');
  }
  if (extension === 'srt') subtitleText = convertSrtToVtt(subtitleText);

  if (localSubtitleTrackEl?.track) localSubtitleTrackEl.track.mode = 'disabled';
  localSubtitleTrackEl?.remove();
  revokeLocalSubtitleUrl();

  const trackUrl = URL.createObjectURL(new Blob([subtitleText], { type: 'text/vtt' }));
  const trackEl = document.createElement('track');
  trackEl.kind = 'subtitles';
  trackEl.label = file.name.replace(/\.[^.]+$/, '');
  trackEl.srclang = 'und';
  trackEl.src = trackUrl;
  trackEl.default = true;
  movieVideo.appendChild(trackEl);

  localSubtitleTrackEl = trackEl;
  localSubtitleObjectUrl = trackUrl;
  localSubtitleFileName = file.name;
  setSubtitlePickerState(`${truncateFileName(file.name, 30)} ready only for you`, { loaded: true });
  setTrackHelpText(
    captionsHelp,
    movieVideo.src
      ? 'Local subtitle file loaded. It stays only on your device.'
      : 'Local subtitle file is ready. Load your movie to use it.',
    'ok'
  );
  queueTrackControlRefresh();

  window.setTimeout(() => {
    const tracks = getSelectableTextTracks();
    const selectedTrack =
      tracks.find((track) => track.label === trackEl.label) ||
      tracks[tracks.length - 1];
    if (!selectedTrack) return;
    tracks.forEach((track) => {
      track.mode = 'disabled';
    });
    selectedTrack.mode = 'showing';
    refreshCaptionOptions();
  }, 0);
}

function setSyncStatus(message, tone = 'idle') {
  const syncLabel = document.getElementById('sync-label');
  const syncDot = document.getElementById('sync-dot');
  if (syncLabel) syncLabel.textContent = message;
  if (syncDot) syncDot.className = `sdot ${tone}`;
}

function setSignalingState(nextState) {
  state.signalingState = nextState;
}

function setPresenceState(nextState) {
  state.presenceState = nextState;
  // peerPresent is derived: true when peer is either fully online OR in the
  // reconnect grace window ('unstable'). This keeps sync heartbeats and room
  // controls active during temporary disconnects without halting playback.
  peerPresent = nextState === 'online' || nextState === 'unstable';
}

function setCallState(nextState) {
  state.callState = nextState;
}

function setActiveScreen(screen) {
  if (!screenEls[screen]) return;
  if (uiState.activeScreen !== screen) commitInlineNameEdit();
  uiState.activeScreen = screen;
  Object.entries(screenEls).forEach(([key, element]) => {
    element?.classList.toggle('active', key === screen);
  });
  document.body.dataset.screen = screen;
  if (versionBadge) versionBadge.hidden = screen === 'watch';
}

function placeCaretAtEnd(element) {
  if (!element) return;
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertTextAtCursor(text) {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount) return;
  selection.deleteFromDocument();
  const range = selection.getRangeAt(0);
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function normalizeInlineEditableName(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 32);
}

function syncInlineNameEditorState() {
  if (!selfNameText || !selfNameEditBtn || !selfNameEditIcon) return;
  selfNameText.setAttribute('contenteditable', uiState.isEditingName ? 'true' : 'false');
  selfNameText.classList.toggle('is-editing', uiState.isEditingName);
  selfNameEditIcon.textContent = uiState.isEditingName ? 'check' : 'edit';
  selfNameEditBtn.setAttribute('aria-label', uiState.isEditingName ? 'Save display name' : 'Edit your display name');
  selfNameEditBtn.title = uiState.isEditingName ? 'Save display name' : 'Edit your display name';
}

function startInlineNameEdit() {
  if (!selfNameText || uiState.isEditingName) return;
  uiState.isEditingName = true;
  selfNameText.textContent = myName;
  selfNameText.style.minWidth = `${Math.max(72, Math.ceil(selfNameText.getBoundingClientRect().width))}px`;
  syncInlineNameEditorState();
  window.requestAnimationFrame(() => {
    selfNameText.focus({ preventScroll: true });
    placeCaretAtEnd(selfNameText);
  });
}

function commitInlineNameEdit({ revert = false } = {}) {
  if (!uiState.isEditingName) return myName;
  const fallbackName = myName;
  const nextName = revert
    ? fallbackName
    : (sanitizeDisplayName(selfNameText?.textContent) || fallbackName);
  uiState.isEditingName = false;
  if (selfNameText) {
    selfNameText.blur();
    selfNameText.style.minWidth = '';
  }
  syncInlineNameEditorState();
  if (revert) {
    renderLocalProfileUI();
    return fallbackName;
  }
  return applyLocalDisplayName(nextName);
}

function wireInlineNameEditor() {
  if (!selfNameText || !selfNameEditBtn) return;

  selfNameEditBtn.addEventListener('pointerdown', (event) => {
    if (uiState.isEditingName) event.preventDefault();
  });

  selfNameEditBtn.addEventListener('click', (event) => {
    event.preventDefault();
    if (uiState.isEditingName) {
      commitInlineNameEdit();
      return;
    }
    startInlineNameEdit();
  });

  selfNameText.addEventListener('keydown', (event) => {
    if (!uiState.isEditingName) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitInlineNameEdit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      commitInlineNameEdit({ revert: true });
    }
  });

  selfNameText.addEventListener('beforeinput', (event) => {
    if (!uiState.isEditingName) return;
    if (event.inputType === 'insertParagraph') event.preventDefault();
  });

  selfNameText.addEventListener('input', () => {
    if (!uiState.isEditingName || !selfNameText) return;
    const normalized = normalizeInlineEditableName(selfNameText.textContent);
    if (normalized === selfNameText.textContent) return;
    selfNameText.textContent = normalized;
    placeCaretAtEnd(selfNameText);
  });

  selfNameText.addEventListener('paste', (event) => {
    if (!uiState.isEditingName) return;
    event.preventDefault();
    insertTextAtCursor(normalizeInlineEditableName(event.clipboardData?.getData('text/plain') || ''));
  });

  selfNameText.addEventListener('blur', () => {
    if (!uiState.isEditingName) return;
    window.setTimeout(() => {
      if (!uiState.isEditingName) return;
      if (selfNameInline?.contains(document.activeElement)) return;
      commitInlineNameEdit();
    }, 0);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!uiState.isEditingName) return;
    if (selfNameInline?.contains(event.target)) return;
    commitInlineNameEdit();
  });

  syncInlineNameEditorState();
}

function renderLocalProfileUI() {
  const initials = getDisplayInitials(myName);
  if (yourAvatar) yourAvatar.textContent = initials;
  if (selfNameText && !uiState.isEditingName) selfNameText.textContent = myName;
  const countdownAvatar = document.getElementById('cd-av-you');
  if (countdownAvatar) countdownAvatar.textContent = initials;
  chat.setMyName(myName);
  syncInlineNameEditorState();
}

function rememberParticipantName(participantId, nextName) {
  const safeParticipantId = String(participantId || '').trim();
  const safeName = sanitizeDisplayName(nextName);
  if (!safeParticipantId || !safeName) return safeName;
  participantNames.set(safeParticipantId, safeName);
  chat.syncParticipantName(safeParticipantId, safeName);
  return safeName;
}

function resolveParticipantName(participantId, fallbackName = '') {
  const safeParticipantId = String(participantId || '').trim();
  if (safeParticipantId && safeParticipantId === client?.participantId) {
    return sanitizeDisplayName(myName) || 'You';
  }
  return sanitizeDisplayName(
    participantNames.get(safeParticipantId) ||
    fallbackName ||
    (safeParticipantId && safeParticipantId === remotePeerState.participantId ? remotePeerState.name : '') ||
    document.getElementById('friend-name')?.textContent?.trim() ||
    'Your friend'
  ) || 'Your friend';
}

function clearCameraUITimer() {
  if (!cameraUITimer) return;
  clearTimeout(cameraUITimer);
  cameraUITimer = null;
}

function applyRemoteCameraState() {
  const remoteCamOff = document.getElementById('remote-cam-off');
  const shouldShowCameraOff = !remotePeerState.isCameraOn || remoteVideoTrackHidden;
  if (remoteCamOff) remoteCamOff.style.display = shouldShowCameraOff ? 'flex' : 'none';
}

function renderRemoteMediaUI({ immediateCamera = false } = {}) {
  if (remoteMicBadge) {
    const showMuteBadge = !remotePeerState.isMicOn;
    remoteMicBadge.classList.toggle('active', showMuteBadge);
    remoteMicBadge.setAttribute('aria-hidden', showMuteBadge ? 'false' : 'true');
  }
  if (remoteNameChip) remoteNameChip.textContent = resolveParticipantName(remotePeerState.participantId, remotePeerState.name);
  if (remoteCamOffName) remoteCamOffName.textContent = resolveParticipantName(remotePeerState.participantId, remotePeerState.name);
  if (remoteCamOffAvatar) remoteCamOffAvatar.textContent = getDisplayInitials(resolveParticipantName(remotePeerState.participantId, remotePeerState.name));

  if (immediateCamera) {
    clearCameraUITimer();
    applyRemoteCameraState();
    return;
  }

  // Rapid camera toggles can bounce track state faster than the DOM settles.
  // Debouncing the avatar/video swap keeps the mini-view from flickering.
  clearCameraUITimer();
  cameraUITimer = window.setTimeout(() => {
    cameraUITimer = null;
    applyRemoteCameraState();
  }, 100);
}

function renderRemoteProfileUI({ immediateCamera = false } = {}) {
  const remoteName = resolveParticipantName(remotePeerState.participantId, remotePeerState.name);
  const friendNameEl = document.getElementById('friend-name');
  if (friendNameEl) {
    friendNameEl.textContent = remotePeerState.participantId
      ? remoteName
      : 'Waiting…';
  }
  if (friendAvatar) {
    friendAvatar.textContent = remotePeerState.participantId
      ? getDisplayInitials(remoteName)
      : '?';
  }
  const friendTag = document.querySelector('.pfriend');
  if (friendTag) {
    friendTag.textContent = remotePeerState.participantId
      ? `Friend • ${remoteName}`
      : 'Friend';
  }
  const countdownAvatar = document.getElementById('cd-av-them');
  if (countdownAvatar) {
    countdownAvatar.textContent = remotePeerState.participantId
      ? getDisplayInitials(remoteName)
      : '??';
  }
  renderRemoteMediaUI({ immediateCamera });
}

function updateRemotePeerState(nextState = {}) {
  const participantId = nextState.participantId || remotePeerState.participantId;
  const nextName = nextState.name != null
    ? (rememberParticipantName(participantId, nextState.name) || resolveParticipantName(participantId, nextState.name))
    : resolveParticipantName(participantId, remotePeerState.name);
  if (participantId) remotePeerState.participantId = participantId;
  remotePeerState.name = nextName || 'Your friend';
  if (typeof nextState.isCameraOn === 'boolean') remotePeerState.isCameraOn = nextState.isCameraOn;
  if (typeof nextState.isMicOn === 'boolean') remotePeerState.isMicOn = nextState.isMicOn;
  renderRemoteProfileUI();
}

function resetRemotePeerState() {
  clearCameraUITimer();
  remotePeerState.participantId = null;
  remotePeerState.name = 'Your friend';
  remotePeerState.isCameraOn = true;
  remotePeerState.isMicOn = true;
  remoteVideoTrackHidden = false;
  renderRemoteProfileUI({ immediateCamera: true });
}

function handleNameUpdate({
  participantId = null,
  name,
  isLocal = false,
  broadcast = false,
} = {}) {
  const fallbackName = isLocal ? myName : 'Your friend';
  const safeName = sanitizeDisplayName(name) || fallbackName;
  if (isLocal) {
    const previousName = myName;
    myName = persistDisplayName(safeName);
    renderLocalProfileUI();
    const localParticipantId = participantId || client?.participantId;
    if (localParticipantId) rememberParticipantName(localParticipantId, myName);
    if (broadcast && client && myName !== previousName) client.updateName(myName);
    return myName;
  }

  const remoteParticipantId = participantId || remotePeerState.participantId;
  const resolvedName = rememberParticipantName(remoteParticipantId, safeName) || resolveParticipantName(remoteParticipantId, safeName);
  updateRemotePeerState({
    participantId: remoteParticipantId,
    name: resolvedName,
  });
  return resolvedName;
}

function applyLocalDisplayName(nextName, { broadcast = true } = {}) {
  const normalizedName = sanitizeDisplayName(nextName) || myName;
  return handleNameUpdate({
    participantId: client?.participantId,
    name: normalizedName,
    isLocal: true,
    broadcast,
  });
}

function getOtherPeerSnapshot(peers = [], myPeerId = client?.peerId) {
  return peers.find((peer) => peer.peerId !== myPeerId) || null;
}

function canSendRoomControls() {
  return appState.signalingState === 'connected' && appState.presenceState === 'online';
}

function syncLocalMediaStateFromCall() {
  localMediaState.isMicOn = !!call?.hasAudio && !(call?.isMuted ?? false);
  localMediaState.isCameraOn = !!call?.hasVideo && !(call?.isCamOff ?? false);
}

function queueMediaSync(reason = 'unknown') {
  pendingMediaSyncReason = reason || pendingMediaSyncReason || 'unknown';
}

function handleMediaSync({
  participantId,
  isCameraOn,
  isMicOn,
  broadcast = false,
} = {}) {
  if (broadcast) {
    if (!client || !call) return false;
    syncLocalMediaStateFromCall();
    client.syncMediaState({
      participantId: client.participantId,
      isCameraOn: localMediaState.isCameraOn,
      isMicOn: localMediaState.isMicOn,
    });
    pendingMediaSyncReason = '';
    return true;
  }

  applyPeerMediaState({ participantId, isCameraOn, isMicOn });
  return true;
}

function flushQueuedMediaSync() {
  if (!pendingMediaSyncReason) return false;
  if (!client || !call) {
    pendingMediaSyncReason = '';
    return false;
  }
  return handleMediaSync({ broadcast: true });
}

function broadcastLocalMediaState(eventType = 'camera_toggle') {
  if (!client || !call) return;
  syncLocalMediaStateFromCall();
  const payload = {
    isCameraOn: localMediaState.isCameraOn,
    isMicOn: localMediaState.isMicOn,
  };
  if (eventType === 'mic_toggle') client.sendMicToggle(payload);
  else client.sendCameraToggle(payload);
}

function applyPeerMediaState({ participantId, isCameraOn, isMicOn } = {}) {
  if (participantId && remotePeerState.participantId && participantId !== remotePeerState.participantId) return;
  updateRemotePeerState({
    participantId: participantId || remotePeerState.participantId,
    name: resolveParticipantName(participantId || remotePeerState.participantId, remotePeerState.name),
    isCameraOn: typeof isCameraOn === 'boolean' ? isCameraOn : remotePeerState.isCameraOn,
    isMicOn: typeof isMicOn === 'boolean' ? isMicOn : remotePeerState.isMicOn,
  });
}

function clearReconnectTimeout() {
  if (!reconnectTimeout) return;
  clearTimeout(reconnectTimeout);
  reconnectTimeout = null;
}

function clearPresenceOfflineTimer() {
  clearReconnectTimeout();
}

function clearResumeCheckTimer() {
  if (!resumeCheckTimer) return;
  clearTimeout(resumeCheckTimer);
  resumeCheckTimer = null;
}

function clearResumeLock() {
  if (resumeLockTimer) {
    clearTimeout(resumeLockTimer);
    resumeLockTimer = null;
  }
  isResuming = false;
}

function getCurrentIceState() {
  return call?.iceState || lastIceConnectionState || 'new';
}

function isIceConnected(state = getCurrentIceState()) {
  return state === 'connected' || state === 'completed';
}

function isIceRecoveryState(state = getCurrentIceState()) {
  return state === 'failed' || state === 'disconnected' || state === 'checking';
}

function cancelPendingResumeIfRecovered(state = getCurrentIceState()) {
  if (!isIceConnected(state)) return false;
  clearResumeCheckTimer();
  clearResumeLock();
  return true;
}

function resetIceRecoveryState() {
  clearResumeCheckTimer();
  clearResumeLock();
  iceUnhealthySince = 0;
}

function markIceUnhealthy(state = getCurrentIceState()) {
  if (isIceConnected(state)) {
    iceUnhealthySince = 0;
    return;
  }
  if (!iceUnhealthySince) iceUnhealthySince = Date.now();
}

function getIceUnhealthyDurationMs(now = Date.now()) {
  if (!iceUnhealthySince) return 0;
  return Math.max(0, now - iceUnhealthySince);
}

function getRemainingIceDisconnectGraceMs(now = Date.now()) {
  return Math.max(0, RESUME_AFTER_ICE_DISCONNECT_DELAY_MS - getIceUnhealthyDurationMs(now));
}

function showReconnectingUI(message = 'Reconnecting…') {
  setSyncStatus(message, 'warn');
}

function hideReconnectingUI(message = 'Connected again') {
  setSyncStatus(message, 'ok');
}

function endCallForOffline({
  toastMessage = '',
  toastVariant = 'warn',
  statusMessage = 'Waiting for your friend to join',
} = {}) {
  const hadActiveCall = !!call || ['active', 'connecting'].includes(state.callState);
  clearReconnectTimeout();
  resetIceRecoveryState();
  if (toastMessage) showToast(toastMessage, toastVariant);
  call?.end();
  call = null;
  callStarting = false;
  callHasEverConnected = false;
  callConnectionAnnounced = false;
  lastIceConnectionState = 'new';
  setCallState(hadActiveCall ? 'ended' : 'idle');
  resetReadyState({ disable: true });
  setSyncStatus(statusMessage, 'idle');
}

function handlePeerOffline({
  name = getPeerDisplayName(),
  reason = 'left',
} = {}) {
  clearReconnectTimeout();

  const alreadyOffline = state.presenceState === 'offline' && !call && !callStarting;

  setPresenceState('offline');
  removePeerFromUI();
  updatePeerReadyState('friend', false);
  clearSyncPlaybackRate();
  readyBtn?.classList.remove('peer-wants-you');

  if (alreadyOffline) return;

  if (roomMode === 'youtube') {
    if (ytPlayer && ytPlayerReady) {
      ytPlayer.pauseVideo();
      ytIsPaused = true;
    }
  } else {
    movieVideo.pause();
  }

  const toastMessage = reason === 'reconnect_timeout'
    ? `${name || 'Your friend'} could not reconnect`
    : `${name || 'Your friend'} left the room`;

  endCallForOffline({
    toastMessage,
    toastVariant: reason === 'reconnect_timeout' ? 'warn' : 'info',
  });
}

function startReconnectTimeout({ name = getPeerDisplayName() } = {}) {
  // Re-arm the reconnect timeout from a clean slate so rapid reconnect cycles
  // cannot leave multiple offline timers running at once.
  clearReconnectTimeout();
  reconnectTimeout = window.setTimeout(() => {
    reconnectTimeout = null;
    if (state.presenceState === 'online') return;
    handlePeerOffline({ name, reason: 'reconnect_timeout' });
  }, PRESENCE_OFFLINE_TIMEOUT_MS);
}

function handleReconnect({ name = getPeerDisplayName() } = {}) {
  setPresenceState('unstable');
  showReconnectingUI(`${name || 'Your friend'} is reconnecting…`);
  startReconnectTimeout({ name });
}

function handleRecovery({
  message = 'Connected again',
  requestResume = true,
  delayMs = RESUME_AFTER_RECOVERY_DELAY_MS,
} = {}) {
  clearReconnectTimeout();
  setPresenceState('online');
  hideReconnectingUI(message);
  if (requestResume) maybeResumeCall({ reason: 'recovery', delayMs });
}

function maybeResumeCall({ reason = 'unknown', delayMs = 0 } = {}) {
  if (!call) return;
  if (isResuming) return;
  if (
    state.callState === 'active' &&
    state.signalingState === 'connected' &&
    state.presenceState === 'online' &&
    !isIceConnected(call.iceState)
  ) {
    isResuming = true;

    const runResume = () => {
      resumeCheckTimer = null;

      if (
        !call ||
        state.callState !== 'active' ||
        state.signalingState !== 'connected' ||
        state.presenceState !== 'online' ||
        isIceConnected(call.iceState)
      ) {
        isResuming = false;
        return;
      }

      showReconnectingUI('Re-establishing call…');
      Promise.resolve(call.requestOffer({ iceRestart: true })).catch((err) => {
        console.warn(`call resume failed (${reason}):`, err?.message || err);
      });

      if (resumeLockTimer) clearTimeout(resumeLockTimer);
      resumeLockTimer = window.setTimeout(() => {
        resumeLockTimer = null;
        isResuming = false;
      }, 3000);
    };

    clearResumeCheckTimer();
    if (delayMs > 0) {
      resumeCheckTimer = window.setTimeout(runResume, delayMs);
      return;
    }

    runResume();
  }
}

function handleCallIceState(iceState) {
  lastIceConnectionState = iceState || 'new';

  if (isIceConnected(iceState)) {
    const wasConnected = callHasEverConnected;
    callHasEverConnected = true;
    resetIceRecoveryState();
    if (state.callState !== 'ended') setCallState('active');
    if (state.presenceState === 'online' && state.signalingState === 'connected') {
      hideReconnectingUI(wasConnected ? 'Connected again' : 'Call connected');
    }
    return;
  }

  if (!call || state.callState !== 'active' || !callHasEverConnected) return;
  markIceUnhealthy(iceState);

  if (iceState === 'failed') {
    showReconnectingUI('Call reconnecting…');
    maybeResumeCall({ reason: 'ice-failed', delayMs: RESUME_AFTER_ICE_FAILED_DELAY_MS });
    return;
  }

  if (iceState === 'disconnected') {
    showReconnectingUI(
      state.presenceState === 'unstable'
        ? `${getPeerDisplayName()} is reconnecting…`
        : 'Call reconnecting…'
    );
    maybeResumeCall({
      reason: 'ice-disconnected',
      delayMs: getRemainingIceDisconnectGraceMs(),
    });
    return;
  }

  if (iceState === 'checking') {
    showReconnectingUI('Re-establishing call…');
    maybeResumeCall({
      reason: 'ice-checking',
      delayMs: getRemainingIceDisconnectGraceMs(),
    });
  }
}

function getVideoDurationSec() {
  if (roomMode === 'youtube') return (ytDuration > 0) ? ytDuration : null;
  return Number.isFinite(movieVideo.duration) ? movieVideo.duration : null;
}

function clampVideoPosition(positionSec) {
  const safePosition = Math.max(0, Number(positionSec) || 0);
  const durationSec = getVideoDurationSec();
  return durationSec == null ? safePosition : Math.min(safePosition, durationSec);
}

function isAtVideoEnd(positionSec = (roomMode === 'youtube' ? ytCurrentTime : movieVideo.currentTime)) {
  const durationSec = getVideoDurationSec();
  return durationSec != null && durationSec > 0 && positionSec >= durationSec - 0.25;
}

function getTrackEntries(trackList) {
  if (!trackList || typeof trackList.length !== 'number') return [];
  return Array.from({ length: trackList.length }, (_, index) => trackList[index]).filter(Boolean);
}

function getLanguageLabel(languageCode) {
  const code = String(languageCode || '').trim();
  if (!code || code.toLowerCase() === 'und') return '';
  const normalized = code.replace('_', '-');
  const baseCode = normalized.split('-')[0];

  try {
    if (typeof Intl?.DisplayNames === 'function') {
      const displayNames = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
      return displayNames.of(baseCode) || normalized.toUpperCase();
    }
  } catch { }

  return normalized.toUpperCase();
}

function getTrackLabel(track, index, fallbackPrefix) {
  const parts = [];
  const pushPart = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    if (parts.some((part) => part.toLowerCase() === text.toLowerCase())) return;
    parts.push(text);
  };

  pushPart(track?.label);
  pushPart(getLanguageLabel(track?.language));

  const kind = String(track?.kind || '').trim().toLowerCase();
  if (kind && !['main', 'subtitles', 'captions'].includes(kind)) {
    pushPart(kind);
  }

  if (!parts.length) pushPart(`${fallbackPrefix} ${index + 1}`);
  return parts.join(' · ');
}

function setSelectOptions(selectEl, options, { value = '', disabled = false } = {}) {
  if (!selectEl) return;

  selectEl.innerHTML = '';
  options.forEach((option) => {
    const el = document.createElement('option');
    el.value = String(option.value);
    el.textContent = option.label;
    selectEl.appendChild(el);
  });

  const optionValues = options.map((option) => String(option.value));
  selectEl.value = optionValues.includes(String(value)) ? String(value) : String(options[0]?.value ?? '');
  selectEl.disabled = disabled;
}

function resetTrackControls() {
  setSelectOptions(captionsSelect, [{ value: 'init', label: 'Load a movie first' }], { value: 'init', disabled: true });
  setSelectOptions(audioTrackSelect, [{ value: 'init', label: 'Load a movie first' }], { value: 'init', disabled: true });
  setTrackHelpText(captionsHelp, 'Load a movie, or add your own .srt/.vtt in the lobby.', 'info');
  setTrackHelpText(audioTrackHelp, 'Audio choice stays local to you. Browser support varies for embedded tracks.', 'info');
  setTrackFieldVisibility(captionsField, false);
  setTrackFieldVisibility(audioTrackField, false);
}

function setTrackControlsLoading() {
  setSelectOptions(captionsSelect, [{ value: 'loading', label: 'Reading caption tracks…' }], { value: 'loading', disabled: true });
  setSelectOptions(audioTrackSelect, [{ value: 'loading', label: 'Reading audio tracks…' }], { value: 'loading', disabled: true });
  setTrackHelpText(captionsHelp, 'Checking the movie and any local caption file you attached…', 'info');
  setTrackHelpText(audioTrackHelp, 'Checking what audio tracks the browser exposes for this movie…', 'info');
}

function getSelectableTextTracks() {
  return getTrackEntries(movieVideo.textTracks).filter((track) => !['metadata', 'chapters'].includes(track.kind));
}

function getSelectableAudioTracks() {
  return getTrackEntries(movieVideo.audioTracks);
}

function refreshCaptionOptions() {
  if (!movieVideo.src) {
    setSelectOptions(
      captionsSelect,
      [{ value: localSubtitleFileName ? 'pending' : 'init', label: localSubtitleFileName ? 'Caption file ready' : 'Load a movie first' }],
      { value: localSubtitleFileName ? 'pending' : 'init', disabled: true }
    );
    setTrackHelpText(
      captionsHelp,
      localSubtitleFileName
        ? 'Local subtitle file is ready. Load your movie to use it.'
        : 'Load a movie, or add your own .srt/.vtt in the lobby.',
      localSubtitleFileName ? 'ok' : 'info'
    );
    setTrackFieldVisibility(captionsField, !!localSubtitleFileName);
    return;
  }

  const tracks = getSelectableTextTracks();
  if (!tracks.length) {
    setSelectOptions(captionsSelect, [{ value: 'none', label: 'No captions available' }], { value: 'none', disabled: true });
    setTrackHelpText(
      captionsHelp,
      localSubtitleFileName
        ? 'Your local subtitle file is attached, but the browser has not exposed it yet. Re-add it as .vtt if needed.'
        : 'No embedded captions found. Add a local .srt/.vtt file in the lobby.',
      localSubtitleFileName ? 'warn' : 'info'
    );
    setTrackFieldVisibility(captionsField, !!localSubtitleFileName);
    return;
  }

  const selectedIndex = tracks.findIndex((track) => track.mode === 'showing');
  const options = [
    { value: 'off', label: 'Off' },
    ...tracks.map((track, index) => ({
      value: String(index),
      label: getTrackLabel(track, index, 'Caption'),
    })),
  ];

  setSelectOptions(captionsSelect, options, {
    value: selectedIndex >= 0 ? String(selectedIndex) : 'off',
    disabled: false,
  });
  setTrackHelpText(
    captionsHelp,
    localSubtitleFileName
      ? `Using local subtitles: ${truncateFileName(localSubtitleFileName, 28)}`
      : 'Embedded captions found. You can still add your own .srt/.vtt in the lobby.',
    localSubtitleFileName ? 'ok' : 'info'
  );
  setTrackFieldVisibility(captionsField, true);
}

function refreshAudioTrackOptions() {
  if (!movieVideo.src) {
    setSelectOptions(audioTrackSelect, [{ value: 'init', label: 'Load a movie first' }], { value: 'init', disabled: true });
    setTrackHelpText(audioTrackHelp, 'Audio choice stays local to you. Browser support varies for embedded tracks.', 'info');
    setTrackFieldVisibility(audioTrackField, false);
    return;
  }

  if (!movieVideo.audioTracks) {
    setSelectOptions(
      audioTrackSelect,
      [{ value: 'unsupported', label: 'Default audio only here' }],
      { value: 'unsupported', disabled: true }
    );
    setTrackHelpText(
      audioTrackHelp,
      'This browser can play the movie, but it cannot switch embedded audio tracks for this local file.',
      'warn'
    );
    setTrackFieldVisibility(audioTrackField, false);
    return;
  }

  const tracks = getSelectableAudioTracks();
  if (!tracks.length) {
    setSelectOptions(audioTrackSelect, [{ value: 'none', label: 'No switchable tracks found' }], { value: 'none', disabled: true });
    setTrackHelpText(audioTrackHelp, 'Only the default audio is available in this browser for this file.', 'warn');
    setTrackFieldVisibility(audioTrackField, false);
    return;
  }

  const selectedIndex = Math.max(tracks.findIndex((track) => track.enabled), 0);
  const options = tracks.map((track, index) => ({
    value: String(index),
    label: getTrackLabel(track, index, 'Audio'),
  }));

  setSelectOptions(audioTrackSelect, options, {
    value: String(selectedIndex),
    disabled: tracks.length < 2,
  });
  setTrackHelpText(
    audioTrackHelp,
    tracks.length < 2
      ? 'Only one exposed audio track was found. Audio choice stays local to you.'
      : 'Pick any available audio track. This choice stays local to you.',
    tracks.length < 2 ? 'info' : 'ok'
  );
  setTrackFieldVisibility(audioTrackField, true);
}

function refreshMediaTrackControls() {
  refreshCaptionOptions();
  refreshAudioTrackOptions();
}

function queueTrackControlRefresh() {
  if (trackRefreshFrame) cancelAnimationFrame(trackRefreshFrame);
  clearTimeout(trackRefreshTimeout);

  trackRefreshFrame = requestAnimationFrame(() => {
    trackRefreshFrame = null;
    refreshMediaTrackControls();
    trackRefreshTimeout = window.setTimeout(() => {
      refreshMediaTrackControls();
      trackRefreshTimeout = null;
    }, 250);
  });
}

function clearSyncPlaybackRate() {
  clearTimeout(syncPlaybackRateTimer);
  syncPlaybackRateTimer = null;
  if (roomMode !== 'youtube' && movieVideo.playbackRate !== 1) movieVideo.playbackRate = 1;
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

function rememberAuthoritativeSeek(positionSec, playing = !movieVideo.paused) {
  recentAuthoritativeSeek = {
    positionSec: clampVideoPosition(positionSec),
    playing,
    at: Date.now(),
  };
}

function getAuthoritativeSeekTarget() {
  if (!recentAuthoritativeSeek) return null;
  const ageMs = Date.now() - recentAuthoritativeSeek.at;
  if (ageMs > AUTHORITATIVE_SEEK_WINDOW_MS) {
    recentAuthoritativeSeek = null;
    return null;
  }
  const elapsedSec = recentAuthoritativeSeek.playing ? ageMs / 1000 : 0;
  return clampVideoPosition(recentAuthoritativeSeek.positionSec + elapsedSec);
}

function markPlaybackProgress({ rendered = false } = {}) {
  const now = Date.now();
  lastPlaybackProgressAt = now;
  if (rendered) lastRenderedFrameAt = now;
  freezeRecoveryCount = 0;
}

function armRenderedFrameWatcher() {
  if (roomMode === 'youtube') return;
  if (frameCallbackPending || typeof movieVideo.requestVideoFrameCallback !== 'function') return;
  if (!movieVideo.src) return;
  frameCallbackPending = true;
  movieVideo.requestVideoFrameCallback(() => {
    frameCallbackPending = false;
    markPlaybackProgress({ rendered: true });
    armRenderedFrameWatcher();
  });
}

function maybeShowSyncToast(message, driftSec) {
  if (driftSec < SYNC_TOAST_THRESHOLD_SEC) return;
  const now = Date.now();
  if (now < syncToastCooldownUntil) return;
  syncToastCooldownUntil = now + SYNC_TOAST_COOLDOWN_MS;
  showToast(message, 'info');
}

function isWatchScreenActive() {
  return document.getElementById('screen-watch')?.classList.contains('active') ?? false;
}

function shouldSendSyncHeartbeat() {
  const hasSource = roomMode === 'youtube' ? !!ytVideoId : !!movieVideo.src;
  return Boolean(
    client &&
    appState.signalingState === 'connected' &&
    appState.presenceState === 'online' &&
    hasSource &&
    isWatchScreenActive()
  );
}

function sendPlayPauseCommand(playing, positionSec) {
  const targetPos = clampVideoPosition(positionSec);
  const now = Date.now();
  if (
    lastSentPlayPauseCommand &&
    lastSentPlayPauseCommand.playing === playing &&
    Math.abs(lastSentPlayPauseCommand.positionSec - targetPos) < 0.05 &&
    now - lastSentPlayPauseCommand.at < CONTROL_DEDUPE_WINDOW_MS
  ) {
    return;
  }
  lastSentPlayPauseCommand = { playing, positionSec: targetPos, at: now };
  // Show local attribution toast so the user sees their own action confirmed
  showActionToast(playing ? '▶ You resumed' : '⏸ You paused');
  client?.playPause(playing, targetPos);
}

// Mark that the sync engine just applied a play or pause so that the
// resulting native event can be identified as an echo and suppressed.
function markSyncApplied(playing) {
  lastAppliedSyncState = { playing, at: Date.now() };
}

async function ensureMoviePlaying({ source = 'sync', showHint = false } = {}) {
  if (roomMode === 'youtube') {
    if (ytPlayer && ytPlayerReady) {
      markSyncApplied(true);
      ytPlayer.playVideo();
      ytIsPaused = false;
    }
    return true;
  }
  if (movieVideo.paused) {
    try {
      markSyncApplied(true);
      await movieVideo.play();
      playbackRetryPending = false;
      markPlaybackProgress();
      armRenderedFrameWatcher();
      return true;
    } catch (err) {
      playbackRetryPending = true;
      console.warn(`[Playback] play() failed during ${source}:`, err?.message || err);
      if (showHint) {
        showToast('Tap play if your browser paused the video', 'info');
      }
      return false;
    }
  }
  playbackRetryPending = false;
  markPlaybackProgress();
  armRenderedFrameWatcher();
  return true;
}

function nudgePlaybackToward(targetPos, driftSec, signedDrift) {
  if (roomMode === 'youtube') {
    // YouTube has no playbackRate API, so we can only hard-seek.
    // Only do it for significant drift (>= HARD threshold) to avoid
    // constantly seeking backward by small amounts while the server clock
    // catches up after a masterId change or brief position report lag.
    if (driftSec >= HARD_SYNC_THRESHOLD_SEC) applyHardSync({ targetPos, playing: true, announce: driftSec >= SYNC_TOAST_THRESHOLD_SEC, driftSec });
    return;
  }
  if (signedDrift > SOFT_SYNC_THRESHOLD_SEC) {
    movieVideo.playbackRate = FAST_CATCHUP_RATE;
    schedulePlaybackRateReset();
    return;
  }
  if (signedDrift < -SOFT_SYNC_THRESHOLD_SEC) {
    movieVideo.playbackRate = SLOW_CATCHUP_RATE;
    schedulePlaybackRateReset();
    const nudgedPos = clampVideoPosition(movieVideo.currentTime + Math.max(signedDrift * 0.12, -0.25));
    movieVideo.currentTime = nudgedPos;
    if (driftSec >= SYNC_TOAST_THRESHOLD_SEC) {
      maybeShowSyncToast(`Smoothing sync… (${driftSec.toFixed(1)}s drift)`, driftSec);
    }
    return;
  }
  clearSyncPlaybackRate();
}

function applyExplicitSeek(positionSec, { broadcast = true } = {}) {
  const targetPos = clampVideoPosition(positionSec);
  clearSyncPlaybackRate();
  if (roomMode === 'youtube') {
    ytPlayer?.seekTo(targetPos, true);
    ytCurrentTime = targetPos;
  } else {
    movieVideo.currentTime = targetPos;
    rememberAuthoritativeSeek(targetPos, !movieVideo.paused);
    markPlaybackProgress();
    armRenderedFrameWatcher();
  }
  if (broadcast) {
    showActionToast(`⏩ You skipped to ${formatDur(targetPos)}`);
    client?.seek(targetPos);
  }
}

window.handleExplicitSeekChange = (positionSec) => {
  applyExplicitSeek(positionSec);
};

function applyHardSync({ targetPos, playing, announce = false, driftSec = 0 }) {
  clearSyncPlaybackRate();
  if (roomMode === 'youtube') {
    ytPlayer?.seekTo(targetPos, true);
    ytCurrentTime = targetPos;
  } else {
    movieVideo.currentTime = targetPos;
    markPlaybackProgress();
    armRenderedFrameWatcher();
  }
  if (announce) {
    maybeShowSyncToast(`Resyncing… (${driftSec.toFixed(1)}s drift)`, driftSec);
  }
  const shouldPauseAtEnd = isAtVideoEnd(targetPos);
  if (playing && !shouldPauseAtEnd) {
    ensureMoviePlaying({ source: 'hard-sync', showHint: true });
  } else {
    markSyncApplied(false);
    if (roomMode === 'youtube') {
      if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') { ytPlayer.pauseVideo(); }
      ytIsPaused = true;
    } else {
      movieVideo.pause();
    }
  }
}

async function handleSyncCorrection({ positionSec, playing, serverTs, drift, source = 'sync' }) {
  const targetPos = getCompensatedSyncPosition(positionSec, playing, serverTs);
  const localPos = clampVideoPosition(roomMode === 'youtube' ? ytCurrentTime : movieVideo.currentTime);
  const signedDrift = targetPos - localPos;
  const driftSec = Math.abs(Number.isFinite(drift) ? drift : signedDrift);
  const shouldPauseAtEnd = isAtVideoEnd(targetPos);

  if (source === 'sync' && playing && targetPos < 0.5 && localPos > 5) {
    console.warn('[Sync] Ignoring suspicious reset-to-zero correction', { targetPos, localPos, driftSec });
    return;
  }

  if (source === 'sync') {
    const authoritativeSeekTarget = getAuthoritativeSeekTarget();
    if (
      authoritativeSeekTarget != null &&
      Math.abs(targetPos - authoritativeSeekTarget) > AUTHORITATIVE_SEEK_TOLERANCE_SEC
    ) {
      console.warn('[Sync] Ignoring stale correction after explicit seek', {
        targetPos,
        authoritativeSeekTarget,
        driftSec,
      });
      return;
    }
  }

  if (!playing) {
    clearSyncPlaybackRate();
    if (Math.abs(signedDrift) > 0.15) {
      if (roomMode === 'youtube') { ytPlayer?.seekTo(targetPos, true); ytCurrentTime = targetPos; }
      else movieVideo.currentTime = targetPos;
    }
    const isPaused = roomMode === 'youtube' ? ytIsPaused : movieVideo.paused;
    if (!isPaused) {
      markSyncApplied(false);
      if (roomMode === 'youtube') {
        if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') { ytPlayer.pauseVideo(); }
        ytIsPaused = true;
      } else {
        movieVideo.pause();
      }
    }
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

  if (roomMode !== 'youtube' && movieVideo.seeking) return;

  if (driftSec >= HARD_SYNC_THRESHOLD_SEC) {
    applyHardSync({ targetPos, playing: true, announce: true, driftSec });
    return;
  }

  if (roomMode === 'youtube' ? ytIsPaused : movieVideo.paused) {
    await ensureMoviePlaying({ source: 'sync-resume', showHint: true });
    return;
  }

  if (driftSec < SOFT_SYNC_THRESHOLD_SEC) {
    clearSyncPlaybackRate();
    return;
  }

  nudgePlaybackToward(targetPos, driftSec, signedDrift);
}

function leaveWatchToLobby({ clearFile = false, keepCall = true, notice = '' } = {}) {
  clearSyncPlaybackRate();
  if (roomMode === 'youtube') {
    // Guard with typeof checks — if the player was torn down mid-init the
    // YT.Player stub exists but its methods aren't real yet, which threw
    // "pauseVideo is not a function". typeof guards are safer than ytPlayerReady alone.
    if (ytPlayer && ytPlayerReady && typeof ytPlayer.pauseVideo === 'function') {
      ytPlayer.pauseVideo();
      ytPlayer.seekTo(0, true);
    }
    ytIsPaused = true; ytCurrentTime = 0;
  } else {
    movieVideo.pause();
    movieVideo.currentTime = 0;
  }
  if (clearFile) {
    if (roomMode === 'youtube') {
      clearYtVideoSelection();
    } else {
      movieVideo.removeAttribute('src');
      movieVideo.load();
      myFileName = null;
      if (fileInput) fileInput.value = '';
      clearOwnFileSelection();
      detachLocalSubtitleTrack();
      resetTrackControls();
    }
  }
  if (!keepCall) {
    resetIceRecoveryState();
    call?.end();
    call = null;
    callHasEverConnected = false;
    callConnectionAnnounced = false;
    lastIceConnectionState = 'new';
    showCallUI(false);
    setCallState('idle');
  } else if (call) {
    showCallUI(true);
  }
  showLobby(roomCode);
  resetReadyState({ disable: true });
  client?.setReady(false);
  setSyncStatus(notice || (clearFile ? 'Pick your video file to check for sync' : 'Your friend is choosing a different file.'), clearFile ? 'idle' : 'warn');
}

function getPeerDisplayName() {
  return resolveParticipantName(remotePeerState.participantId, remotePeerState.name);
}

async function ensureVideoCall({ force = false } = {}) {
  if (!client || call || callStarting) return call;
  if (!force && appState.presenceState !== 'online') return null;
  callStarting = true;
  setCallState('connecting');
  try {
    return await startVideoCall();
  } catch (err) {
    setCallState('ended');
    throw err;
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
  setActiveScreen('landing');
}

function resetToLanding(message = '') {
  roomCode = null;
  isHost = false;
  commitInlineNameEdit({ revert: true });
  clearPresenceOfflineTimer();
  resetIceRecoveryState();
  clearCameraUITimer();
  participantNames.clear();
  pendingMediaSyncReason = '';
  lastSeekAt = 0;
  callHasEverConnected = false;
  callConnectionAnnounced = false;
  lastIceConnectionState = 'new';
  setPresenceState('offline');
  setSignalingState('disconnected');
  setCallState('idle');
  resetRemotePeerState();
  myFileName = null;
  client = null;
  call = null;
  callStarting = false;
  chat.setMyParticipantId(null);
  roomCodeInput.value = '';
  window.history.replaceState({}, '', '/');
  showLandingScreen();
  if (message) showLandingNotice(message);
}

function leaveRoomAndGoHome(message = '') {
  clearSyncPlaybackRate();
  commitInlineNameEdit({ revert: true });
  clearPresenceOfflineTimer();
  resetIceRecoveryState();
  clearCameraUITimer();
  pendingMediaSyncReason = '';
  // Stop the playback health watchdog — it must not keep firing after we leave
  if (playbackHealthTimer) { clearInterval(playbackHealthTimer); playbackHealthTimer = null; }
  // Clear chat log and close panel — fresh state for next session
  chat.reset();
  if (roomMode === 'youtube') {
    console.log("YOutube player cleanup executing..")
    if (ytPlayer && ytPlayerReady && typeof ytPlayer.pauseVideo === 'function') { ytPlayer.pauseVideo(); ytPlayer.seekTo(0, true); }
    ytIsPaused = true; ytCurrentTime = 0;
    clearYtVideoSelection();
    stopYtPolling();
    setRoomModeUI('local', false);
  } else {
    movieVideo.pause();
    movieVideo.currentTime = 0;
    movieVideo.removeAttribute('src');
    movieVideo.load();
    if (fileInput) fileInput.value = '';
    clearOwnFileSelection();
    detachLocalSubtitleTrack();
    resetTrackControls();
  }
  resetReadyState({ disable: true });
  setSyncStatus('Pick your video file to check for sync', 'idle');
  call?.end();
  call = null;
  callStarting = false;
  callHasEverConnected = false;
  callConnectionAnnounced = false;
  lastIceConnectionState = 'new';
  setCallState('idle');
  setPresenceState('offline');
  setSignalingState('disconnected');
  showCallUI(false);
  client?.disconnect();
  // Reset wiring flag so controls re-register correctly if user creates a new room
  videoControlsWired = false;
  reactionsWired = false;
  ytLobbyWired = false;
  lastAppliedSyncState = null;
  lastSentPlayPauseCommand = null;
  resetToLanding(message);
}

function shouldMonitorPlaybackFreeze() {
  return Boolean(
    movieVideo.src &&
    !document.hidden &&
    !movieVideo.paused &&
    !movieVideo.seeking &&
    !movieVideo.ended &&
    !isAtVideoEnd() &&
    movieVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  );
}

async function recoverFrozenPlayback(reason = 'watchdog') {
  const now = Date.now();
  if (now - lastFreezeRecoveryAt < PLAYBACK_RECOVERY_COOLDOWN_MS) return;
  lastFreezeRecoveryAt = now;
  freezeRecoveryCount += 1;

  const targetPos = clampVideoPosition(movieVideo.currentTime);
  clearSyncPlaybackRate();

  // Stamp sync-applied so the pause/play events from decoder nudge don't
  // get broadcast to the peer — this is purely a local decoder recovery.
  markSyncApplied(false); // pause stamp
  // Nudge the decoder and then request the authoritative position immediately.
  try {
    movieVideo.currentTime = clampVideoPosition(targetPos + 0.001);
    movieVideo.currentTime = targetPos;
  } catch { }

  movieVideo.pause();
  markSyncApplied(true); // play stamp for the ensureMoviePlaying call below
  await ensureMoviePlaying({ source: reason, showHint: freezeRecoveryCount > 1 });
  client?.requestSyncCheck?.(targetPos);
  markPlaybackProgress();
  armRenderedFrameWatcher();
}

function checkPlaybackHealth() {
  if (roomMode === 'youtube') return; // YouTube manages its own buffering
  if (!shouldMonitorPlaybackFreeze()) return;

  const activityAt =
    typeof movieVideo.requestVideoFrameCallback === 'function' && lastRenderedFrameAt > 0
      ? lastRenderedFrameAt
      : lastPlaybackProgressAt;

  if (!activityAt) {
    markPlaybackProgress();
    armRenderedFrameWatcher();
    return;
  }

  if (Date.now() - activityAt < PLAYBACK_FREEZE_THRESHOLD_MS) return;
  recoverFrozenPlayback('freeze-watchdog').catch((err) => {
    console.warn('freeze recovery failed:', err?.message || err);
  });
}

wireInlineNameEditor();
renderLocalProfileUI();
renderRemoteProfileUI();
setActiveScreen(
  screenEls.watch?.classList.contains('active')
    ? 'watch'
    : screenEls.lobby?.classList.contains('active')
      ? 'lobby'
      : 'landing'
);

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
    isHost = true;

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
  if (!code) return showLandingNotice('Please enter a room code first.');

  try {
    // Validate the room exists before connecting
    const res = await fetch(`${SERVER_ORIGIN}/api/rooms/${code}`);
    if (!res.ok) return showLandingNotice('Room not found or is already full.');

    roomCode = code;
    isHost = false;

    showLobby(roomCode);
    await connectAndJoin();
  } catch (err) {
    console.error('Join room failed:', err);
    showLandingNotice('Could not reach the server. Please try again.');
  }
});

async function connectAndJoin() {
  client = new WatchTogetherClient(SERVER_URL, BACKEND_BASE_URL);
  await client.connect();
  setSignalingState('connected');
  participantNames.clear();
  rememberParticipantName(client.participantId, myName);

  // Give chat the connected client and updated name, then mount the DOM
  chat.setMyName(myName);
  chat.setMyParticipantId(client.participantId);
  chat.wireClient(client);
  chat.mount(); // idempotent — only builds DOM once

  // Wire up all event listeners
  wireClientEvents();
  wireVideoControls();
  wireReactions();
  wireYouTubeLobby();
  client.join({ roomCode, name: myName, isHost });
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
  client.on('signaling_state', ({ state: s, resumed = false }) => {
    setSignalingState(s);
    if (s === 'reconnecting') {
      setSyncStatus('Connection lost — reconnecting…', 'warn');
      return;
    }
    if (s === 'disconnected' && roomCode) {
      setSyncStatus('Disconnected from room', 'warn');
      return;
    }
    if (s === 'connected' && resumed) {
      queueMediaSync('signaling-restored');
      if (appState.presenceState === 'online') setSyncStatus('Connected again', 'ok');
      else if (appState.presenceState === 'unstable') setSyncStatus('Connected — waiting for your friend', 'warn');
      else setSyncStatus('Waiting for your friend to join', 'idle');
    }
  });

  client.on('joined', (data) => {
    console.log('Joined room', data.roomCode, 'as', data.yourPeerId);
    rememberParticipantName(client?.participantId, myName);
    chat.setMyParticipantId(client?.participantId || null);
    data.peers.forEach((peer) => {
      rememberParticipantName(peer.participantId || peer.peerId, peer.name);
    });
    const otherPeer = getOtherPeerSnapshot(data.peers, data.yourPeerId);
    if (otherPeer) {
      addPeerToUI(otherPeer);
      ensureVideoCall({force: true}); // this one will trigger and ensure video call once someone joins the room.
      if (otherPeer.connectionState === 'reconnecting') {
        handleReconnect({ name: otherPeer.name });
      } else {
        clearReconnectTimeout();
        setPresenceState('online');
      }
      updatePeerReadyState(otherPeer.peerId, !!otherPeer.isReady);
      if (otherPeer.fileDuration) {
        updatePeerFileStatus(otherPeer.peerId, otherPeer.fileDuration, otherPeer.fileName);
      }
    } else {
      clearReconnectTimeout();
      setPresenceState('offline');
      removePeerFromUI();
      updatePeerReadyState('friend', false);
    }

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
    // Restore YouTube mode only if BOTH peers are already in the room.
    // If we are the first peer (solo join or fresh room), never auto-load
    // someone else's YouTube state — this prevents cross-room leakage where
    // a stale room snapshot from a previously-active room restores the wrong
    // video when a new user joins an empty-but-not-yet-GC'd room slot.
    if (data.roomMode === 'youtube' && otherPeer) {
      setRoomModeUI('youtube', false);
      if (data.youtubeVideoId) {
        const ytInput = document.getElementById('yt-url-input');
        if (ytInput) ytInput.value = `https://www.youtube.com/watch?v=${data.youtubeVideoId}`;
        document.getElementById('yt-clear-btn')?.classList.add('show');
        processYtUrl(data.youtubeVideoId).catch(console.warn);
      }
    }
    flushQueuedMediaSync();
  });

  client.on('rejoined', () => {
    if (appState.presenceState === 'online') hideReconnectingUI('Connected again');
    flushQueuedMediaSync();
    maybeResumeCall({ reason: 'self-rejoined', delayMs: RESUME_AFTER_RECOVERY_DELAY_MS });
  });

  client.on('peer_joined', (data) => {
    if (state.presenceState !== 'offline') {
      console.warn('[Guard] Ignoring peer_joined during active session');
      return;
    }
    clearReconnectTimeout();
    setPresenceState('online');
    addPeerToUI(data);
    updatePeerReadyState(data.peerId, false);
    hideReconnectingUI(`${data.name} joined the room`);
    showToast(`${data.name} joined the room 🎉`);
    ensureVideoCall(); // trigger video call when peer joined
  });

  client.on('peer_reconnecting', ({ name }) => {
    handleReconnect({ name: name || getPeerDisplayName() });
  });

  client.on('peer_reconnected', (data) => {
    addPeerToUI(data);
    handleRecovery({
      message: 'Connected again',
      requestResume: true,
      delayMs: RESUME_AFTER_RECOVERY_DELAY_MS,
    });
    queueMediaSync('peer-reconnected');
    flushQueuedMediaSync();
  });

  client.on('peer_name_updated', ({ participantId, name }) => {
    handleNameUpdate({
      participantId: participantId || remotePeerState.participantId,
      name: name || remotePeerState.name,
    });
  });

  client.on('camera_toggle', (payload) => handleMediaSync(payload));
  client.on('mic_toggle', (payload) => handleMediaSync(payload));
  client.on('sync_media_state', (payload) => handleMediaSync(payload));

  client.on('peer_left', (data) => {
    handlePeerOffline({
      name: data.name || getPeerDisplayName(),
      reason: data.reason || 'left',
    });
  });

  // ── File loading ─────────────────────────────────────────────────────────
  client.on('peer_file_ready', (data) => {
    if (roomMode === 'youtube') {
      // In YouTube mode peer_file_ready means friend loaded the shared video
      const durEl = document.getElementById('friend-yt-dur');
      if (durEl && data.durationSec) durEl.textContent = formatDur(data.durationSec);
    } else {
      updatePeerFileStatus(data.peerId, data.durationSec, data.fileName);
      resetReadyState({ disable: true });
      setSyncStatus(`${getPeerDisplayName()} changed their file. Re-check sync before starting.`, 'warn');
      const fileLabel = data.fileName ? ` "${data.fileName}"` : '';
      showToast(`${getPeerDisplayName()} picked a different file${fileLabel}`, 'info');
    }
  });

  client.on('duration_check', ({ match, diff }) => {
    if (match) {
      const msg = roomMode === 'youtube' ? 'Same video confirmed ✓ — ready to watch together' : 'Files match ✓ — same movie confirmed';
      showToast(msg, 'success');
      if (readyBtn) readyBtn.disabled = false;
      setSyncStatus(roomMode === 'youtube' ? 'Video matched. Both of you can get ready.' : 'Files match. Both of you can get ready.', 'ok');
    } else {
      showToast(`Duration mismatch: ${diff.toFixed(1)}s difference — check your files`, 'warn');
      setSyncStatus(`Duration mismatch: ${diff.toFixed(1)}s difference — check your files`, 'warn');
    }
  });

  // ── Lobby ready ──────────────────────────────────────────────────────────
  client.on('peer_ready', ({ peerId, isReady }) => {
    // The server now excludes the sender from peer_ready broadcasts, so this
    // event always comes from the OTHER peer. The guard below is kept as a
    // safety net in case of any edge-case reconnect replays, but under normal
    // operation it will never fire.
    if (peerId === client.peerId) return;
    updatePeerReadyState(peerId, isReady);
    const peerName = getPeerDisplayName();
    if (isReady) {
      // Friend clicked ready — nudge local user with a toast + button pulse
      showToast(`${peerName} is ready — are you? 🍿`, 'success');
      if (readyBtn && readyBtn.dataset.ready !== 'true' && !readyBtn.disabled) {
        readyBtn.classList.add('peer-wants-you');
      }
    } else {
      // Friend un-readied — stop the pulse
      readyBtn?.classList.remove('peer-wants-you');
    }
  });

  client.on('countdown_start', async ({ positionSec, serverTs }) => {
    // Compute how many countdown seconds remain based on when server fired this.
    // Peers receive it at slightly different times; startFrom corrects for that so
    // both enter the watch screen at the same real-world moment.
    const elapsedSec = serverTs ? Math.max(0, (Date.now() - serverTs) / 1000) : 0;
    const startFrom = Math.max(1, 3 - elapsedSec);



    // Seek to start position. For YouTube we must wait for the player to be
    // ready before calling seekTo — if the receiver's background init is still
    // in-flight, awaiting the mutex promise here ensures we don't call methods
    // on a partially-constructed YT.Player object (which threw the
    // "seekTo is not a function" error).
    if (roomMode === 'youtube') {
      // Wait for any in-progress player init to finish (non-blocking if already done)
      if (ytPlayerInitPromise) {
        try { await ytPlayerInitPromise; } catch {/* init errors are handled inside */ }
      }
      if (ytPlayer && ytPlayerReady) {
        // Use allowSeekAhead=false so the IFrame doesn't start buffering/playing
        // audio while the countdown overlay is showing. A seekTo with
        // allowSeekAhead=true can trigger the player to start playing audio
        // even with autoplay:0, because the player treats it as a user action.
        ytPlayer.seekTo(positionSec, false);
        // Immediately pause to silence any audio that started during seek.
        if (typeof ytPlayer.pauseVideo === 'function') ytPlayer.pauseVideo();
      }
      ytIsPaused = true;
      ytCurrentTime = positionSec;
    } else {
      movieVideo.currentTime = positionSec;
    }

    startCountdown(() => {
      showWatchScreen();
      showCallUI(!!call);
      // Autoplay is intentionally disabled — both peers land on the watch
      // screen paused at position 0. Either peer can press play to start,
      // and the play_pause sync command will bring the other peer along.
      if (roomMode === 'youtube') {
        // Double-ensure paused when entering watch screen — the IFrame may have
        // resumed during countdown.
        if (ytPlayer && ytPlayerReady && typeof ytPlayer.pauseVideo === 'function') {
          ytPlayer.pauseVideo();
        }
        ytIsPaused = true;
      } else {
        movieVideo.pause();
      }
    }, startFrom);
  });

  client.on('return_to_lobby', ({ name }) => {
    leaveWatchToLobby({
      clearFile: false,
      keepCall: true,
      notice: roomMode === 'youtube'
        ? `${name || getPeerDisplayName()} went back to change the video.`
        : `${name || getPeerDisplayName()} went back to pick a different file.`,
    });
    showToast(`${name || getPeerDisplayName()} went back to ${roomMode === 'youtube' ? 'change video' : 'file selection'}`, 'info');
  });

  // ── YouTube room-level events ──────────────────────────────────────────
  client.on('peer_mode_change', ({ peerId, name, mode }) => {
    // If this echo is our own action (sender already applied the mode), just update
    // the friend card UI and return — don't re-broadcast or reset ready state twice.
    const isMine = peerId === client.peerId;
    if (isMine) {
      // Friend card should reflect the mode the OTHER peer will now be in.
      // Since we just switched, show the friend's card as "waiting" for their side.
      updateFriendCardForMode(mode);
      return;
    }

    // Peer-initiated mode change — auto-switch our UI to match
    if (mode !== roomMode) {
      setRoomModeUI(mode, false);
    }
    updateFriendCardForMode(mode);
    resetReadyState({ disable: true });

    if (mode === 'youtube') {
      clearYtVideoSelection();
      const msg = `${name || 'Your friend'} switched to YouTube mode`;
      showToast(msg, 'info');
      setSyncStatus(`📺 ${name || 'Your friend'} switched to YouTube — paste a link to start`, 'idle');
    } else {
      const msg = `${name || 'Your friend'} switched to local file mode`;
      showToast(msg, 'info');
      setSyncStatus(`📁 ${name || 'Your friend'} switched to local file — pick your video`, 'idle');
    }
  });

  client.on('peer_youtube_link', async ({ fromPeerId, videoId, title, duration }) => {
    if (!videoId) return;
    const isMine = fromPeerId === client.peerId;
    updateFriendYtPreview(videoId, title); //update friend card for the latest video thumbail before checking ismine

    // The sender already handled their own UI in processYtUrl — skip to avoid double work
    if (isMine) return;

    // Auto-switch to YouTube mode if we're not already there (no re-broadcast)
    if (roomMode !== 'youtube') setRoomModeUI('youtube', false);

    // Populate the input field so the receiver can see + optionally change the link
    const ytInput = document.getElementById('yt-url-input');
    if (ytInput) ytInput.value = `https://www.youtube.com/watch?v=${videoId}`;
    document.getElementById('yt-clear-btn')?.classList.add('show');

    // Show friend's video in the friend card preview
    updateFriendYtPreview(videoId, title);

    // Show own preview card immediately using thumbnail URL (no oEmbed needed)
    const prevEl = document.getElementById('yt-preview');
    const thumbEl = document.getElementById('yt-thumb');
    const titleEl = document.getElementById('yt-title');
    const durEl = document.getElementById('yt-dur');
    if (thumbEl) thumbEl.src = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    if (titleEl) titleEl.textContent = title || 'YouTube Video';
    if (durEl && duration > 0) durEl.textContent = formatDur(duration);
    prevEl?.classList.add('show');

    // Store state — player will be initialized at countdown/watch-screen time
    ytVideoId = videoId;
    ytDuration = duration || ytDuration || 0;
    ytCurrentTime = 0;

    showToast(`${getPeerDisplayName()} shared: ${title || videoId}`, 'info');
    setSyncStatus(`Loading video — ready to watch together 🍿`, 'idle');

    // Report our duration to the server exactly ONCE using whatever we have.
    // The sender always passes their confirmed duration in the broadcast, so
    // use that immediately — it's the ground truth. Do NOT re-report after
    // player init; that second call was causing a race where the player briefly
    // reports a different duration before settling, producing a false mismatch.
    if (ytDuration > 0) {
      client?.fileReady(ytDuration, title || videoId, true);    // hasvideo = true for yt video
    }

    // Kick off background player init so it's warm when the watch screen opens.
    // Errors are silent here — the sender surfaces them on their own screen.
    loadYouTubeAPI()
      .then(() => initYtPlayer(videoId))
      .then(() => {
        // Init succeeded. Duration already reported above — don't call fileReady again.
        setSyncStatus('Video loaded — mark ready when set 🍿', 'ok');
      })
      .catch(err => {
        // Background init failed (e.g. embedding disabled). Stay silent — this
        // error will be shown to the sender by their own processYtUrl catch block.
        console.warn('[YT] receiver background init failed (silent):', err.message);
        // Clear our state so we don't show a stale preview or enable ready.
        ytVideoId = null;
        const prevEl = document.getElementById('yt-preview');
        prevEl?.classList.remove('show');
        setSyncStatus('This video cannot be played — ask your friend to try a different one.', 'warn');
        showToast('This video cannot be embedded. Ask your friend to try a different one.', 'warn');
      });
  });

  // ── Playback sync ────────────────────────────────────────────────────────

  // A play/pause command relayed from the master peer
  client.on('play_pause', async ({ playing, positionSec, serverTs }) => {
    // Show attribution so the receiver knows their friend did this (not a glitch)
    showActionToast(playing
      ? `▶ ${getPeerDisplayName()} resumed`
      : `⏸ ${getPeerDisplayName()} paused`);
    // We don't pre-stamp here anymore — markSyncApplied() is now called from
    // inside ensureMoviePlaying() and applyHardSync() at the exact moment the
    // media element is told to play/pause, giving a precise echo window.
    try {
      await handleSyncCorrection({ positionSec, playing, serverTs, source: 'command' });
    } catch (e) {
      console.warn('play() blocked by browser autoplay policy:', e.message);
    }
  });

  // A seek command from the master peer
  client.on('seek', ({ positionSec }) => {
    showActionToast(`⏩ ${getPeerDisplayName()} skipped to ${formatDur(positionSec)}`);
    applyExplicitSeek(positionSec, { broadcast: false });
  });

  client.on('sync_nudge', async ({ positionSec, playing, serverTs, drift }) => {
    // Same as play_pause — markSyncApplied is called inside the apply functions.
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

  // ── Fatal server errors ───────────────────────────────────────────────
  // Room full / not found after a reconnect means the room was destroyed
  // while we were offline (Render free tier killed the backend). Boot the
  // user back to the landing screen with a clear explanation.
  client.on('error', ({ message }) => {
    if (message === 'Room full' || message === 'Room not found') {
      // Small delay so the WS close event fires and _shouldReconnect is
      // already false before we tear down app state.
      setTimeout(() => {
        leaveRoomAndGoHome(
          message === 'Room full'
            ? 'The room is full. Your session may have expired — create a new room.'
            : 'The room has expired. Please create a new room and share the link again.'
        );
      }, 300);
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. VIDEO FILE CONTROLS (play / pause / seek)
// ═════════════════════════════════════════════════════════════════════════════

function wireVideoControls() {
  client.setPositionGetter(() => {
    if (!shouldSendSyncHeartbeat()) return null;
    return clampVideoPosition(roomMode === 'youtube' ? ytCurrentTime : movieVideo.currentTime);
  });
  if (videoControlsWired) return;
  videoControlsWired = true;
  playbackHealthTimer = window.setInterval(checkPlaybackHealth, 1000);
  resetSubtitlePickerState({ clearInput: false });
  resetTrackControls();

  // File picker → load into <video> and tell server
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const isNewSelection = myFileName && myFileName !== file.name;
    if (isNewSelection) detachLocalSubtitleTrack();
    myFileName = file.name;
    resetReadyState({ disable: true });
    client?.setReady(false);
    setSyncStatus('Checking your new file against your friend\'s copy…', 'idle');
    setTrackControlsLoading();
    movieVideo.src = URL.createObjectURL(file);
    movieVideo.addEventListener('loadedmetadata', () => {
      markPlaybackProgress();
      armRenderedFrameWatcher();
      queueTrackControlRefresh();
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

  subtitleInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await attachLocalSubtitleFile(file);
      showToast('Local captions added just for you', 'success');
    } catch (err) {
      console.warn('subtitle load failed:', err?.message || err);
      detachLocalSubtitleTrack();
      showToast(err?.message || 'Could not read that subtitle file', 'warn');
    }
  });

  subtitleClearBtn?.addEventListener('click', () => {
    if (!localSubtitleFileName) return;
    detachLocalSubtitleTrack();
    showToast('Local captions removed', 'info');
  });

  // ── Play / Pause ─────────────────────────────────────────────────────────
  playPauseBtn?.addEventListener('click', () => {
    const nowPlaying = roomMode === 'youtube' ? !ytIsPaused : !movieVideo.paused;
    const pos = roomMode === 'youtube' ? ytCurrentTime : movieVideo.currentTime;
    clearSyncPlaybackRate();
    if (nowPlaying) {
      if (roomMode === 'youtube') { ytPlayer?.pauseVideo(); ytIsPaused = true; }
      else movieVideo.pause();
    } else {
      ensureMoviePlaying({ source: 'local-control', showHint: true });
    }
    sendPlayPauseCommand(!nowPlaying, pos);
  });

  // Keyboard shortcut: space bar
  document.addEventListener('keydown', (e) => {
    const activeTag = document.activeElement?.tagName;
    if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(activeTag)) {
      e.preventDefault();
      playPauseBtn?.click();
    }
  });

  captionsSelect?.addEventListener('change', () => {
    const selectedValue = captionsSelect.value;
    const tracks = getSelectableTextTracks();
    tracks.forEach((track) => {
      track.mode = 'disabled';
    });

    if (selectedValue !== 'off') {
      const selectedTrack = tracks[Number(selectedValue)];
      if (selectedTrack) selectedTrack.mode = 'showing';
    }

    refreshCaptionOptions();
  });

  audioTrackSelect?.addEventListener('change', () => {
    const tracks = getSelectableAudioTracks();
    const selectedIndex = Number(audioTrackSelect.value);
    tracks.forEach((track, index) => {
      track.enabled = index === selectedIndex;
    });
    refreshAudioTrackOptions();
  });

  // ── Seek bar ─────────────────────────────────────────────────────────────
  // isSeeking is now module-level (declared at top)
  let lastCommittedSeekValue = null;
  let lastCommittedSeekAt = 0;

  const commitSeekBarChange = () => {
    if (!seekBar) return;
    const targetPos = clampVideoPosition(Number(seekBar.value));
    const now = Date.now();
    isSeeking = false; window._isSeeking = false;
    if (
      lastCommittedSeekValue != null &&
      Math.abs(targetPos - lastCommittedSeekValue) < 0.01 &&
      now - lastCommittedSeekAt < 300
    ) {
      return;
    }
    lastCommittedSeekValue = targetPos;
    lastCommittedSeekAt = now;
    applyExplicitSeek(targetPos);
  };

  seekBar?.addEventListener('pointerdown', () => { isSeeking = true; window._isSeeking = true; });
  seekBar?.addEventListener('mousedown', () => { isSeeking = true; window._isSeeking = true; });
  seekBar?.addEventListener('touchstart', () => { isSeeking = true; window._isSeeking = true; }, { passive: true });

  seekBar?.addEventListener('input', () => {
    clearSyncPlaybackRate();
    const v = Number(seekBar.value);
    if (roomMode === 'youtube') { ytPlayer?.seekTo(v, true); ytCurrentTime = v; }
    else movieVideo.currentTime = v;
  });

  seekBar?.addEventListener('change', commitSeekBarChange);
  seekBar?.addEventListener('pointerup', commitSeekBarChange);

  // Keep seek bar in sync with playback
  movieVideo.addEventListener('timeupdate', () => {
    markPlaybackProgress();
    if (!isSeeking && seekBar) seekBar.value = movieVideo.currentTime;
  });

  movieVideo.addEventListener('playing', () => {
    markPlaybackProgress({ rendered: true });
    armRenderedFrameWatcher();
  });

  movieVideo.addEventListener('seeked', () => {
    markPlaybackProgress({ rendered: true });
    armRenderedFrameWatcher();
  });

  movieVideo.addEventListener('loadeddata', () => {
    markPlaybackProgress({ rendered: true });
    armRenderedFrameWatcher();
    queueTrackControlRefresh();
  });

  movieVideo.addEventListener('loadedmetadata', queueTrackControlRefresh);
  movieVideo.addEventListener('emptied', resetTrackControls);
  movieVideo.textTracks?.addEventListener?.('change', refreshCaptionOptions);
  movieVideo.textTracks?.addEventListener?.('addtrack', queueTrackControlRefresh);
  movieVideo.textTracks?.addEventListener?.('removetrack', queueTrackControlRefresh);
  movieVideo.audioTracks?.addEventListener?.('change', refreshAudioTrackOptions);
  movieVideo.audioTracks?.addEventListener?.('addtrack', queueTrackControlRefresh);
  movieVideo.audioTracks?.addEventListener?.('removetrack', queueTrackControlRefresh);

  movieVideo.addEventListener('ended', () => {
    clearSyncPlaybackRate();
    const finalPosition = clampVideoPosition(movieVideo.duration || movieVideo.currentTime);
    if (seekBar) seekBar.value = finalPosition;
    sendPlayPauseCommand(false, finalPosition);
  });

  movieVideo.addEventListener('waiting', () => {
    clearSyncPlaybackRate();
    if (!movieVideo.paused) ensureMoviePlaying({ source: 'waiting', showHint: false });
  });

  movieVideo.addEventListener('stalled', () => {
    clearSyncPlaybackRate();
    if (!movieVideo.paused) ensureMoviePlaying({ source: 'stalled', showHint: false });
  });

  movieVideo.addEventListener('pause', () => {
    if (!isAtVideoEnd() && playbackRetryPending) {
      showToast('Tap play to resume', 'info');
    }
    // Suppress only if the sync engine itself just caused this pause AND
    // it's within the echo window. A real user tap in the opposite direction
    // (play after sync-pause, or pause after sync-play) will NOT be suppressed
    // because the state (playing=false for this event) matches lastAppliedSyncState.
    const isEchoFromSync = lastAppliedSyncState &&
      lastAppliedSyncState.playing === false &&
      (Date.now() - lastAppliedSyncState.at) < SYNC_ECHO_SUPPRESS_MS;
    if (isWatchScreenActive() && canSendRoomControls() && !isAtVideoEnd() && !isEchoFromSync) {
      sendPlayPauseCommand(false, movieVideo.currentTime);
    }
  });

  movieVideo.addEventListener('play', () => {
    const isEchoFromSync = lastAppliedSyncState &&
      lastAppliedSyncState.playing === true &&
      (Date.now() - lastAppliedSyncState.at) < SYNC_ECHO_SUPPRESS_MS;
    if (isWatchScreenActive() && canSendRoomControls() && !isEchoFromSync) {
      sendPlayPauseCommand(true, movieVideo.currentTime);
    }
  });

  document.addEventListener('pointerup', retryPendingPlayback, true);
  document.addEventListener('touchend', retryPendingPlayback, true);
  document.addEventListener('keydown', retryPendingPlayback, true);
  document.addEventListener('fullscreenchange', retryPendingPlayback, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) retryPendingPlayback();
  }, true);

  // ── Ready button ─────────────────────────────────────────────────────────
  readyBtn?.addEventListener('click', () => {
    const nowReady = readyBtn.dataset.ready !== 'true';
    readyBtn.dataset.ready = nowReady;
    readyBtn.textContent = nowReady ? "✓ Let's go!" : "I'm ready 🍿";
    readyBtn.classList.toggle('active', nowReady);
    client.setReady(nowReady);

    if (nowReady && !peerPresent) {
      showToast('Waiting for your friend to join and get ready');
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. WEBRTC VIDEO CALL
// ═════════════════════════════════════════════════════════════════════════════

async function startVideoCall() {
  if (call) return call;
  resetIceRecoveryState();
  callHasEverConnected = false;
  callConnectionAnnounced = false;
  lastIceConnectionState = 'new';
  setCallState('connecting');
  call = new VideoCall(client, localVideo, remoteVideo);
  window.activeCall = call;
  call.addEventListener('ice_state', ({ detail }) => {
    const ice = detail.state;

    if (ice === 'failed') {
      maybeResumeCall({ reason: 'ice-failed' });
    }

    if (ice === 'connected') {
      clearReconnectTimeout();
      isResuming = false;
    }
  });

  call
    .on('started', ({ hasVideo, hasAudio }) => {
      console.log('Call started — video:', hasVideo, 'audio:', hasAudio);
      setCallState('connecting');
      localMediaState.isCameraOn = !!hasVideo;
      localMediaState.isMicOn = !!hasAudio;
      remoteVideoTrackHidden = false;
      showCallUI(true);
      broadcastLocalMediaState('camera_toggle');
    })
    .on('remote_stream', () => {
      showCallUI(true);
      remoteVideoTrackHidden = false;
      renderRemoteMediaUI();
    })
    .on('remote_camera_off', () => {
      remoteVideoTrackHidden = true;
      renderRemoteMediaUI();
    })
    .on('remote_camera_on', () => {
      remoteVideoTrackHidden = false;
      renderRemoteMediaUI();
    })
    .on('local_media_changed', () => {
      syncLocalMediaStateFromCall();
      syncCallButtonState();
      renderRemoteMediaUI({ immediateCamera: true });
      handleMediaSync({ broadcast: true });
    })
    .on('remote_play_blocked', () => {
      showToast('Tap once if your friend\u2019s video does not appear', 'info');
    })
    .on('connected', () => {
      handleCallIceState(call?.iceState || 'connected');
      if (!callConnectionAnnounced) {
        callConnectionAnnounced = true;
        showToast('Video call connected 📹');
      }
    })
    .on('ice_state', ({ state }) => {
      handleCallIceState(state);
    })
    .on('camera_unavailable', () => {
      syncLocalMediaStateFromCall();
      syncCallButtonState();
      renderRemoteMediaUI();
      handleMediaSync({ broadcast: true });
      showToast('Camera not available — audio only');
    })
    .on('media_unavailable', () => {
      syncLocalMediaStateFromCall();
      syncCallButtonState();
      renderRemoteMediaUI();
      handleMediaSync({ broadcast: true });
      showToast('Camera and microphone not available right now');
    })
    .on('ice_failed', () => {
      if (state.presenceState === 'offline') return;
      showReconnectingUI('Call reconnecting…');
      maybeResumeCall({ reason: 'ice-failed-event', delayMs: RESUME_AFTER_ICE_FAILED_DELAY_MS });
    })
    .on('quality_changed', ({ tier }) => {
      const toastMessages = {
        high: null,
        medium: '📶 Weak network — reducing video quality to stay connected',
        low: '📶 Poor network — switching to low quality video',
        audio_only: '📶 Very weak network — video paused, audio only',
      };
      const badgeLabels = {
        high: '',
        medium: '📶 Medium quality',
        low: '📶 Low quality',
        audio_only: '📶 Audio only',
      };
      const badgeColors = {
        high: '',
        medium: '#fbbf24',
        low: '#f97316',
        audio_only: '#ef4444',
      };
      const msg = toastMessages[tier];
      if (msg) showToast(msg, 'info');
      const pipBubble = document.getElementById('pip-bubble');
      if (pipBubble) pipBubble.dataset.quality = tier;
      const badge = document.getElementById('pip-quality-badge');
      if (badge) {
        badge.textContent = badgeLabels[tier] || '';
        badge.style.display = tier !== 'high' ? 'block' : 'none';
        badge.style.color = badgeColors[tier] || '#fbbf24';
      }
      console.log('[Call] Quality tier:', tier);
    })
    .on('ended', () => {
      resetIceRecoveryState();
      remoteVideoTrackHidden = false;
      showCallUI(false);
      window.activeCall = null;
      if (appState.callState !== 'idle') setCallState('ended');
      call = null;
      callHasEverConnected = false;
      callConnectionAnnounced = false;
      lastIceConnectionState = 'new';
      // Reset quality badge
      const badge = document.getElementById('pip-quality-badge');
      if (badge) badge.style.display = 'none';
      const pipBubble = document.getElementById('pip-bubble');
      if (pipBubble) delete pipBubble.dataset.quality;
    });

  // Host is the WebRTC offer initiator. The call is created intentionally from
  // the countdown / resume flow, not from room presence events.
  await call.start(isHost);
  return call;
}

function retryPendingPlayback() {
  if (!playbackRetryPending || !movieVideo.paused) return;
  ensureMoviePlaying({ source: 'user-gesture-resume', showHint: false });
}

// ── Mute button ─────────────────────────────────────────────────────────────
muteBtn?.addEventListener('click', () => {
  if (!call) return;
  call.toggleMute();
  syncLocalMediaStateFromCall();
  broadcastLocalMediaState('mic_toggle');
  // Sync all button state from single source of truth (call.isMuted)
  syncCallButtonState();
});

// ── Camera toggle ────────────────────────────────────────────────────────────
cameraBtn?.addEventListener('click', () => {
  if (!call) return;
  call.toggleCamera();
  syncLocalMediaStateFromCall();
  broadcastLocalMediaState('camera_toggle');
  // Opacity is now managed inside webrtc.js (_releaseCamera/_resumeCamera)
  // to avoid a race between the async toggle and this sync read.
  // We just update the button icon state here.
  requestAnimationFrame(() => syncCallButtonState());
});

// ── End call ─────────────────────────────────────────────────────────────────
endCallBtn?.addEventListener('click', () => {
  resetIceRecoveryState();
  call?.end();
  call = null;
  callHasEverConnected = false;
  callConnectionAnnounced = false;
  lastIceConnectionState = 'new';
  setCallState('ended');
});

watchBackBtn?.addEventListener('click', () => {
  client?.returnToLobby();
  leaveWatchToLobby({
    clearFile: true,
    keepCall: true,
    notice: roomMode === 'youtube' ? 'Paste a YouTube link to start' : 'Pick your video file to check for sync',
  });
});

lobbyBackBtn?.addEventListener('click', () => {
  leaveRoomAndGoHome();
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. REACTIONS
// ═════════════════════════════════════════════════════════════════════════════

// Export functions to window for use in HTML script
window.formatFilenameWithInitials = formatFilenameWithInitials;

function wireReactions() {
  if (reactionsWired) return;
  reactionsWired = true;
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
  setActiveScreen('lobby');
  const codeEl = document.getElementById('lobby-room-code');
  if (codeEl) codeEl.textContent = code;
  const roomPath = `/${code}`;
  if (window.location.pathname !== roomPath) {
    window.history.replaceState({}, '', roomPath);
  }
  window.setRoomCode(code);  // Update share link in HTML
  renderLocalProfileUI();
}

function showCallUI(visible) {
  const pipBubble = document.getElementById('pip-bubble');
  pipBubble?.style.setProperty('display', visible ? 'block' : 'none');
  if (typeof window.setPipOverlayVisibility === 'function') {
    window.setPipOverlayVisibility(visible);
  } else if (pipCallControls) {
    pipCallControls.hidden = !visible;
  }
  if (visible) {
    if (pipBubble) {
      window.resetPipPosition?.();
      window.syncPipBounds?.();
    }

    // BUG FIX: was unconditionally resetting icon/button state to defaults on
    // every call, regardless of actual mic/camera state. This caused the mute
    // icon to snap back to 'mic' every time the user switched screens (lobby ->
    // watch) or tab-switched back, even though the mic was still muted.
    // Fix: read the real state from the call object and reflect it accurately.
    syncLocalMediaStateFromCall();
    syncCallButtonState();
    renderRemoteMediaUI({ immediateCamera: true });

    // Only reset opacity to 1 if camera is actually on.
    // If it's off, webrtc.js already set opacity to 0 — don't override it.
    if (!call?.isCamOff) localVideo.style.opacity = '1';

    // Re-call play() now that the pip is visible. Browsers won't render frames
    // for a <video> that was played while inside a display:none container.
    if (localVideo?.srcObject) localVideo.play().catch(() => { });
    if (remoteVideo?.srcObject) remoteVideo.play().catch(() => { });
  }
}

/**
 * Read the true mic/camera state from the call object and update every
 * button, icon, title, and aria-label to match. Call this any time the
 * call UI is shown or re-shown so it never drifts from reality.
 */
function syncCallButtonState() {
  const muted = call?.isMuted ?? false;
  const camOff = call?.isCamOff ?? false;

  muteBtn?.classList.toggle('active', muted);
  if (muteIcon) muteIcon.textContent = muted ? 'mic_off' : 'mic';
  if (muteBtn) {
    muteBtn.title = muted ? 'Unmute microphone' : 'Mute microphone';
    muteBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  }

  cameraBtn?.classList.toggle('active', camOff);
  if (cameraIcon) cameraIcon.textContent = camOff ? 'videocam_off' : 'videocam';
  if (cameraBtn) {
    cameraBtn.title = camOff ? 'Show camera' : 'Hide camera';
    cameraBtn.setAttribute('aria-label', camOff ? 'Show camera' : 'Hide camera');
  }
}

function showWatchScreen() {
  setActiveScreen('watch');
}

function updatePeerList(peers) {
  peers.forEach(p => {
    if (p.peerId !== client.peerId) addPeerToUI(p);
  });
}

function addPeerToUI(peer) {
  const el = document.getElementById('friend-card');
  if (!el) return;
  el.querySelector('.pname')?.classList.remove('pname-wait');
  updateRemotePeerState({
    participantId: peer.participantId || peer.peerId,
    name: peer.name || 'Your friend',
    isCameraOn: peer.isCameraOn !== false,
    isMicOn: peer.isMicOn !== false,
  });
  const fileLabelEl = document.getElementById('friend-file-label');
  const friendIconEl = document.querySelector('#friend-card .file-drop .fd-icon');
  if (fileLabelEl) fileLabelEl.innerHTML = 'Waiting for<br>your friend to choose a file';
  if (friendIconEl) friendIconEl.textContent = '🎬';
}

function removePeerFromUI(peerId) {
  const el = document.getElementById('friend-card');
  if (!el) return;
  el.querySelector('.pname')?.classList.add('pname-wait');
  resetRemotePeerState();
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
      const formatted = formatFilenameWithInitials(fileName);
      display = `${formatted} &nbsp;<span class="fd-dur">${formatDur(durationSec)}</span>`;
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

function formatFilenameWithInitials(fileName, maxNameChars = 15) {
  const lastDotIndex = fileName.lastIndexOf('.');
  if (lastDotIndex === -1) {
    // No extension
    return fileName.length <= maxNameChars ? fileName : fileName.substring(0, maxNameChars) + '.....';
  }

  const ext = fileName.substring(lastDotIndex);
  const nameWithoutExt = fileName.substring(0, lastDotIndex);

  if (nameWithoutExt.length <= maxNameChars) {
    return fileName; // Fits without truncation
  }

  // Truncate name and add dots before extension
  return nameWithoutExt.substring(0, maxNameChars) + '.....' + ext;
}

function updatePeerReadyState(peerId, isReady) {
  const el = document.getElementById('friend-ready-indicator');
  if (el) el.textContent = isReady ? '✓ Ready' : 'Not ready';
}

let countdownTimer = null;
function startCountdown(onDone, startFrom = 3) {
  // Always clear any existing countdown first — a duplicate countdown_start
  // would spawn two overlapping intervals, causing one peer to enter the watch
  // screen 3-4 seconds after the other (old interval fires onDone a second time).
  clearInterval(countdownTimer);
  countdownTimer = null;

  const el = document.getElementById('countdown-number');
  const overlay = document.getElementById('countdown-overlay');
  renderLocalProfileUI();
  renderRemoteProfileUI({ immediateCamera: true });
  overlay?.classList.add('show');

  // If we're catching up (received countdown_start late due to network latency),
  // start from wherever we actually are in the countdown rather than always 3.
  let n = Math.max(1, Math.min(3, Math.round(startFrom)));
  if (el) el.textContent = n;

  countdownTimer = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
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
  syncToast.className = `sync-toast show ${variant}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => syncToast.classList.remove('show'), 4000);
}
// Let chat.js show a brief peek-toast when a message arrives while panel is closed.
// Only fires on the watch screen — lobby toasts are irrelevant for chat.
window._showChatToast = (msg) => {
  if (!isWatchScreenActive()) return;
  showToast(`💬 ${msg}`, 'info');
};

// ── Action attribution toast ─────────────────────────────────────────────
// Shown briefly on the watch screen to let both peers know who did what.
// Separate from the sync error toast so they don't overwrite each other.
const actionToastEl = document.getElementById('action-toast');
let actionToastTimer = null;
function showActionToast(msg) {
  if (!actionToastEl || !isWatchScreenActive()) return;
  actionToastEl.textContent = msg;
  actionToastEl.classList.add('show');
  clearTimeout(actionToastTimer);
  actionToastTimer = setTimeout(() => actionToastEl.classList.remove('show'), 2500);
}

function formatDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Add keyframe for floating reactions if not already in CSS
const style = document.createElement('style');
style.textContent = `@keyframes floatUp { from { opacity:1; transform:translateY(0) scale(1); } to { opacity:0; transform:translateY(-160px) scale(1.5); } }`;
document.head.appendChild(style);

// ═════════════════════════════════════════════════════════════════════════════
// 7. YOUTUBE MODE
// ═════════════════════════════════════════════════════════════════════════════

// Expose global helpers used by the inline script in index.html
function handleSeekThrottle(deltaSec) {
  if ((Date.now() - lastSeekAt) < CONTROL_DEDUPE_WINDOW_MS) return;
  lastSeekAt = Date.now();
  const cur = roomMode === 'youtube' ? ytCurrentTime : movieVideo.currentTime;
  const dur = roomMode === 'youtube' ? ytDuration : (movieVideo.duration || Infinity);
  const next = Math.max(0, Math.min(isFinite(dur) ? dur : 1e9, cur + deltaSec));
  applyExplicitSeek(next);
}

window.handleSkip = handleSeekThrottle;

window.handleVolumeChange = (v) => {
  if (roomMode === 'youtube') ytPlayer?.setVolume(Math.round(v * 100));
  else movieVideo.volume = v;
};

// ── YouTube IFrame API loading ────────────────────────────────────────────
function loadYouTubeAPI() {
  if (ytApiLoadPromise) return ytApiLoadPromise;
  ytApiLoadPromise = new Promise(resolve => {
    if (window.YT?.Player) { ytApiReady = true; resolve(); return; }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { ytApiReady = true; prev?.(); resolve(); };
  });
  return ytApiLoadPromise;
}

// ── YouTube player creation / reuse ───────────────────────────────────────
// Wrapped in a mutex (ytPlayerInitPromise) so concurrent calls from
// peer_youtube_link background-init and countdown_start don't create two
// YT.Player instances or call cueVideoById on a half-built object.
async function initYtPlayer(videoId) {
  // If an init is already in progress for this exact video, just await it
  if (ytPlayerInitPromise) {
    try { await ytPlayerInitPromise; } catch { }
    // After the previous init, if the player is ready and already has this
    // video loaded, nothing more to do.
    if (ytPlayer && ytPlayerReady && ytVideoId === videoId) return;
  }

  ytPlayerInitPromise = _doInitYtPlayer(videoId);
  try {
    await ytPlayerInitPromise;
  } finally {
    ytPlayerInitPromise = null;
  }
}

async function _doInitYtPlayer(videoId) {
  await loadYouTubeAPI();

  // Reuse path: player exists, is ready, and its methods are real
  if (ytPlayer && ytPlayerReady && typeof ytPlayer.cueVideoById === 'function') {
    stopYtPolling();
    ytPlayer.cueVideoById({ videoId }); // cue first so onError fires before play
    ytVideoId = videoId;
    ytCurrentTime = 0;
    ytDuration = 0;
    // Wait for the player to report a valid duration (proves video loaded)
    // or for onError to fire (which sets ytVideoId = null via the error handler)
    let attempts = 0;
    await new Promise(res => {
      const poll = setInterval(() => {
        const d = typeof ytPlayer.getDuration === 'function' ? ytPlayer.getDuration() : 0;
        const errored = ytVideoId === null; // onError cleared it
        if (d > 0 || errored || ++attempts > 25) { clearInterval(poll); ytDuration = d; res(); }
      }, 200);
    });
    if (ytVideoId === null) throw new Error('Video has embedding disabled or is unavailable.');
    activeVideoId = videoId;
    startYtPolling(videoId);
    return;
  }

  // Destroy any zombie player object before creating a new one
  if (ytPlayer) {
    ytPlayerReady = false;
    try { if (typeof ytPlayer.destroy === 'function') ytPlayer.destroy(); } catch { }
    ytPlayer = null;
    // Re-create the placeholder div that YT.Player replaces
    const wrap = document.getElementById('yt-player-wrap');
    if (wrap && !document.getElementById('yt-player')) {
      const div = document.createElement('div');
      div.id = 'yt-player';
      wrap.appendChild(div);
    }
  }

  // First-time (or post-destroy) player creation
  return new Promise((resolve, reject) => {
    ytPlayerReady = false;
    ytPlayer = new window.YT.Player('yt-player', {
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,  // we use our own controls
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        playsinline: 1,
        enablejsapi: 1,
        origin: window.location.origin,
      },
      events: {
        onReady(e) {
          ytPlayerReady = true;
          ytVideoId = videoId;
          ytDuration = typeof e.target.getDuration === 'function' ? e.target.getDuration() : 0;
          activeVideoId = videoId;
          startYtPolling(videoId);
          resolve();
        },
        onStateChange(e) { onYtStateChange(e.data); },
        onError(e) {
          console.error('[YT] Player error code:', e.data);
          const msg = (e.data === 101 || e.data === 150)
            ? 'This video has embedding disabled by the uploader. Try a different video.'
            : (e.data === 100)
              ? 'Video not found or set to private.'
              : `YouTube player error (code ${e.data})`;
          // Do NOT show toast/status here — the caller (processYtUrl or background
          // pre-warm) decides whether to surface the error. Showing it here would
          // display the message on the receiver's screen when the error actually
          // belongs to the sender who pasted the link.
          ytVideoId = null;
          ytPlayerReady = false;
          resetReadyState({ disable: true });
          reject(new Error(msg));
        },
      },
    });
  });
}

function onYtStateChange(state) {
  // YT.PlayerState: -1 unstarted | 0 ended | 1 playing | 2 paused | 3 buffering | 5 cued
  const nowPaused = state !== 1;
  const wasPlaying = !ytIsPaused;
  ytIsPaused = nowPaused;
  // Expose current play state so the inline auto-hide logic can query it
  window.ytIsPlaying = () => !ytIsPaused;
  window.ytPlayStateUpdate?.(state === 1);

  if (state === 0 && wasPlaying) {
    // Video ended — tell the other peer to pause at the end
    sendPlayPauseCommand(false, ytDuration || ytCurrentTime);
    return;
  }

  // State 1 = playing, state 2 = paused.
  // These can be triggered by YouTube's own overlay controls without going
  // through our custom play/pause button. Broadcast so the peer stays in sync.
  // Suppress only if the sync engine applied this exact state transition.
  // State-matching means a real user tap in the OPPOSITE direction is never blocked.
  const appliedPlaying = state === 1; // true=play, false=pause
  const isEchoFromSync = lastAppliedSyncState &&
    lastAppliedSyncState.playing === appliedPlaying &&
    (Date.now() - lastAppliedSyncState.at) < SYNC_ECHO_SUPPRESS_MS;
  if (!isWatchScreenActive() || !canSendRoomControls() || isEchoFromSync) return;
  if (state === 1) {
    sendPlayPauseCommand(true, ytCurrentTime);
  } else if (state === 2) {
    sendPlayPauseCommand(false, ytCurrentTime);
  }
}


function startYtPolling(videoId = null) {
  stopYtPolling();

  if (videoId) activeVideoId = videoId; // only update if provided

  ytPollingTimer = setInterval(() => {
    if (!ytPlayer || !ytPlayerReady) return;

    const t = ytPlayer.getCurrentTime?.() ?? 0;
    const d = ytPlayer.getDuration?.() ?? 0;

    ytCurrentTime = t;

    // ✅ prevent stale updates
    if (d > 0 && ytDuration === 0 && (!videoId || activeVideoId === videoId)) {
      ytDuration = d;
      client?.updateDuration(d); // 🔥 important
    }
    else if (d > 0 && (!videoId || activeVideoId === videoId)) {
      ytDuration = d;
    }

    window.ytTimeUpdate?.(t, d || ytDuration);
  }, 250);
}


function stopYtPolling() {
  if (ytPollingTimer) { clearInterval(ytPollingTimer); ytPollingTimer = null; }
}

// ── URL parsing + oEmbed fetch ────────────────────────────────────────────
function parseYouTubeId(url) {
  const str = String(url || '').trim();
  for (const p of [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /shorts\/([A-Za-z0-9_-]{11})/,
    /embed\/([A-Za-z0-9_-]{11})/,
  ]) {
    const m = str.match(p); if (m) return m[1];
  }
  return null;
}

async function fetchYtInfo(videoId) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Video not found or private');
  return res.json(); // { title, thumbnail_url }
}

// ── Clear YouTube selection ───────────────────────────────────────────────
function clearYtVideoSelection() {
  ytVideoId = null; ytDuration = 0; ytCurrentTime = 0;
  const inp = document.getElementById('yt-url-input');
  const prev = document.getElementById('yt-preview');
  const load = document.getElementById('yt-loading');
  const clr = document.getElementById('yt-clear-btn');
  if (inp) inp.value = '';
  if (prev) prev.classList.remove('show');
  if (load) load.classList.remove('show');
  if (clr) clr.classList.remove('show');
}

// ── Mode UI switching ─────────────────────────────────────────────────────
function setRoomModeUI(mode, sendWs = true) {
  roomMode = mode;
  const localPanel = document.getElementById('local-src-panel');
  const ytPanel = document.getElementById('yt-src-panel');
  const localBtn = document.getElementById('mode-local-btn');
  const ytBtn = document.getElementById('mode-yt-btn');
  const movieEl = document.getElementById('movie-video');
  const ytWrap = document.getElementById('yt-player-wrap');
  const backBtn = document.getElementById('watch-back-btn');
  window._ytMode = (mode === 'youtube');

  if (mode === 'youtube') {
    localPanel?.classList.add('hidden');
    ytPanel?.classList.remove('hidden');
    localBtn?.classList.remove('active');
    ytBtn?.classList.add('active');
    if (movieEl) movieEl.style.display = 'none';
    if (ytWrap) ytWrap.classList.add('active');
    if (backBtn) backBtn.textContent = '← Change video';
    loadYouTubeAPI(); // pre-fetch API script while user is still in lobby
  } else {
    localPanel?.classList.remove('hidden');
    ytPanel?.classList.add('hidden');
    localBtn?.classList.add('active');
    ytBtn?.classList.remove('active');
    if (movieEl) movieEl.style.removeProperty('display');
    if (ytWrap) ytWrap.classList.remove('active');
    if (backBtn) backBtn.textContent = '← Change file';
  }

  window.requestAnimationFrame(() => {
    window.syncPlayerLayout?.();
  });

  resetReadyState({ disable: true });
  // Only broadcast ready-state reset when WE initiated the switch (sendWs=true).
  // Internal/peer-triggered calls use sendWs=false — calling setReady unconditionally
  // here caused repeated 'peer_ready isReady:false' spam that overwrote toasts and
  // corrupted ready state mid-countdown.
  if (sendWs && client) {
    client.setReady(false);
    client._send('mode_change', { mode });
  }
}

// ── Friend card dynamic content ───────────────────────────────────────────
function updateFriendCardForMode(mode) {
  const section = document.getElementById('friend-file-section');
  if (!section) return;
  if (mode === 'youtube') {
    section.innerHTML = `
      <div class="yt-section">
        <div class="yt-preview" id="friend-yt-preview">
          <img class="yt-thumb" id="friend-yt-thumb" src="" alt=""/>
          <div class="yt-info">
            <div class="yt-title" id="friend-yt-title">Waiting for YouTube link…</div>
            <div class="yt-dur" id="friend-yt-dur"></div>
          </div>
        </div>
      </div>`;
  } else {
    section.innerHTML = `
      <div class="file-drop" style="pointer-events:none;">
        <div class="fd-icon">🌙</div>
        <div class="fd-label" id="friend-file-label">Waiting for<br>your friend to join</div>
      </div>`;
  }
}

function updateFriendYtPreview(videoId, title) {
  const section = document.getElementById('friend-file-section');
  // Ensure YouTube DOM structure exists in friend card
  if (!document.getElementById('friend-yt-preview')) {
    updateFriendCardForMode('youtube');
  }
  const thumbEl = document.getElementById('friend-yt-thumb');
  const titleEl = document.getElementById('friend-yt-title');
  const prevEl = document.getElementById('friend-yt-preview');
  if (thumbEl) thumbEl.src = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  if (titleEl) titleEl.textContent = title || 'YouTube Video';
  if (prevEl) prevEl.classList.add('show');
}

// ── Wire lobby toggle + URL input ─────────────────────────────────────────
let ytLobbyWired = false;
function wireYouTubeLobby() {
  if (ytLobbyWired) return;
  ytLobbyWired = true;

  const toggle = document.getElementById('mode-toggle');
  const ytInput = document.getElementById('yt-url-input');
  const ytClear = document.getElementById('yt-clear-btn');

  toggle?.addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    const targetMode = btn.dataset.mode;
    if (targetMode === roomMode) return;
    if (targetMode === 'local') clearYtVideoSelection();
    setRoomModeUI(targetMode, true);
    setSyncStatus(
      targetMode === 'youtube'
        ? 'Paste a YouTube link to watch together'
        : 'Pick your video file to check for sync',
      'idle'
    );
  });

  let ytDebounce = null;
  let ytLastProcessedId = null; // dedup — prevents paste + input both firing processYtUrl

  const maybeProcessYtUrl = (id) => {
    if (!id || id === ytLastProcessedId) return;
    ytLastProcessedId = id;
    // Reset after 2s so the same link can be re-pasted intentionally after clearing
    setTimeout(() => { if (ytLastProcessedId === id) ytLastProcessedId = null; }, 2000);
    processYtUrl(id);
  };

  ytInput?.addEventListener('input', () => {
    const val = ytInput.value.trim();
    ytClear?.classList.toggle('show', val.length > 0);
    clearTimeout(ytDebounce);
    if (!val) {
      ytLastProcessedId = null;
      document.getElementById('yt-preview')?.classList.remove('show');
      document.getElementById('yt-loading')?.classList.remove('show');
      return;
    }
    const id = parseYouTubeId(val);
    if (!id) return;
    ytDebounce = setTimeout(() => maybeProcessYtUrl(id), 700);
  });

  ytInput?.addEventListener('paste', e => {
    // Run after the paste has updated the input value.
    // cancelDebounce so the 700ms input debounce doesn't also fire.
    clearTimeout(ytDebounce);
    setTimeout(() => {
      const id = parseYouTubeId(e.target.value || '');
      if (id) maybeProcessYtUrl(id);
    }, 60);
  });

  ytClear?.addEventListener('click', () => {
    clearYtVideoSelection();
    resetReadyState({ disable: true });
    setSyncStatus('Paste a YouTube link to watch together', 'idle');
  });
}

// ── Process a YouTube video ID: fetch info → create player → broadcast ────
async function processYtUrl(videoId, { broadcast = true } = {}) {
  if (videoId === ytVideoId && ytPlayerReady) return; // already loaded
  const loadEl = document.getElementById('yt-loading');
  const prevEl = document.getElementById('yt-preview');
  const thumbEl = document.getElementById('yt-thumb');
  const titleEl = document.getElementById('yt-title');
  const durEl = document.getElementById('yt-dur');
  const clrBtn = document.getElementById('yt-clear-btn');

  prevEl?.classList.remove('show');
  if (loadEl) { loadEl.textContent = 'Fetching video info…'; loadEl.classList.add('show'); }

  try {
    const info = await fetchYtInfo(videoId);
    loadEl?.classList.remove('show');

    if (thumbEl) thumbEl.src = info.thumbnail_url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    if (titleEl) titleEl.textContent = info.title || 'YouTube Video';
    if (durEl) durEl.textContent = '';
    prevEl?.classList.add('show');
    ytVideoId = videoId;

    setSyncStatus('Loading YouTube player…', 'idle');
    await initYtPlayer(videoId);
    if (durEl && ytDuration > 0) durEl.textContent = formatDur(ytDuration);

    if (broadcast) {
      // Broadcast the link to the other peer (only when we are the originator)
      client?._send('youtube_link', { videoId, title: info.title || 'YouTube Video', duration: ytDuration });
      setSyncStatus('Waiting for your friend to load the same video', 'idle');
    } else {
      setSyncStatus('Video loaded — you can mark ready!', 'idle');
    }
    // Report our duration through the existing file_ready mechanism — both sides do this.
    // NOTE: do NOT call resetReadyState here. fileReady triggers a duration_check
    // from the server which enables the ready button when both sides match.
    // Calling resetReadyState after fileReady was disabling the button AFTER
    // the server had just enabled it, leaving users stuck unable to mark ready.
    client?.fileReady(ytDuration, info.title || videoId, true); // has video = true for the youtube video
  } catch (err) {
    console.error('[YT] processYtUrl failed:', err);
    loadEl?.classList.remove('show');
    prevEl?.classList.remove('show');
    // Only show the error to the person who actually pasted the link (broadcast=true).
    // The receiver's background pre-warm runs with broadcast=false — silently failing
    // there is correct because the error belongs to the sender, not the receiver.
    if (broadcast) {
      showToast(err.message || 'Could not load YouTube video', 'warn');
      setSyncStatus(err.message || 'Could not load YouTube video', 'warn');
    }
    ytVideoId = null;
  }
}

void wakeBackend();
autoJoinFromPath();
