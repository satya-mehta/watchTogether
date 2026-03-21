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
const subtitleInput = document.getElementById('subtitle-input');
const subtitlePicker = document.getElementById('subtitle-picker');
const subtitleFileLabel = document.getElementById('subtitle-file-label');
const subtitleClearBtn = document.getElementById('subtitle-clear-btn');
const playPauseBtn  = document.getElementById('play-pause-btn');
const seekBar       = document.getElementById('seek-bar');
const captionsSelect = document.getElementById('captions-select');
const audioTrackSelect = document.getElementById('audio-track-select');
const captionsHelp  = document.getElementById('captions-help');
const audioTrackHelp = document.getElementById('audio-track-help');
const captionsField = captionsSelect?.closest('.track-field');
const audioTrackField = audioTrackSelect?.closest('.track-field');

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
let peerLeftTimer = null;        // grace period before tearing down call on peer_left
const PEER_LEFT_GRACE_MS = 9000; // 9s — enough for a WS reconnect on mobile
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
let trackRefreshFrame = null;
let trackRefreshTimeout = null;
let localSubtitleTrackEl = null;
let localSubtitleObjectUrl = null;
let localSubtitleFileName = null;

// ── YouTube mode state ────────────────────────────────────────────────────
let roomMode        = 'local';  // 'local' | 'youtube'
let ytVideoId       = null;     // current YouTube video ID
let ytPlayer        = null;     // YT.Player instance
let ytApiReady      = false;
let ytPlayerReady   = false;
let ytCurrentTime   = 0;
let ytDuration      = 0;
let ytIsPaused      = true;
let ytPollingTimer  = null;
let ytApiLoadPromise = null;
let isSeeking       = false;    // moved to module level so ytPolling can read it

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
  } catch {}

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
  return Boolean(client && peerPresent && hasSource && isWatchScreenActive());
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
  client?.playPause(playing, targetPos);
}

