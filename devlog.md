# WatchTogether — Dev Log

A daily record of bugs found, root causes, and fixes applied.

---

## Day 1 — Initial Sync Engine & Room Foundation

**Focus:** Get the core WebSocket room, file-matching lobby, and play/pause sync working end-to-end.

### Bugs fixed

**`peer_mode_change` and `peer_youtube_link` silently dropped**
- Bug: Both message types were missing from the `_handle()` switch in `client.js`, so they were received and thrown away with no error.
- Fix: Added `case 'peer_mode_change'` and `case 'peer_youtube_link'` to the switch.

**`peer_youtube_link` double-handled on sender side**
- Bug: The `isMine` guard was in the wrong position, so the sender processed their own broadcast and updated state twice.
- Fix: Moved to `if (isMine) return;` at the top of the handler.

**`peer_mode_change` echo blocked friend-card update**
- Bug: `if (mode === roomMode) return` blocked the sender's own echo from updating the friend card.
- Fix: Distinguish sender vs receiver via `peerId === client.peerId`.

**`countdown_start` crashed: `ytPlayer.seekTo is not a function`**
- Bug: Receiver's `initYtPlayer` was still in-flight when `countdown_start` arrived and called `seekTo` on a partially-built player.
- Fix: Made the `countdown_start` handler `async` and `await ytPlayerInitPromise` before calling `seekTo`.

**`ytPlayer.pauseVideo / cueVideoById is not a function` crashes**
- Bug: Concurrent `initYtPlayer` calls created zombie player objects with stub methods that hadn't been filled in by `onReady` yet.
- Fix: Added `ytPlayerInitPromise` mutex. Before creating a new player, call `ytPlayer.destroy()` and recreate the `#yt-player` div.

---

## Day 2 — YouTube Sync & Lobby Race Conditions

**Focus:** Fix the most painful YouTube-specific races and echo loops.

### Bugs fixed

**Autoplay on watch screen entry**
- Bug: `countdown_start` callback was calling `playVideo()`, causing both peers to start playing immediately before either could react.
- Fix: `countdown_start` callback now explicitly pauses on both modes. Users press play themselves.

**Embedding-disabled error shown to wrong user (receiver)**
- Bug: `onError` in the YT player callback was always showing a toast, including on the receiver's screen.
- Fix: Removed toast/status from `onError` entirely. Only the `processYtUrl` catch block (which only runs with `broadcast=true`) shows the error.

**Duplicate `fileReady` calls → false `duration_check` mismatch**
- Bug: `fileReady` was called once immediately and again after player init, and the second call sometimes carried a different duration from the IFrame load cycle.
- Fix: `fileReady` is now called exactly once, using the sender's confirmed duration from the `peer_youtube_link` broadcast as ground truth.

**Paste + input double-fire → 4× `youtube_link` broadcasts**
- Bug: Paste event and input debounce both fired `processYtUrl`, sending the same link 4 times.
- Fix: Added `ytLastProcessedId` dedup guard via `maybeProcessYtUrl()`. Paste handler cancels the pending input debounce.

---

## Day 3 — Reconnect Loops & Room Stability

**Focus:** Kill the infinite reconnect spiral and prevent rooms from dying too fast.

### Bugs fixed

**Room full / session expired → infinite reconnect spiral**
- Bug: On `Room full` or `Room not found` the client kept reconnecting every second, flooding the server with `Not in a room` errors.
- Fix: On those terminal errors, set `_shouldReconnect = false` and clear `roomCode`. Added `client.on('error')` handler that calls `leaveRoomAndGoHome()`.

**Room destroyed immediately when last peer leaves**
- Bug: `removePeer` deleted the room the instant both peers were gone, so a brief network drop during a watch session lost the room code permanently.
- Fix: Added `EMPTY_ROOM_TTL_MS = 10 minutes`. `removePeer` stamps `room.emptyAt`. GC runs every 60 s and only removes rooms where `emptyAt` is set and TTL has elapsed.

**Camera toggle broke remote video permanently**
- Bug: Old `_releaseCamera` called `track.stop()` and `removeTrack()`, triggering ICE renegotiation. Remote video went black.
- Fix: `_releaseCamera` now only does `videoTrack.enabled = false`. `_resumeCamera` fast-path re-enables the track. Slow path (OS revoked the camera) uses `replaceTrack()`.

---

## Day 4 — Native Controls, Echo Loops & ICE Stability

