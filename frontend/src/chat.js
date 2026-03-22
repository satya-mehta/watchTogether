/**
 * chat.js — WatchTogether in-room chat
 *
 * Responsibilities:
 *  - Render the chat panel (open/close with video resize)
 *  - Send messages via client.sendChat()
 *  - Receive messages via client.on('chat_message')
 *  - Show unread dot on the chat button when panel is closed
 *  - Auto-scroll to newest message (only when already near bottom)
 *  - Sanitize all user content — text is always set via textContent, never innerHTML
 *  - Deduplicate messages using messageId (prevents echo if routing changes)
 *  - Clear state on room leave via chat.reset()
 */

// ── Constants ────────────────────────────────────────────────────────────────
const CHAT_MAX_CHARS    = 500;  // hard cap enforced client-side too
const SCROLL_THRESHOLD  = 80;   // px from bottom — auto-scroll fires below this
const RENDER_BATCH_SIZE = 200;  // max messages kept in DOM (oldest pruned)

// ── Sanitization helper ──────────────────────────────────────────────────────
// Strips every character that can't appear in normal prose to prevent
// injection attacks. We additionally always use textContent (never innerHTML)
// when inserting into the DOM, so this is defence-in-depth.
function sanitize(str) {
  return String(str || '')
    .trim()
    // Remove HTML tags (shouldn't be there but belt-and-suspenders)
    .replace(/<[^>]*>/g, '')
    // Remove control characters except \n (which we convert to spaces)
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
    .replace(/\n/g, ' ')
    .slice(0, CHAT_MAX_CHARS);
}