async function ensureMoviePlaying({ source = 'sync', showHint = false } = {}) {
  if (roomMode === 'youtube') {
    if (ytPlayer && ytPlayerReady) { ytPlayer.playVideo(); ytIsPaused = false; }
    return true;
  }
  if (movieVideo.paused) {
    try {
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
    // YouTube's rate API is coarse — just hard-sync for large drifts
    if (driftSec >= HARD_SYNC_THRESHOLD_SEC) applyHardSync({ targetPos, playing: true, announce: true, driftSec });
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
  if (broadcast) client?.seek(targetPos);
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
    if (roomMode === 'youtube') { ytPlayer?.pauseVideo(); ytIsPaused = true; }
    else movieVideo.pause();
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
      if (roomMode === 'youtube') { ytPlayer?.pauseVideo(); ytIsPaused = true; }
      else movieVideo.pause();
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
    if (ytPlayer && ytPlayerReady) { ytPlayer.pauseVideo(); ytPlayer.seekTo(0, true); }
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
  if (roomMode === 'youtube') {
    if (ytPlayer && ytPlayerReady) { ytPlayer.pauseVideo(); ytPlayer.seekTo(0, true); }
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
  clearTimeout(peerLeftTimer);
  peerLeftTimer = null;
  call?.end();
  call = null;
  callStarting = false;
  showCallUI(false);
  client?.disconnect();
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

  // Nudge the decoder and then request the authoritative position immediately.
  try {
    movieVideo.currentTime = clampVideoPosition(targetPos + 0.001);
    movieVideo.currentTime = targetPos;
  } catch {}

  movieVideo.pause();
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
  client = new WatchTogetherClient(SERVER_URL, BACKEND_BASE_URL);
  await client.connect();
  client.join({ roomCode, name: myName, isHost });

  // Wire up all event listeners
  wireClientEvents();
  wireVideoControls();
  wireReactions();
  wireYouTubeLobby();
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
    // Restore YouTube mode if room was already in YouTube mode when we joined
    if (data.roomMode === 'youtube') {
      setRoomModeUI('youtube', false);
      if (data.youtubeVideoId) {
        const ytInput = document.getElementById('yt-url-input');
        if (ytInput) ytInput.value = `https://www.youtube.com/watch?v=${data.youtubeVideoId}`;
        document.getElementById('yt-clear-btn')?.classList.add('show');
        processYtUrl(data.youtubeVideoId).catch(console.warn);
      }
    }
  });

  client.on('peer_joined', (data) => {
    peerPresent = true;

    // BUG FIX: if peer_left fired but the peer reconnected within the grace
    // window, cancel the pending call teardown. This prevents the WS reconnect
    // cycle (leave → rejoin within seconds) from destroying and rebuilding
    // the entire WebRTC call every time.
    if (peerLeftTimer) {
      clearTimeout(peerLeftTimer);
      peerLeftTimer = null;
      // Peer is back — show reconnected toast instead of "joined" toast
      showToast(`${data.name} reconnected 🔄`);
      addPeerToUI(data);
      // If the call was healthy and survived, just return; otherwise rebuild
      if (call) return;
    } else {
      showToast(`${data.name} joined the room 🎉`);
      addPeerToUI(data);
    }

    ensureVideoCall();
  });

  client.on('peer_left', (data) => {
    peerPresent = false;
    removePeerFromUI(data.peerId);
    clearSyncPlaybackRate();

    // Pause playback immediately — but keep the call alive for now
    if (roomMode === 'youtube') { if (ytPlayer && ytPlayerReady) { ytPlayer.pauseVideo(); ytIsPaused = true; } }
    else movieVideo.pause();

    // BUG FIX: don't tear down the WebRTC call immediately on peer_left.
    // WebSocket drops are common on mobile / poor networks. The peer usually
    // reconnects within 1-3 seconds via client.js auto-reconnect. If we
    // destroy the call instantly, we pay the full ICE negotiation cost again
    // every time — which is exactly what caused the endless leave/rejoin loop.
    //
    // Strategy: show a "reconnecting" toast and wait PEER_LEFT_GRACE_MS.
    // If peer_joined fires within that window, we cancel the teardown.
    // If the timer expires without them coming back, we accept they're gone.
    clearTimeout(peerLeftTimer);
    showToast(`${data.name} disconnected — waiting for reconnect…`);
    setSyncStatus(`${data.name || 'Your friend'} disconnected — reconnecting…`, 'warn');

    peerLeftTimer = setTimeout(() => {
      peerLeftTimer = null;
      // They didn't come back — do the full teardown now
      showToast(`${data.name} left the room`);
      call?.end();
      call = null;
      callStarting = false;
      setSyncStatus('Waiting for your friend to join', 'idle');
    }, PEER_LEFT_GRACE_MS);
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
    updatePeerReadyState(peerId, isReady);
  });

  client.on('countdown_start', ({ positionSec }) => {
    if (roomMode === 'youtube') {
      if (ytPlayer && ytPlayerReady) ytPlayer.seekTo(positionSec, true);
      ytCurrentTime = positionSec;
    } else {
      movieVideo.currentTime = positionSec;
    }
    startCountdown(() => {
      showWatchScreen();
      showCallUI(!!call);
      if (roomMode === 'youtube') {
        // The countdown overlay provides the user gesture that satisfies autoplay policy
        setTimeout(() => { if (ytPlayer && ytPlayerReady) { ytPlayer.playVideo(); ytIsPaused = false; } }, 150);
      }
    });
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
    if (mode === roomMode) return; // already in sync
    setRoomModeUI(mode, false);   // apply without re-broadcasting
    if (mode === 'youtube') {
      clearYtVideoSelection();
      updateFriendCardForMode('youtube');
      setSyncStatus(`${name || 'Your friend'} switched to YouTube mode — paste the same link`, 'idle');
      showToast(`${name || 'Your friend'} switched to YouTube mode`);
    } else {
      updateFriendCardForMode('local');
      setSyncStatus('Your friend switched back to local file mode', 'idle');
      showToast(`${name || 'Your friend'} switched to local file mode`);
    }
    resetReadyState({ disable: true });
  });

  client.on('peer_youtube_link', async ({ fromPeerId, videoId, title }) => {
    if (!videoId) return;
    const isMine = fromPeerId === client.peerId;
    if (!isMine) {
      // Friend shared the link — load it on our side too
      updateFriendYtPreview(videoId, title);
      setSyncStatus(`${getPeerDisplayName()} shared a YouTube video — loading…`, 'idle');
      showToast(`${getPeerDisplayName()} shared: ${title || videoId}`, 'info');
      const ytInput = document.getElementById('yt-url-input');
      if (ytInput) { ytInput.value = `https://www.youtube.com/watch?v=${videoId}`; }
      document.getElementById('yt-clear-btn')?.classList.add('show');
      if (videoId !== ytVideoId) {
        await processYtUrl(videoId).catch(err => console.warn('[YT] auto-load failed:', err));
      }
    }
    resetReadyState({ disable: true });
    client?.setReady(false);
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
    applyExplicitSeek(positionSec, { broadcast: false });
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
    const pos        = roomMode === 'youtube' ? ytCurrentTime : movieVideo.currentTime;
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
  window.activeCall = call;

  const remoteCamOff = document.getElementById('remote-cam-off');

  call
    .on('started', ({ hasVideo, hasAudio }) => {
      console.log('Call started — video:', hasVideo, 'audio:', hasAudio);
      showCallUI(true);
    })
    .on('remote_stream', () => {
      showCallUI(true);
      if (remoteCamOff) remoteCamOff.style.display = 'none';
    })
    .on('remote_camera_off', () => {
      if (remoteCamOff) remoteCamOff.style.display = 'flex';
    })
    .on('remote_camera_on', () => {
      if (remoteCamOff) remoteCamOff.style.display = 'none';
    })
    .on('remote_play_blocked', () => {
      showToast('Tap once if your friend’s video does not appear', 'info');
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
    .on('ice_failed', () => {
      showToast('Video call could not connect — network may be blocking P2P. Try a different network.', 'warn');
    })
    .on('ended', () => {
      if (remoteCamOff) remoteCamOff.style.display = 'none';
      showCallUI(false);
      window.activeCall = null;
      call = null;
    });

  // Host is the WebRTC offer initiator; guest auto-answers via 'peer_joined' signal
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
  // Sync all button state from single source of truth (call.isMuted)
  syncCallButtonState();
});

// ── Camera toggle ────────────────────────────────────────────────────────────
cameraBtn?.addEventListener('click', () => {
  if (!call) return;
  call.toggleCamera();
  // Sync all button state from single source of truth (call.isCamOff)
  // Small delay so _cameraEnabled flag has flipped before we read it
  requestAnimationFrame(() => {
    syncCallButtonState();
    localVideo.style.opacity = call?.isCamOff ? '0' : '1';
  });
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
  const playerCard = document.querySelector('.player-card.you');
  if (playerCard) {
    const pTag = playerCard.querySelector('.ptag.pmyself');
    if (pTag) {
        pTag.textContent = 'You • ' + myName;
    }
}
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

    // BUG FIX: was unconditionally resetting icon/button state to defaults on
    // every call, regardless of actual mic/camera state. This caused the mute
    // icon to snap back to 'mic' every time the user switched screens (lobby ->
    // watch) or tab-switched back, even though the mic was still muted.
    // Fix: read the real state from the call object and reflect it accurately.
    syncCallButtonState();

    localVideo.style.opacity = call?.isCamOff ? '0' : '1';

    // Re-call play() now that the pip is visible. Browsers won't render frames
    // for a <video> that was played while inside a display:none container.
    if (localVideo?.srcObject)  localVideo.play().catch(() => {});
    if (remoteVideo?.srcObject) remoteVideo.play().catch(() => {});
  }
}

/**
 * Read the true mic/camera state from the call object and update every
 * button, icon, title, and aria-label to match. Call this any time the
 * call UI is shown or re-shown so it never drifts from reality.
 */
function syncCallButtonState() {
  const muted  = call?.isMuted  ?? false;
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
  el.querySelector('.pfriend').textContent = 'Friend • ' + peer.name;
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
  el.querySelector('.pfriend').textContent = 'Friend';
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

// ═════════════════════════════════════════════════════════════════════════════
// 7. YOUTUBE MODE
// ═════════════════════════════════════════════════════════════════════════════

// Expose global helpers used by the inline script in index.html
window.handleSkip = (deltaSec) => {
  const cur = roomMode === 'youtube' ? ytCurrentTime : movieVideo.currentTime;
  const dur = roomMode === 'youtube' ? ytDuration    : (movieVideo.duration || Infinity);
  const next = Math.max(0, Math.min(isFinite(dur) ? dur : 1e9, cur + deltaSec));
  applyExplicitSeek(next);
};

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
    tag.src   = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { ytApiReady = true; prev?.(); resolve(); };
  });
  return ytApiLoadPromise;
}

// ── YouTube player creation / reuse ───────────────────────────────────────
async function initYtPlayer(videoId) {
  await loadYouTubeAPI();
  if (ytPlayer && ytPlayerReady) {
    // Reuse existing player — just load new video
    ytPlayer.loadVideoById({ videoId, suggestedQuality: 'default' });
    ytVideoId     = videoId;
    ytCurrentTime = 0;
    // getDuration may not be available immediately after load; poll for it
    let attempts = 0;
    await new Promise(res => {
      const poll = setInterval(() => {
        const d = ytPlayer.getDuration?.() ?? 0;
        if (d > 0 || ++attempts > 20) { clearInterval(poll); ytDuration = d; res(); }
      }, 200);
    });
    return;
  }
  // First-time player creation
  return new Promise((resolve, reject) => {
    ytPlayerReady = false;
    ytPlayer = new window.YT.Player('yt-player', {
      videoId,
      playerVars: {
        autoplay:        0,
        controls:        0,  // we use our own controls
        disablekb:       1,
        modestbranding:  1,
        rel:             0,
        iv_load_policy:  3,
        playsinline:     1,
        enablejsapi:     1,
        origin:          window.location.origin,
      },
      events: {
        onReady(e) {
          ytPlayerReady = true;
          ytVideoId     = videoId;
          ytDuration    = e.target.getDuration?.() ?? 0;
          startYtPolling();
          resolve();
        },
        onStateChange(e) { onYtStateChange(e.data); },
        onError(e) {
          console.error('[YT] Player error code:', e.data);
          showToast('YouTube video unavailable or restricted', 'warn');
          reject(new Error('YT error ' + e.data));
        },
      },
    });
  });
}

function onYtStateChange(state) {
  // YT.PlayerState: -1 unstarted | 0 ended | 1 playing | 2 paused | 3 buffering | 5 cued
  const nowPaused  = state !== 1;
  const wasPlaying = !ytIsPaused;
  ytIsPaused = nowPaused;
  window.ytPlayStateUpdate?.(state === 1);
  if (state === 0 && wasPlaying) {
    // Video ended — tell the other peer to pause
    sendPlayPauseCommand(false, ytDuration || ytCurrentTime);
  }
}

function startYtPolling() {
  stopYtPolling();
  ytPollingTimer = setInterval(() => {
    if (!ytPlayer || !ytPlayerReady) return;
    const t = ytPlayer.getCurrentTime?.() ?? 0;
    const d = ytPlayer.getDuration?.() ?? 0;
    ytCurrentTime = t;
    if (d > 0) ytDuration = d;
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
  const inp  = document.getElementById('yt-url-input');
  const prev = document.getElementById('yt-preview');
  const load = document.getElementById('yt-loading');
  const clr  = document.getElementById('yt-clear-btn');
  if (inp)  inp.value = '';
  if (prev) prev.classList.remove('show');
  if (load) load.classList.remove('show');
  if (clr)  clr.classList.remove('show');
}

// ── Mode UI switching ─────────────────────────────────────────────────────
function setRoomModeUI(mode, sendWs = true) {
  roomMode = mode;
  const localPanel = document.getElementById('local-src-panel');
  const ytPanel    = document.getElementById('yt-src-panel');
  const localBtn   = document.getElementById('mode-local-btn');
  const ytBtn      = document.getElementById('mode-yt-btn');
  const movieEl    = document.getElementById('movie-video');
  const ytWrap     = document.getElementById('yt-player-wrap');
  const backBtn    = document.getElementById('watch-back-btn');
  window._ytMode   = (mode === 'youtube');

  if (mode === 'youtube') {
    localPanel?.classList.add('hidden');
    ytPanel?.classList.remove('hidden');
    localBtn?.classList.remove('active');
    ytBtn?.classList.add('active');
    if (movieEl) movieEl.style.display = 'none';
    if (ytWrap)  ytWrap.classList.add('active');
    if (backBtn) backBtn.textContent = '← Change video';
    loadYouTubeAPI(); // pre-fetch API script while user is still in lobby
  } else {
    localPanel?.classList.remove('hidden');
    ytPanel?.classList.add('hidden');
    localBtn?.classList.add('active');
    ytBtn?.classList.remove('active');
    if (movieEl) movieEl.style.removeProperty('display');
    if (ytWrap)  ytWrap.classList.remove('active');
    if (backBtn) backBtn.textContent = '← Change file';
  }

  resetReadyState({ disable: true });
  client?.setReady(false);
  if (sendWs && client) client._send('mode_change', { mode });
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
  const prevEl  = document.getElementById('friend-yt-preview');
  if (thumbEl) thumbEl.src = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  if (titleEl) titleEl.textContent = title || 'YouTube Video';
  if (prevEl)  prevEl.classList.add('show');
}

// ── Wire lobby toggle + URL input ─────────────────────────────────────────
let ytLobbyWired = false;
function wireYouTubeLobby() {
  if (ytLobbyWired) return;
  ytLobbyWired = true;

  const toggle  = document.getElementById('mode-toggle');
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
  ytInput?.addEventListener('input', () => {
    const val = ytInput.value.trim();
    ytClear?.classList.toggle('show', val.length > 0);
    clearTimeout(ytDebounce);
    if (!val) {
      document.getElementById('yt-preview')?.classList.remove('show');
      document.getElementById('yt-loading')?.classList.remove('show');
      return;
    }
    const id = parseYouTubeId(val);
    if (!id) return;
    ytDebounce = setTimeout(() => processYtUrl(id), 700);
  });

  ytInput?.addEventListener('paste', e => {
    // Run after the paste has updated the input value
    setTimeout(() => {
      const id = parseYouTubeId(e.target.value || '');
      if (id) processYtUrl(id);
    }, 60);
  });

  ytClear?.addEventListener('click', () => {
    clearYtVideoSelection();
    resetReadyState({ disable: true });
    setSyncStatus('Paste a YouTube link to watch together', 'idle');
  });
}

// ── Process a YouTube video ID: fetch info → create player → broadcast ────
async function processYtUrl(videoId) {
  if (videoId === ytVideoId && ytPlayerReady) return; // already loaded
  const loadEl  = document.getElementById('yt-loading');
  const prevEl  = document.getElementById('yt-preview');
  const thumbEl = document.getElementById('yt-thumb');
  const titleEl = document.getElementById('yt-title');
  const durEl   = document.getElementById('yt-dur');
  const clrBtn  = document.getElementById('yt-clear-btn');

  prevEl?.classList.remove('show');
  if (loadEl) { loadEl.textContent = 'Fetching video info…'; loadEl.classList.add('show'); }

  try {
    const info = await fetchYtInfo(videoId);
    loadEl?.classList.remove('show');

    if (thumbEl) thumbEl.src = info.thumbnail_url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    if (titleEl) titleEl.textContent = info.title || 'YouTube Video';
    if (durEl)   durEl.textContent   = '';
    prevEl?.classList.add('show');
    ytVideoId = videoId;

    setSyncStatus('Loading YouTube player…', 'idle');
    await initYtPlayer(videoId);
    if (durEl && ytDuration > 0) durEl.textContent = formatDur(ytDuration);

    // Broadcast the link to the other peer
    client?._send('youtube_link', { videoId, title: info.title || 'YouTube Video' });
    // Report our own duration through the existing file_ready mechanism
    client?.fileReady(ytDuration, info.title || videoId);

    setSyncStatus('Waiting for your friend to load the same video', 'idle');
    resetReadyState({ disable: true });
  } catch (err) {
    console.error('[YT] processYtUrl failed:', err);
    loadEl?.classList.remove('show');
    prevEl?.classList.remove('show');
    showToast(err.message || 'Could not load YouTube video', 'warn');
    ytVideoId = null;
  }
}

void wakeBackend();
autoJoinFromPath();