**Focus:** Make native browser controls (Safari overlay, media keys) work without breaking sync.

### Bugs fixed

**Native browser controls (Safari, media keys) not synced**
- Bug: Play/pause triggered from browser overlay or keyboard never went through our button, so the other peer didn't know about it.
- Fix: Added `movieVideo.addEventListener('play', ...)` and `'pause'` listeners. `onYtStateChange` handles states 1 and 2 in addition to 0.

**Play/pause echo loop — sync engine triggering native events**
- Root cause: `ensureMoviePlaying()` called by the sync engine fires `play`/`pause` DOM events, which the native event listeners re-broadcast, creating a ping-pong loop.
- Fix (original): Added `lastReceivedPlayPauseAt` timestamp. Native event listeners check a 2000 ms suppress window before broadcasting.
- Fix (revised, Day 6): Replaced the broad time window with state-direction matching (`lastAppliedSyncState`). The suppress fires only when the native event matches the direction the sync engine just applied. A real user tap in the opposite direction is never suppressed.

**ICE disconnect → endless `peer_left`/`peer_joined` loop**
- Bug: `ICE_DISCONNECT_RESTART_DELAY_MS` was 2500 ms — too short. Mobile networks produce 1–3 s ICE disconnects that self-recover. Firing an ICE restart at 2.5 s was aborting those recoveries.
- Fix: Delay increased to 7000 ms. Disconnect timer re-checks state before restarting; if ICE self-recovered, restart is skipped.

**Adaptive video quality for weak networks**
- Feature: Added quality monitor polling `pc.getStats()` every 3 s. Four tiers: `high`, `medium`, `low`, `audio_only`. Uses `RTCRtpSender.setParameters()` mid-call, no renegotiation. UI badge on PiP bubble shows current tier.

---

## Day 5 — Persistent Drops, Seek Storms & Server Clock Bugs

**Focus:** Tackle the most persistent session-killing bugs under real usage conditions.

### Bugs fixed

**"Room full / session expired" crash after 10–15 min**
- Root cause: Render drops idle WS connections. Client reconnected immediately but the dead socket was still in `room.peers`. Room appeared full → peer ejected.
- Fix (client.js): Added 2 s delay before re-joining after reconnect.
- Fix (backend/index.js): Heartbeat interval reduced from 5000 ms to 2000 ms.
- Fix (wsHandler.js join): Evicts dead peer slots (`readyState` 2 or 3) before capacity check.

**Continuous ~2 s nudge storm during YouTube playback**
- Root cause: YouTube's `getCurrentTime()` returns the decoder position, 1–2 s ahead of the rendered frame. Non-master always reported slightly behind the server clock, triggering nudges on every check.
- Fix: `SYNC_TOLERANCE_SEC` increased from 2 s to 3 s.

**Dual-master seek storm — cascading large-drift seeks**
- Root cause: Per-connection `nudgeCooldownUntil` only protected the seeking peer. The other peer's `sync_check` fired immediately, nudging them back to the pre-seek position, causing both peers to chase each other.
- Fix: Added `myRoom.seekCooldownUntil` (room-level). Any seek sets it to `Date.now() + 3000 ms`. `sync_check` checks both per-connection AND room-level cooldown before nudging.

**Server clock freezes after masterId changes → infinite nudge storm**
- Root cause: After masterId switched, the new master's `sync_check` sends were suppressed by `_syncSuppressUntil` in client.js. The server clock stopped advancing. Every check from the non-master showed drift above tolerance, firing another nudge.
- Fix: `sync_nudge` in client.js now only sets `_syncSuppressUntil` for the non-master (checked via `rest.masterId !== this.peerId`). The master never gets suppressed.

**`nudgeCooldownUntil` set too long (2000 ms) blocking clock updates**
- Bug: Post-nudge cooldown of 2000 ms on both the non-master AND the room-level (`seekCooldownUntil`) blocked the master from sending `sync_check`, keeping the server clock frozen.
- Fix: Reduced nudge cooldown to 1500 ms. Removed `myRoom.seekCooldownUntil` stamp from the nudge handler (only seeks should set it).

**YouTube nudges firing on small drifts → video jumping backward every few seconds**
- Root cause: `nudgePlaybackToward` called `applyHardSync` for any drift ≥ `SOFT_SYNC_THRESHOLD_SEC` (0.8 s). YouTube's polling lag means small apparent drift is normal and should self-correct via clock catch-up.
- Fix: YouTube only hard-seeks when drift ≥ `HARD_SYNC_THRESHOLD_SEC` (4 s).