// ── Time formatting ──────────────────────────────────────────────────────────
function formatTime(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}:${m} ${ampm}`;
}

// ── Chat class ───────────────────────────────────────────────────────────────
export class Chat {
  /**
   * @param {object}          opts
   * @param {WatchTogetherClient} opts.client   — the connected WS client
   * @param {string}          opts.myName        — local user's display name
   * @param {function}        opts.getPeerName   — () => string  — friend's display name
   */
  constructor({ client, myName, getPeerName }) {
    this._client      = client;
    this._myName      = myName;
    this._getPeerName = getPeerName;

    // In-memory message log — survives panel toggle
    this._messages      = [];
    // Set of messageIds we've already rendered (dedup guard)
    this._seenIds       = new Set();
    // Whether the chat panel is currently visible
    this._open          = false;
    // Unread count (only increments when panel is closed)
    this._unread        = 0;

    // DOM refs — populated in _buildDOM()
    this._panel         = null;
    this._msgContainer  = null;
    this._input         = null;
    this._sendBtn       = null;
    this._chatToggleBtn = null;
    this._unreadDot     = null;

    this._wired = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Mount the chat button + panel into the watch screen. */
  mount() {
    if (this._wired) return;
    this._buildDOM();
    this._wireEvents();
    this._wired = true;
  }

  /** Wire the WS client listener — call once per session (after client connects). */
  wireClient(client) {
    this._client = client;
    this._client.on('chat_message', (data) => this._onIncoming(data));
  }

  /** Update the local user's name (called after name is known). */
  setMyName(name) {
    this._myName = name;
  }

  /** Reset all chat state — call on room leave / home navigation. */
  reset() {
    this._messages     = [];
    this._seenIds      = new Set();
    this._unread       = 0;
    this._open         = false;
    if (this._msgContainer) this._msgContainer.innerHTML = '';
    this._setUnreadDot(0);
    this._closePanel();
  }

  /** Programmatically open the chat panel. */
  open() {
    if (this._open) return;
    this._openPanel();
  }

  /** Programmatically close the chat panel. */
  close() {
    if (!this._open) return;
    this._closePanel();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    const watchScreen = document.getElementById('screen-watch');
    const reactions   = watchScreen?.querySelector('.reactions');
    if (!watchScreen) return;

    // ── Chat toggle button (appended below reactions) ───────────────────────
    const toggleBtn = document.createElement('button');
    toggleBtn.id        = 'chat-toggle-btn';
    toggleBtn.className = 'react-btn chat-toggle-btn';
    toggleBtn.title     = 'Chat';
    toggleBtn.setAttribute('aria-label', 'Open chat');
    // Chat bubble SVG icon
    toggleBtn.innerHTML = `
      <span class="chat-btn-inner">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
        </svg>
        <span class="chat-unread-dot" id="chat-unread-dot" aria-hidden="true"></span>
      </span>`;
    reactions?.appendChild(toggleBtn);

    this._chatToggleBtn = toggleBtn;
    this._unreadDot     = toggleBtn.querySelector('#chat-unread-dot');

    // ── Chat panel ──────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id        = 'chat-panel';
    panel.className = 'chat-panel';
    panel.setAttribute('aria-label', 'Chat panel');
    panel.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="opacity:.7">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
          </svg>
          Chat
        </span>
        <button class="chat-close-btn" id="chat-close-btn" aria-label="Close chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="chat-messages" id="chat-messages" role="log" aria-live="polite" aria-label="Messages"></div>
      <div class="chat-input-row">
        <input
          class="chat-input"
          id="chat-input"
          type="text"
          placeholder="Message…"
          maxlength="${CHAT_MAX_CHARS}"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
        />
        <button class="chat-send-btn" id="chat-send-btn" aria-label="Send message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>`;
    watchScreen.appendChild(panel);

    this._panel        = panel;
    this._msgContainer = panel.querySelector('#chat-messages');
    this._input        = panel.querySelector('#chat-input');
    this._sendBtn      = panel.querySelector('#chat-send-btn');

    // Close button inside panel header
    panel.querySelector('#chat-close-btn').addEventListener('click', () => this._closePanel());
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  _wireEvents() {
    // Toggle open/close on chat button
    this._chatToggleBtn?.addEventListener('click', () => {
      this._open ? this._closePanel() : this._openPanel();
    });

    // Send on button click
    this._sendBtn?.addEventListener('click', () => this._trySend());

    // Send on Enter (Shift+Enter does nothing — single-line chat)
    this._input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._trySend();
      }
    });

    // Typing activity — re-enable send button on input
    this._input?.addEventListener('input', () => {
      const hasText = (this._input.value.trim().length > 0);
      if (this._sendBtn) this._sendBtn.disabled = !hasText;
    });

    // Keyboard shortcut: Ctrl/Cmd+Shift+C to toggle chat from anywhere in watch screen
    document.addEventListener('keydown', (e) => {
      const watchActive = document.getElementById('screen-watch')?.classList.contains('active');
      if (!watchActive) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        this._open ? this._closePanel() : this._openPanel();
      }
    });
  }

  // ── Panel open / close ────────────────────────────────────────────────────

  _openPanel() {
    this._open = true;
    this._panel?.classList.add('open');
    document.getElementById('screen-watch')?.classList.add('chat-open');
    this._chatToggleBtn?.classList.add('active');
    this._chatToggleBtn?.setAttribute('aria-label', 'Close chat');
    // Clear unread on open
    this._unread = 0;
    this._setUnreadDot(0);
    // Scroll to bottom on open (user wants to see latest)
    requestAnimationFrame(() => this._scrollToBottom(true));
    // Focus input
    setTimeout(() => this._input?.focus(), 300);
  }

  _closePanel() {
    this._open = false;
    this._panel?.classList.remove('open');
    document.getElementById('screen-watch')?.classList.remove('chat-open');
    this._chatToggleBtn?.classList.remove('active');
    this._chatToggleBtn?.setAttribute('aria-label', 'Open chat');
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  _trySend() {
    if (!this._client) return;
    const raw  = this._input?.value ?? '';
    const text = sanitize(raw);
    if (!text) return;

    // Generate a local messageId so we can render optimistically and dedup later
    const messageId = this._client.sendChat(text);

    // Render immediately — don't wait for server echo (server never echoes
    // back to sender anyway, this is the canonical local render)
    this._appendMessage({
      messageId,
      fromPeerId: '__self__',  // sentinel — means "this is my own message"
      senderName: this._myName || 'You',
      text,
      timestamp: Date.now(),
      isSelf: true,
    });

    // Clear input and refocus
    if (this._input) { this._input.value = ''; this._input.focus(); }
    if (this._sendBtn) this._sendBtn.disabled = true;
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  _onIncoming(data) {
    // Dedup: the server may (theoretically) relay the same message twice on
    // reconnect edge cases. messageId is generated per-send so it's unique.
    if (this._seenIds.has(data.messageId)) return;

    this._appendMessage({
      messageId:  data.messageId,
      fromPeerId: data.fromPeerId,
      senderName: sanitize(data.senderName),
      text:       sanitize(data.text),
      timestamp:  data.timestamp || Date.now(),
      isSelf:     false,
    });

    // Show unread dot if panel is closed
    if (!this._open) {
      this._unread++;
      this._setUnreadDot(this._unread);
      // Also show a subtle toast so user notices without opening chat
      // (only if count is low — don't spam the toast for every message)
      if (this._unread <= 3 && typeof window._showChatToast === 'function') {
        window._showChatToast(`${sanitize(data.senderName)}: ${sanitize(data.text)}`);
      }
    }
  }

  // ── DOM append ────────────────────────────────────────────────────────────

  _appendMessage({ messageId, senderName, text, timestamp, isSelf }) {
    if (!this._msgContainer) return;

    // Track seen IDs
    this._seenIds.add(messageId);
    this._messages.push({ messageId, senderName, text, timestamp, isSelf });

    // Check scroll position BEFORE adding the new element
    const wasNearBottom = this._isNearBottom();

    // Build message element — all user content set via textContent (never innerHTML)
    const el      = document.createElement('div');
    el.className  = `chat-msg ${isSelf ? 'chat-msg--self' : 'chat-msg--peer'}`;
    el.dataset.id = messageId;

    const metaEl  = document.createElement('div');
    metaEl.className = 'chat-msg-meta';

    const nameEl  = document.createElement('span');
    nameEl.className = 'chat-msg-name';
    nameEl.textContent = isSelf ? 'You' : senderName; // safe — textContent

    const timeEl  = document.createElement('span');
    timeEl.className = 'chat-msg-time';
    timeEl.textContent = formatTime(timestamp);

    metaEl.appendChild(nameEl);
    metaEl.appendChild(timeEl);

    const textEl  = document.createElement('div');
    textEl.className = 'chat-msg-text';
    textEl.textContent = text; // safe — textContent, not innerHTML

    el.appendChild(metaEl);
    el.appendChild(textEl);

    this._msgContainer.appendChild(el);

    // Prune oldest messages from DOM if we've exceeded RENDER_BATCH_SIZE
    while (this._msgContainer.children.length > RENDER_BATCH_SIZE) {
      this._msgContainer.removeChild(this._msgContainer.firstChild);
    }

    // Auto-scroll only when user was already near the bottom
    if (wasNearBottom) this._scrollToBottom();
  }

  // ── Scroll helpers ────────────────────────────────────────────────────────

  _isNearBottom() {
    if (!this._msgContainer) return true;
    const { scrollTop, scrollHeight, clientHeight } = this._msgContainer;
    return (scrollHeight - scrollTop - clientHeight) <= SCROLL_THRESHOLD;
  }

  _scrollToBottom(instant = false) {
    if (!this._msgContainer) return;
    if (instant) {
      this._msgContainer.scrollTop = this._msgContainer.scrollHeight;
    } else {
      requestAnimationFrame(() => {
        if (this._msgContainer) {
          this._msgContainer.scrollTop = this._msgContainer.scrollHeight;
        }
      });
    }
  }

  // ── Unread dot ────────────────────────────────────────────────────────────

  _setUnreadDot(count) {
    if (!this._unreadDot) return;
    if (count > 0) {
      this._unreadDot.classList.add('visible');
      // Show count if > 1 so user knows how many they missed
      this._unreadDot.textContent = count > 9 ? '9+' : count > 1 ? String(count) : '';
    } else {
      this._unreadDot.classList.remove('visible');
      this._unreadDot.textContent = '';
    }
  }
}
