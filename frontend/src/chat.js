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
const CHAT_MAX_CHARS = 500;  // hard cap enforced client-side too
const SCROLL_THRESHOLD = 80;   // px from bottom — auto-scroll fires below this
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
   * @param {function}        opts.resolveParticipantName — (participantId, fallback) => string
   */
  constructor({ client, myName, getPeerName, resolveParticipantName }) {
    this._client = client;
    this._myName = myName;
    this._myParticipantId = null;
    this._getPeerName = getPeerName;
    this._resolveParticipantName = resolveParticipantName;

    // In-memory message log — survives panel toggle
    this._messages = [];
    // Set of messageIds we've already rendered (dedup guard)
    this._seenIds = new Set();
    // Whether the chat panel is currently visible
    this._open = false;
    // Unread count (only increments when panel is closed)
    this._unread = 0;

    // DOM refs — populated in _buildDOM()
    this._panel = null;
    this._msgContainer = null;
    this._msgFlow = null;
    this._msgStack = null;
    this._emptyState = null;
    this._input = null;
    this._sendBtn = null;
    this._chatToggleBtn = null;
    this._unreadDot = null;
    this._watchScreen = null;
    this._layoutObserver = null;
    this._boundSyncLayout = () => {
      this._syncPanelLayoutMode();
      this._syncPanelMetrics();
      this._syncMessageLayout();
    };

    this._wired = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Mount the chat button + panel into the watch screen. */
  mount() {
    if (this._wired) return;
    this._buildDOM();
    this._wireEvents();
    this._bindLayoutObservers();
    this._boundSyncLayout();
    this._wired = true;
  }

  /** Wire the WS client listener — call once per session (after client connects). */
  wireClient(client) {
    this._client = client;
    this.setMyParticipantId(client?.participantId || null);
    this._client.on('chat_message', (data) => this._onIncoming(data));
  }

  /** Update the local user's name (called after name is known). */
  setMyName(name) {
    this._myName = name;
  }

  setMyParticipantId(participantId) {
    this._myParticipantId = participantId ? String(participantId) : null;
  }

  syncParticipantName(participantId, nextName) {
    const safeParticipantId = String(participantId || '').trim();
    const safeName = sanitize(nextName);
    if (!safeParticipantId || !safeName || safeParticipantId === this._myParticipantId) return;

    this._messages = this._messages.map((message) => (
      message.participantId === safeParticipantId
        ? { ...message, senderName: safeName }
        : message
    ));

    this._msgContainer?.querySelectorAll('.chat-msg').forEach((messageEl) => {
      if (messageEl.dataset.participantId !== safeParticipantId) return;
      const nameEl = messageEl.querySelector('.chat-msg-name');
      if (!nameEl || messageEl.dataset.self === 'true') return;
      nameEl.textContent = safeName;
    });
  }

  /** Reset all chat state — call on room leave / home navigation. */
  reset() {
    this._messages = [];
    this._seenIds = new Set();
    this._unread = 0;
    this._open = false;
    if (this._msgStack) this._msgStack.innerHTML = '';
    if (this._msgContainer) this._msgContainer.scrollTop = 0;
    this._setUnreadDot(0);
    this._closePanel();
    this._boundSyncLayout();
  }

  /** Programmatically open the chat panel. */
  open() {
    if (this._open) return;
    void this._openPanel();
  }

  /** Programmatically close the chat panel. */
  close() {
    if (!this._open) return;
    this._closePanel();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    const watchScreen = document.getElementById('screen-watch');
    const reactions = watchScreen?.querySelector('.reactions');
    if (!watchScreen) return;
    this._watchScreen = watchScreen;

    // ── Chat toggle button (appended below reactions) ───────────────────────
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'chat-toggle-btn';
    toggleBtn.className = 'react-btn chat-toggle-btn';
    toggleBtn.title = 'Chat';
    toggleBtn.setAttribute('aria-label', 'Open chat');
    // Chat bubble SVG icon
    toggleBtn.innerHTML = `
      <span class="chat-btn-inner">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="grey">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
        </svg>
        <span class="chat-unread-dot" id="chat-unread-dot" aria-hidden="true"></span>
      </span>`;
    reactions?.appendChild(toggleBtn);

    this._chatToggleBtn = toggleBtn;
    this._unreadDot = toggleBtn.querySelector('#chat-unread-dot');

    // ── Chat panel ──────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id = 'chat-panel';
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
      <div class="chat-messages" id="chat-messages" role="log" aria-live="polite" aria-label="Messages" data-empty="true" data-layout="centered">
        <div class="chat-messages-flow" id="chat-messages-flow">
          <div class="chat-empty-state" id="chat-empty-state" aria-hidden="true">
            <div class="chat-empty-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
              </svg>
            </div>
            <p class="chat-empty-copy">Start chatting while you're watching 👀</p>
          </div>
          <div class="chat-message-stack" id="chat-message-stack"></div>
        </div>
      </div>
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

    this._panel = panel;
    this._msgContainer = panel.querySelector('#chat-messages');
    this._msgFlow = panel.querySelector('#chat-messages-flow');
    this._msgStack = panel.querySelector('#chat-message-stack');
    this._emptyState = panel.querySelector('#chat-empty-state');
    this._input = panel.querySelector('#chat-input');
    this._sendBtn = panel.querySelector('#chat-send-btn');

    // Close button inside panel header
    panel.querySelector('#chat-close-btn').addEventListener('click', () => this._closePanel());
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  _wireEvents() {
    // Toggle open/close on chat button
    this._chatToggleBtn?.addEventListener('click', () => {
      this._open ? this._closePanel() : void this._openPanel();
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
        this._open ? this._closePanel() : void this._openPanel();
      }
    });
  }

  // ── Panel open / close ────────────────────────────────────────────────────

  async _openPanel() {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // If fullscreen exit is blocked, continue opening chat rather than
        // leaving the toggle unresponsive.
      }
    }

    this._open = true;
    this._panel?.classList.add('open');
    this._watchScreen?.classList.add('chat-open');
    this._chatToggleBtn?.classList.add('active');
    this._chatToggleBtn?.setAttribute('aria-label', 'Close chat');
    // Clear unread on open
    this._unread = 0;
    this._setUnreadDot(0);
    // Scroll to bottom on open (user wants to see latest)
    requestAnimationFrame(() => {
      this._scrollToBottom(true);
      this._boundSyncLayout();
      document.getElementById('player-shell')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    // Focus input
    setTimeout(() => this._input?.focus(), 300);
  }

  _closePanel() {
    this._open = false;
    this._panel?.classList.remove('open');
    this._watchScreen?.classList.remove('chat-open');
    this._chatToggleBtn?.classList.remove('active');
    this._chatToggleBtn?.setAttribute('aria-label', 'Open chat');
    this._boundSyncLayout();
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  _trySend() {
    if (!this._client) return;
    const raw = this._input?.value ?? '';
    const text = sanitize(raw);
    if (!text) return;
    const participantId = this._myParticipantId || this._client.participantId || '__self__';

    // Generate a local messageId so we can render optimistically and dedup later
    const messageId = this._client.sendChat(text);

    // Render immediately — don't wait for server echo (server never echoes
    // back to sender anyway, this is the canonical local render)
    this._appendMessage({
      messageId,
      participantId,
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
    const participantId = String(data.participantId || data.fromPeerId || '').trim();
    const resolvedName = this._resolveName(participantId, data.senderName);

    this._appendMessage({
      messageId: data.messageId,
      participantId,
      senderName: resolvedName,
      text: sanitize(data.text),
      timestamp: data.timestamp || Date.now(),
      isSelf: false,
    });

    // Show unread dot if panel is closed
    if (!this._open) {
      this._unread++;
      this._setUnreadDot(this._unread);
      // Also show a subtle toast so user notices without opening chat
      // (only if count is low — don't spam the toast for every message)
      if (this._unread <= 3 && typeof window._showChatToast === 'function') {
        window._showChatToast(`${resolvedName}: ${sanitize(data.text)}`);
      }
    }
  }

  // ── DOM append ────────────────────────────────────────────────────────────

  _appendMessage({ messageId, participantId, senderName, text, timestamp, isSelf }) {
    if (!this._msgContainer || !this._msgStack) return;

    // Track seen IDs
    this._seenIds.add(messageId);
    this._messages.push({ messageId, participantId, senderName, text, timestamp, isSelf });

    // Check scroll position BEFORE adding the new element
    const wasNearBottom = this._isNearBottom();

    // Build message element — all user content set via textContent (never innerHTML)
    const el = document.createElement('div');
    el.className = `chat-msg ${isSelf ? 'chat-msg--self' : 'chat-msg--peer'}`;
    el.dataset.id = messageId;
    el.dataset.participantId = participantId || '';
    el.dataset.self = isSelf ? 'true' : 'false';

    const metaEl = document.createElement('div');
    metaEl.className = 'chat-msg-meta';

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-msg-name';
    nameEl.textContent = isSelf ? 'You' : this._resolveName(participantId, senderName);

    const timeEl = document.createElement('span');
    timeEl.className = 'chat-msg-time';
    timeEl.textContent = formatTime(timestamp);

    metaEl.appendChild(nameEl);
    metaEl.appendChild(timeEl);

    const textEl = document.createElement('div');
    textEl.className = 'chat-msg-text';
    textEl.textContent = text; // safe — textContent, not innerHTML

    el.appendChild(metaEl);
    el.appendChild(textEl);

    this._msgStack.appendChild(el);

    // Prune oldest messages from DOM if we've exceeded RENDER_BATCH_SIZE
    while (this._msgStack.children.length > RENDER_BATCH_SIZE) {
      this._msgStack.removeChild(this._msgStack.firstChild);
    }

    this._syncMessageLayout();

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

  _bindLayoutObservers() {
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', this._boundSyncLayout, { passive: true });
    if (!('ResizeObserver' in window) || this._layoutObserver) return;
    this._layoutObserver = new ResizeObserver(() => this._boundSyncLayout());
    [this._panel, this._msgContainer, this._msgFlow, this._msgStack].forEach((element) => {
      if (element) this._layoutObserver.observe(element);
    });
  }

  _syncPanelLayoutMode() {
    if (!this._watchScreen || typeof window === 'undefined') return;
    const shouldStack = window.innerWidth <= 820 && window.innerHeight > window.innerWidth;
    this._watchScreen.dataset.chatLayout = shouldStack ? 'stack' : 'split';
  }

  _syncPanelMetrics() {
    if (!this._watchScreen || !this._panel) return;
    const rect = this._panel.getBoundingClientRect();
    this._watchScreen.style.setProperty('--chat-panel-width', `${Math.round(rect.width)}px`);
    this._watchScreen.style.setProperty('--chat-panel-height', `${Math.round(rect.height)}px`);
  }

  _syncMessageLayout() {
    if (!this._msgContainer || !this._msgStack) return;
    const hasMessages = this._msgStack.childElementCount > 0;
    const contentHeight = hasMessages ? this._msgStack.scrollHeight : 0;
    const containerHeight = this._msgContainer.clientHeight;
    const shouldCenter = !hasMessages || contentHeight <= Math.max(containerHeight - 16, 0);

    this._msgContainer.dataset.empty = hasMessages ? 'false' : 'true';
    this._msgContainer.dataset.layout = shouldCenter ? 'centered' : 'stacked';
    this._emptyState?.setAttribute('aria-hidden', hasMessages ? 'true' : 'false');
    if (!hasMessages) this._msgContainer.scrollTop = 0;
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

  _resolveName(participantId, fallbackName = '') {
    const safeParticipantId = String(participantId || '').trim();
    if (safeParticipantId && safeParticipantId === this._myParticipantId) {
      return sanitize(this._myName) || 'You';
    }

    const resolved = this._resolveParticipantName?.(
      safeParticipantId,
      fallbackName || this._getPeerName?.() || 'Guest'
    );
    return sanitize(resolved || fallbackName || this._getPeerName?.() || 'Guest') || 'Guest';
  }
}