---

## Day 6 — Bug Sweep, UI Improvements & Cross-Room Leak (March 21, 2026)

**Focus:** Full codebase audit, three UX improvements, and three user-reported bugs.

### Audit fixes applied

**`return_to_lobby` only reset sender's `isReady`, not both peers**
- Bug: Going back to lobby left the other peer's `isReady = true` on the server. A quick double-ready could fire a second `countdown_start` immediately.
- Fix: `wsHandler.js` — `return_to_lobby` now iterates all peers and sets `isReady = false` and `fileDuration = null` for everyone.

**`playbackHealthTimer` never cleared on room leave**
- Bug: `setInterval(checkPlaybackHealth, 1000)` was set once in `wireVideoControls()` and never stopped. After `leaveRoomAndGoHome()`, the watchdog kept firing on a disconnected client, calling `requestSyncCheck` into the void.
- Fix: `leaveRoomAndGoHome` now clears `playbackHealthTimer`, resets `videoControlsWired`, `reactionsWired`, `ytLobbyWired`, `lastAppliedSyncState`, and `lastSentPlayPauseCommand` so a new room session starts with a clean slate.

**`recoverFrozenPlayback` broadcast spurious pause/play to peer**
- Bug: The freeze watchdog called `movieVideo.pause()` without `markSyncApplied(false)`. The `pause` DOM event fired, `isEchoFromSync` was `false`, so `sendPlayPauseCommand(false, ...)` went out to the peer, pausing them too.
- Fix: Stamped `markSyncApplied(false)` before the decoder nudge and `markSyncApplied(true)` before the subsequent `ensureMoviePlaying` call.

**`return_to_lobby` didn't clear `youtubeVideoId` on the room**
- Bug: Going back to the lobby reset `isReady` and `fileDuration` but left `room.youtubeVideoId` intact. The stale video would appear in the `joined` snapshot for any future session in that room slot.
- Fix: `return_to_lobby` handler now also sets `room.youtubeVideoId = null` and `room.youtubeTitle = null`.

**Room code wordlists had duplicate "NIGHT" and only 8 entries each**
- Bug: `NOUNS` contained "NIGHT" and "NIGHT" — one of the nouns was identical. With only 8×8×9000 = 576,000 combinations and the duplicate cutting that further, collision probability was higher than it should be.
- Fix: Expanded both lists to 16 unique entries each, removed the duplicate.

**WebRTC polite-peer rollback missing null-check on `this.pc`**
- Bug: `await this.pc.setLocalDescription({ type: 'rollback' })` could throw if `this.pc` was null during an offer collision.
- Fix: Added `if (this.pc)` guard before the rollback call.

**`play_pause` and `sync_nudge` handlers pre-stamped `markSyncApplied` too early**
- Bug: Stamping `lastAppliedSyncState` at message receive time rather than at actual apply time could suppress a legitimate user tap if the sync correction was a no-op (guards tripped inside `handleSyncCorrection`).
- Fix: Removed pre-stamps from both handlers. `markSyncApplied` is now called only inside `ensureMoviePlaying` and `applyHardSync` at the exact moment the media element is acted on.

**`joinRoomBtn` had no error handling**
- Bug: If the room validation `fetch` threw (network down, DNS failure), the entire click handler rejected with an unhandled promise, showing nothing in the UI.
- Fix: Wrapped in `try/catch`. Replaced `alert()` calls with `showLandingNotice()` for consistent UI error display.

### Features added

**Control bar auto-hide**
- The player timeline, controls, and back button now hide after 3 seconds of inactivity while playing.
- Always stay visible while paused.
- Re-appear on any `mousemove`, `touchstart`, or `click`.
- Listeners use `document` level with `capture: true` so the YouTube IFrame (which covers the full screen at `z-index:1`) cannot swallow the events.

**Action attribution toasts**
- A second toast element (`.action-toast`) sits above the control bar and shows who did what:
  - Sender sees: "▶ You resumed", "⏸ You paused", "⏩ You skipped to 1:23:45"
  - Receiver sees: "▶ Satya resumed", "⏸ Satya paused", "⏩ Satya skipped to 1:23:45"
- Separate from the sync error toast — they don't overwrite each other.
- Auto-dismisses after 2.5 s.

### Bugs fixed (user-reported)

**Bug: YouTube audio plays during countdown (video hidden but audio audible)**
- Root cause: `ytPlayer.seekTo(positionSec, true)` — `allowSeekAhead=true` tells the IFrame to start buffering aggressively, which on some browsers/videos triggers the audio decoder to start even with `autoplay:0`.
- Fix: Changed to `ytPlayer.seekTo(positionSec, false)` to prevent aggressive buffering. Added immediate `pauseVideo()` call after the seek, and `ytIsPaused = true`. Added a second `pauseVideo()` at countdown completion for defence against mid-countdown resume.

**Bug: Player controls not appearing on mouse movement / tap**
- Root cause: The `mousemove`, `touchstart`, and `click` listeners were on `#screen-watch`. But `#yt-player-wrap` (the YouTube IFrame container) sits at `z-index:1` covering the entire viewport. The IFrame is a cross-origin frame and captures all pointer events before they bubble to `#screen-watch`.
- Fix: Moved all three listeners to `document` level. `mousemove` and `touchstart` use `{ passive: true }`. `click` uses `capture: true`. Added `isWatchActive()` guard so they only activate on the watch screen.

**Bug: Cross-room YouTube state — opening a new room showed another room's video**
- Root cause (three layers):
  1. The room's `youtubeVideoId` field was never cleared when a session ended. Within the 10-minute empty-room TTL, any new peer joining that room slot (possible via a stale URL in the browser) would receive the old video in their `joined` snapshot.
  2. `return_to_lobby` didn't clear `youtubeVideoId` on the room object.
  3. The `joined` handler in the frontend restored YouTube mode even when the joining peer was the first (and only) person in the room — i.e., no peer was there to have set the video in this session.
- Fix 1 (server — `ws.on('close')`): When a room becomes empty, immediately wipe `youtubeVideoId`, `youtubeTitle`, `playState.playing`, `playState.positionSec`, and `playState.masterId`.
- Fix 2 (server — `return_to_lobby`): Clear `youtubeVideoId` and `youtubeTitle` on lobby return.
- Fix 3 (frontend — `joined` handler): Only restore YouTube mode `if (data.roomMode === 'youtube' && peerPresent)`. A solo join always starts with a clean slate.

### UI fixes (same session, follow-up)

**Bug: Sync toast still showing at bottom of watch screen despite `position:fixed` CSS**
- Root cause: `#screen-watch` has `overflow:hidden` in its CSS. This creates a new "containing block" for fixed-position descendants in most browsers, so `position:fixed` on the toast behaved like `position:absolute` — anchored inside the watch screen instead of the viewport. The lobby screen has no `overflow:hidden`, which is why the exact same toast element showed at the top correctly there but not on the watch screen.
- Fix: Moved `#sync-toast` from being a child of `#screen-watch` to a direct child of `<body>`, placed after all screen elements. At the body level no ancestor has `overflow:hidden`, so `position:fixed` + `top:18px` works as intended everywhere. No changes to CSS or the `showToast()` function needed — same element, same styles, correct stacking context.

**Feature: Version badge**
- Added a subtle `v0.6.3` label fixed to the bottom-right corner of every screen.
- Inline style only: `font-size:10px`, `color:rgba(255,255,255,.22)`, `pointer-events:none`, `user-select:none` — completely non-interactive and barely visible.
- Version rationale: 6 days of development, 3 bug-fix passes on Day 6 → `v0.6.3`.

---

## Day 7 — Real-time Chat (March 22, 2026)

**Focus:** Add a Google Meet-style slide-in chat panel with room-isolated real-time messaging over the existing WebSocket connection.

### Architecture decisions

- **No Socket.IO** — the backend already uses the `ws` library with a room-based message protocol. Adding Socket.IO would require a second server and break the existing WS handshake. Chat is implemented as a new `type: 'chat_message'` message in the existing protocol, exactly like `reaction` or `play_pause`.
- **Optimistic rendering** — the sender renders their own message immediately without waiting for a server echo. The server never relays the message back to the sender (`broadcast(..., excludePeerId = myPeerId)`), so there is no echo to deduplicate. The receiver renders on arrival.
- **Deduplication** — client generates a `messageId` (`timestamp + random`) per send. A `Set<messageId>` in `Chat` ensures the same message can never be rendered twice even on edge-case reconnects.
- **Sanitization** — double layer: server strips HTML tags and control characters and caps at 500 chars; client uses `textContent` exclusively (never `innerHTML`) for all user-supplied strings.
- **Video resize** — `#movie-video` and `#yt-player-wrap` are `position:absolute; inset:0`. When chat opens, the `.chat-open` class is added to `#screen-watch` which transitions `right` from `0` to `clamp(240px, 25vw, 340px)`. The control bar and reactions strip move with the same transition. Pure CSS, no JS layout math.

### Files changed

**`backend/wsHandler.js`**
- Added `chat_message` handler: sanitizes `text` (strips HTML, caps 500 chars), builds payload with server-assigned `timestamp`, relays to OTHER peer only via `broadcast(..., myPeerId)`.

**`frontend/src/client.js`**
- Added `sendChat(text)` — generates `messageId`, sends `{ type: 'chat_message', text, messageId }`.
- Added `case 'chat_message'` in `_handle()` switch — emits `chat_message` event.

**`frontend/src/chat.js`** *(new file)*
- `Chat` class: `mount()`, `wireClient()`, `setMyName()`, `reset()`, `open()`, `close()`.
- `_buildDOM()` — injects chat toggle button (below reactions) and chat panel into `#screen-watch`.
- `_openPanel()` / `_closePanel()` — toggles `.open` on panel and `.chat-open` on `#screen-watch`.
- `_trySend()` — sanitizes, calls `client.sendChat()`, renders optimistically, clears input.
- `_onIncoming()` — deduplicates via `_seenIds`, renders, increments unread dot, fires `window._showChatToast` for first 3 unread messages.
- `_appendMessage()` — builds message bubble using only `textContent` (XSS-safe). Prunes DOM at 200 messages. Auto-scrolls only when user was within 80px of bottom.
- Keyboard shortcut: `Ctrl/Cmd+Shift+C` toggles chat from anywhere on the watch screen.

**`frontend/src/app.js`**
- Imports `Chat` from `./chat.js`.
- Creates singleton `chat` at module level.
- `connectAndJoin()` calls `chat.setMyName()`, `chat.wireClient()`, `chat.mount()`.
- `leaveRoomAndGoHome()` calls `chat.reset()`.
- `window._showChatToast` assigned after `showToast` is defined — shows `💬 Name: text` peek-toast on watch screen when panel is closed.

**`frontend/index.html`**
- 280 lines of CSS added for: chat panel, chat toggle button, unread dot, message bubbles (self/peer), input row, scrollbar, mobile responsive overrides, and `.chat-open` layout transitions.

### WebSocket protocol additions

| Direction | Type | Key fields |
|---|---|---|
| Client → Server | `chat_message` | `text`, `messageId` |
| Server → Client | `chat_message` | `messageId`, `fromPeerId`, `senderName`, `text`, `timestamp` |

### Edge cases handled

- Empty message: rejected client-side (send button disabled) and server-side (empty string check before relay).
- XSS: `textContent` only in DOM; HTML stripped server-side.
- Duplicate render: `_seenIds` Set deduplicates by `messageId`.
- Cross-room leak: server only `broadcast`s within `myRoom`, excludes sender.
- DOM memory: oldest messages pruned at 200 entries.
- Auto-scroll: only fires when user is within 80px of bottom (`SCROLL_THRESHOLD`).
- Peer disconnect: chat log is preserved client-side; reset only on explicit `leaveRoomAndGoHome()`.
- Panel state on reconnect: chat survives WS reconnects (state is in-memory JS, not the socket).
- Mobile: panel width clamps to `min(86vw, 320px)` on narrow screens.

---

## Notes & Known Limitations

- **TURN server:** `openrelay.metered.ca` is free/unreliable. Replace with a paid TURN service (Twilio, Xirsys, Metered Pro) for production stability on strict NATs.
- **YouTube embedding:** Videos from Vevo, major labels, and most official movie trailers have embedding disabled by the uploader. No clean fix — ask the other person to try a different video.
- **YouTube sync accuracy:** ~250 ms (IFrame API polling). Local file sync is frame-accurate via the native `<video>` element and `requestVideoFrameCallback`.
- **Room capacity:** Hard-capped at 2 peers. Designed as a 2-person watch party tool.
- **In-memory rooms:** Rooms live only for the lifetime of the Render process. A Render restart (cold start after inactivity on the free tier) destroys all rooms. Users will see "Room has expired" and need to create a new room.
