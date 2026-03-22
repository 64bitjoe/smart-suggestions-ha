/**
 * Smart Suggestions Card
 * AI-powered contextual action suggestions for Home Assistant
 * Drop in /config/www/smart-suggestions-card.js
 */

const CARD_VERSION = "1.1.0";

const DOMAIN_ICONS = {
  light: "mdi:lightbulb",
  switch: "mdi:toggle-switch",
  climate: "mdi:thermostat",
  media_player: "mdi:cast",
  cover: "mdi:window-shutter",
  fan: "mdi:fan",
  lock: "mdi:lock",
  vacuum: "mdi:robot-vacuum",
  camera: "mdi:camera",
  automation: "mdi:robot",
  script: "mdi:script-text",
  scene: "mdi:palette",
  input_boolean: "mdi:toggle-switch",
};

// iOS system colour palette — one per domain
const DOMAIN_COLORS = {
  light:         "#FF9F0A",
  switch:        "#007AFF",
  climate:       "#FF6B35",
  media_player:  "#FF2D55",
  cover:         "#34C759",
  fan:           "#30D5C8",
  lock:          "#8E8E93",
  vacuum:        "#007AFF",
  camera:        "#8E8E93",
  automation:    "#AF52DE",
  script:        "#5E5CE6",
  scene:         "#BF5AF2",
  input_boolean: "#007AFF",
};

class SmartSuggestionsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._expandedIndex = null;
    this._isRefreshing = false;
    this._lastStateStr = null;
    // Add-on WebSocket state
    this._ws = null;
    this._wsConnected = false;
    this._wsSuggestions = [];
    this._wsRetryTimeout = null;
    this._wsEnabled = false;
    this._wsRetryDelay = 5000;
    this._pendingAutomation = false;
  }

  setConfig(config) {
    // Spread raw config first, then apply defaults for any missing keys
    const c = { ...config };
    this._config = {
      entity:                  c.entity                  ?? "smart_suggestions.suggestions",
      title:                   c.title                   !== undefined ? c.title : "Suggested for You",
      show_title:              c.show_title              !== false,
      show_refresh:            c.show_refresh            !== false,
      show_last_updated:       c.show_last_updated       !== false,
      accent_color:            c.accent_color            || null,
      empty_message:           c.empty_message           || "Thinking of suggestions…",
      addon_url:               c.addon_url               || null,
      compact:                 c.compact                 === true,
      max_visible:             parseInt(c.max_visible)   || 0,
      tap_action:              c.tap_action              || "execute",
      show_feedback:           c.show_feedback           !== false,
      show_section_headers:    c.show_section_headers    !== false,
    };
    this._render();
    // Try to connect to the add-on WebSocket if a URL is configured
    // or auto-detect via HA ingress slug
    if (!this._wsEnabled) {
      this._wsEnabled = true;
      this._connectWS();
    }
  }

  disconnectedCallback() {
    this._wsEnabled = false;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    if (this._wsRetryTimeout) {
      clearTimeout(this._wsRetryTimeout);
      this._wsRetryTimeout = null;
    }
  }

  _getAddonWsUrl() {
    // Explicit URL from card config takes priority
    if (this._config.addon_url) {
      const base = this._config.addon_url.replace(/\/$/, "");
      return base.replace(/^http/, "ws") + "/ws";
    }
    // Auto-detect: try the standard ingress path for the slug "smart_suggestions"
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/api/hassio_ingress/smart_suggestions/ws`;
  }

  _connectWS() {
    if (!this._wsEnabled) return;
    const url = this._getAddonWsUrl();
    try {
      const ws = new WebSocket(url);
      this._ws = ws;

      ws.addEventListener("open", () => {
        this._wsConnected = true;
        console.info("[SmartSuggestions] Add-on WebSocket connected");
      });

      ws.addEventListener("message", (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        this._handleWsMessage(msg);
      });

      ws.addEventListener("close", () => {
        this._wsConnected = false;
        this._ws = null;
        this._pendingAutomation = false;
        if (this._wsEnabled) {
          // Retry with exponential backoff capped at 30s
          this._wsRetryTimeout = setTimeout(() => this._connectWS(), this._wsRetryDelay);
          this._wsRetryDelay = Math.min(30000, this._wsRetryDelay * 2);
        }
      });

      ws.addEventListener("error", () => {
        // Silently fall back to HA state polling — add-on may not be installed
        ws.close();
      });
    } catch (_) {
      // WebSocket constructor failed (e.g. invalid URL) — just use fallback
    }
  }

  _handleWsMessage(msg) {
    switch (msg.type) {
      case "suggestions": {
        this._isRefreshing = false;
        // Directly inject suggestions — bypasses HA state polling
        this._wsSuggestions = Array.isArray(msg.data) ? msg.data : [];
        this._render();
        break;
      }
      case "status": {
        const isUpdating = msg.state === "updating";
        if (isUpdating !== this._isRefreshing) {
          this._isRefreshing = isUpdating;
          this._render();
        }
        break;
      }
      case "automation_result": {
        this._pendingAutomation = false;
        this._render();  // re-enable buttons first
        if (msg.success) {
          this._showToast("Automation created!");
        } else {
          this._showYamlFallback(msg.yaml || "", msg.error || "Unknown error");
        }
        break;
      }
    }
  }

  set hass(hass) {
    this._hass = hass;
    const state = hass.states[this._config.entity];
    const stateStr = JSON.stringify(state?.attributes?.suggestions) + state?.state;
    if (stateStr !== this._lastStateStr) {
      this._lastStateStr = stateStr;
      this._render();
    }
  }

  _getSuggestions() {
    // Prefer live suggestions pushed from add-on WebSocket
    let suggestions;
    if (this._wsConnected && Array.isArray(this._wsSuggestions) && this._wsSuggestions.length) {
      suggestions = this._wsSuggestions;
    } else {
      // Fallback: read from HA state (works without the add-on)
      if (!this._hass) return [];
      const state = this._hass.states[this._config.entity];
      if (!state) return [];
      const s = state.attributes.suggestions;
      suggestions = Array.isArray(s) ? s : [];
    }
    const max = this._config.max_visible;
    return max > 0 ? suggestions.slice(0, max) : suggestions;
  }

  _getStatus() {
    // When the WebSocket is connected, use its status
    if (this._wsConnected) {
      return this._isRefreshing ? "updating" : "ready";
    }
    if (!this._hass) return "idle";
    return this._hass.states[this._config.entity]?.state || "idle";
  }

  _getLastUpdated() {
    if (!this._hass) return null;
    const lu = this._hass.states[this._config.entity]?.attributes?.last_updated;
    return lu ? new Date(lu) : null;
  }

  _formatRelativeTime(date) {
    if (!date) return "";
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleDateString();
  }

  _resolveIcon(suggestion) {
    const eid = suggestion.entity_id;
    const state = eid && this._hass ? this._hass.states[eid] : null;
    // 1. Custom icon set in HA entity registry / customization
    if (state?.attributes?.icon) return state.attributes.icon;
    // 2. Ollama-provided icon — validate it's a real mdi: string
    const sugIcon = suggestion.icon;
    if (sugIcon && typeof sugIcon === "string" && sugIcon.startsWith("mdi:") && sugIcon.length > 5) {
      return sugIcon;
    }
    // 3. State-based icons for common entities
    if (state && eid) {
      const domain = eid.split(".")[0];
      const s = state.state;
      if (domain === "light")        return s === "on" ? "mdi:lightbulb" : "mdi:lightbulb-outline";
      if (domain === "switch")       return s === "on" ? "mdi:toggle-switch" : "mdi:toggle-switch-off-outline";
      if (domain === "cover") {
        const pos = state.attributes?.current_position;
        return pos > 0 ? "mdi:window-shutter-open" : "mdi:window-shutter";
      }
      if (domain === "media_player") return s === "playing" ? "mdi:cast-connected" : "mdi:cast";
      if (domain === "lock")         return s === "locked" ? "mdi:lock" : "mdi:lock-open";
      if (domain === "fan")          return s === "on" ? "mdi:fan" : "mdi:fan-off";
      if (domain === "vacuum")       return s === "cleaning" ? "mdi:robot-vacuum" : "mdi:robot-vacuum-variant";
    }
    // 4. Domain fallback
    if (eid) return DOMAIN_ICONS[eid.split(".")[0]] || "mdi:star-circle";
    return "mdi:star-circle";
  }

  _resolveEntityPicture(suggestion) {
    const eid = suggestion.entity_id;
    const pic = eid && this._hass ? this._hass.states[eid]?.attributes?.entity_picture : null;
    return pic || null;
  }

  async _callAction(suggestion) {
    if (!this._hass) return;
    const { entity_id, action, action_data, type } = suggestion;

    // Navigate actions don't need an entity
    if (action === "navigate" && action_data?.path) {
      history.pushState(null, "", action_data.path);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }

    if (!entity_id) {
      console.warn("[SmartSuggestions] Suggestion has no entity_id — skipping", suggestion);
      return;
    }

    const domain = entity_id.split(".")[0];

    // Guard: entity must exist in HA before calling a service
    if (!this._hass.states[entity_id] && domain !== "scene" && domain !== "script" && domain !== "automation") {
      console.warn("[SmartSuggestions] Entity not in HA states — skipping:", entity_id);
      return;
    }

    try {
      if (domain === "scene") {
        await this._hass.callService("scene", "turn_on", { entity_id });
        this._flashRow(entity_id);
        return;
      }
      if (domain === "automation" || type === "automation") {
        await this._hass.callService("automation", "trigger", { entity_id });
        return;
      }
      if (domain === "script" || type === "script") {
        await this._hass.callService("script", "turn_on", { entity_id });
        return;
      }
      const svc = action || "toggle";
      await this._hass.callService(domain, svc, {
        entity_id,
        ...(action_data || {}),
      });
      this._flashRow(entity_id);
    } catch (e) {
      console.error("[SmartSuggestions] Action failed:", e);
    }
  }

  _showMoreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      bubbles: true,
      composed: true,
      detail: { entityId },
    }));
  }

  _flashRow(entityId) {
    const row = this.shadowRoot.querySelector(`[data-entity="${CSS.escape(entityId)}"]`);
    if (!row) return;
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 700);
  }

  _triggerRefresh() {
    if (this._isRefreshing) return;
    this._isRefreshing = true;
    this._render();
    // The add-on drives its own refresh cycle — just show a brief spin
    setTimeout(() => {
      this._isRefreshing = false;
      this._render();
    }, 3000);
  }

  _toggleExpand(index) {
    this._expandedIndex = this._expandedIndex === index ? null : index;
    this._render();
  }

  _showToast(message) {
    // Remove any existing toast
    const existing = this.shadowRoot.querySelector(".toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    // Append to shadow root host level so it overlays the card
    this.shadowRoot.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = "opacity 0.3s";
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 320);
    }, 3000);
  }

  _showYamlFallback(yaml, error) {
    // Remove any existing modal
    const existing = this.shadowRoot.querySelector(".yaml-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "yaml-overlay";
    overlay.innerHTML = `
      <div class="yaml-drawer">
        <div class="yaml-header">
          <span class="yaml-title">Save as Automation</span>
          <button class="yaml-close" id="yaml-close-btn">&times;</button>
        </div>
        <div class="yaml-error">${this._escapeHtml(error)}</div>
        <pre class="yaml-pre">${this._escapeHtml(yaml)}</pre>
        <button class="yaml-copy-btn" id="yaml-copy-btn">Copy YAML</button>
      </div>
    `;
    this.shadowRoot.appendChild(overlay);

    overlay.querySelector("#yaml-close-btn").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#yaml-copy-btn").addEventListener("click", () => {
      navigator.clipboard.writeText(yaml).then(() => {
        const btn = overlay.querySelector("#yaml-copy-btn");
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy YAML"; }, 2000);
      }).catch(() => {});
    });
  }

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async _sendFeedback(entityId, vote) {
    const btn = this.shadowRoot.querySelector(
      `[data-feedback-eid="${CSS.escape(entityId)}"][data-vote="${vote}"]`
    );
    if (btn) {
      btn.classList.add("pop", vote === "up" ? "voted-up" : "voted-down");
      setTimeout(() => btn.classList.remove("pop"), 300);
    }
    const base = this._config.addon_url
      ? this._config.addon_url.replace(/\/$/, "")
      : `/api/hassio_ingress/smart_suggestions`;
    try {
      await fetch(`${base}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId, vote }),
      });
    } catch (e) { console.warn("[SmartSuggestions] Feedback failed:", e); }
  }

  _getActionLabel(action) {
    const map = {
      turn_on: "Turn On",
      turn_off: "Turn Off",
      toggle: "Toggle",
      trigger: "Trigger",
      navigate: "Go To",
    };
    return map[action] || action;
  }

  _getActionDot(action) {
    const map = {
      turn_on: "#4ade80",
      turn_off: "#f87171",
      toggle: "#60a5fa",
      trigger: "#a78bfa",
      navigate: "#fb923c",
    };
    return map[action] || "#94a3b8";
  }

  _render() {
    try {
      this._renderInner();
    } catch (e) {
      console.error("[SmartSuggestions] Render error:", e);
      this.shadowRoot.innerHTML = `<ha-card style="padding:16px;color:var(--error-color,#f44336)">
        Smart Suggestions render error — check browser console for details.
      </ha-card>`;
    }
  }

  _renderInner() {
    const accent = this._config.accent_color || "#007AFF";
    const suggestions = this._getSuggestions();
    const status = this._getStatus();
    const isUpdating = status === "updating" || this._isRefreshing;
    const lastUpdated = this._getLastUpdated();

    const styles = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :host { display: block; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif; }
      .card { background: var(--ha-card-background, #1C1C1E); border-radius: 16px; overflow: hidden; }

      /* ── Header ── */
      .header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 12px; }
      .header-left { display: flex; align-items: center; gap: 9px; }
      .header-icon { width: 30px; height: 30px; border-radius: 8px; background: ${accent}; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .header-icon ha-icon { --mdc-icon-size: 17px; color: #fff; }
      .header-text { display: flex; flex-direction: column; }
      .title { font-size: 15px; font-weight: 600; color: var(--primary-text-color, #fff); letter-spacing: -0.3px; line-height: 1.2; }
      .subtitle { font-size: 12px; color: var(--secondary-text-color, #8E8E93); margin-top: 1px; display: flex; align-items: center; gap: 4px; }
      .header-right { display: flex; align-items: center; gap: 4px; }
      .refresh-btn { background: none; border: none; cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; color: ${accent}; -webkit-tap-highlight-color: transparent; border-radius: 50%; }
      .refresh-btn ha-icon { --mdc-icon-size: 20px; }
      .refresh-btn.spinning ha-icon { animation: spin 1s linear infinite; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

      /* ── Typing dots ── */
      .typing-dots span { display: inline-block; width: 3px; height: 3px; border-radius: 50%; background: ${accent}; margin: 0 1px; animation: tdot 1.2s ease-in-out infinite; vertical-align: middle; }
      .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
      .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes tdot { 0%,80%,100% { transform: translateY(0); opacity: 0.35; } 40% { transform: translateY(-2px); opacity: 1; } }

      /* ── Sections ── */
      .sections { margin: 0 12px 14px; }
      .section-header { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--secondary-text-color, #8E8E93); padding: 10px 2px 5px; }
      .sections > .section-header:first-child { padding-top: 0; }

      /* ── Inset grouped list ── */
      .list-wrap { border-radius: 12px; overflow: hidden; background: rgba(255,255,255,0.07); margin-bottom: 6px; }
      .sections .list-wrap:last-child { margin-bottom: 0; }

      /* ── Row ── */
      .row { display: flex; flex-direction: column; position: relative; }
      .row + .row .row-main::before { content: ''; position: absolute; top: 0; left: 62px; right: 0; height: 0.5px; background: rgba(255,255,255,0.09); }
      .row-main { display: flex; align-items: center; padding: 10px 12px 10px 14px; min-height: 56px; cursor: pointer; gap: 12px; user-select: none; -webkit-tap-highlight-color: transparent; position: relative; transition: background 0.12s; }
      .row-main:active { background: rgba(255,255,255,0.07); }

      /* ── Domain icon ── */
      .icon-wrap { width: 36px; height: 36px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; }
      .icon-wrap ha-icon { --mdc-icon-size: 20px; color: #fff; }

      /* ── Row text ── */
      .row-text { flex: 1; min-width: 0; }
      .row-name { font-size: 15px; font-weight: 400; color: var(--primary-text-color, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
      .row-sub { font-size: 12px; color: var(--secondary-text-color, #8E8E93); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      /* ── Info button ── */
      .info-btn { width: 30px; height: 30px; border-radius: 50%; background: none; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: ${accent}; opacity: 0.65; -webkit-tap-highlight-color: transparent; flex-shrink: 0; transition: opacity 0.15s; }
      .info-btn:active, .info-btn.active { opacity: 1; }
      .info-btn ha-icon { --mdc-icon-size: 19px; }

      /* ── Reason expansion ── */
      .reason-panel { overflow: hidden; max-height: 0; transition: max-height 0.28s cubic-bezier(0.4,0,0.2,1); }
      .reason-panel.open { max-height: 150px; }
      .reason-inner { padding: 8px 14px 13px 62px; font-size: 13px; line-height: 1.55; color: var(--secondary-text-color, #8E8E93); border-top: 0.5px solid rgba(255,255,255,0.07); }

      /* ── Flash ── */
      .row.flash .row-main { animation: flash-row 0.6s ease; }
      @keyframes flash-row { 0% { background: rgba(52,199,89,0); } 25% { background: rgba(52,199,89,0.14); } 100% { background: rgba(52,199,89,0); } }

      /* ── Compact mode ── */
      .row-main.compact { padding: 6px 10px 6px 12px; min-height: 44px; gap: 10px; }
      .row-main.compact .icon-wrap { width: 30px; height: 30px; border-radius: 8px; }
      .row-main.compact .icon-wrap ha-icon { --mdc-icon-size: 17px; }
      .row-main.compact .row-name { font-size: 13.5px; }
      .row-main.compact .row-sub { font-size: 11px; }

      /* ── Confidence label ── */
      .confidence-label { display:inline-block; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; padding:1px 6px; border-radius:20px; background:rgba(255,255,255,0.08); color:var(--secondary-text-color,#8E8E93); margin-top:2px; white-space:nowrap; }
      .confidence-label.high { background:rgba(52,199,89,0.15); color:#34C759; }
      .confidence-label.medium { background:rgba(255,159,10,0.15); color:#FF9F0A; }
      .confidence-label.low { background:rgba(142,142,147,0.12); color:#8E8E93; }

      /* ── Scene cards ── */
      .scene-list-wrap { border-radius: 12px; overflow: hidden; background: rgba(191,90,242,0.10); border: 1px solid rgba(191,90,242,0.22); margin-bottom: 10px; }
      .scene-list-wrap .row-main { padding: 12px 12px 12px 14px; min-height: 62px; }
      .scene-list-wrap .row-name { font-size: 15.5px; font-weight: 500; }
      .save-automation-btn { display:flex; align-items:center; gap:4px; margin:0 14px 12px 62px; padding:7px 14px; background:rgba(191,90,242,0.18); border:1px solid rgba(191,90,242,0.35); border-radius:9px; color:#BF5AF2; font-size:13px; font-weight:600; cursor:pointer; -webkit-tap-highlight-color:transparent; transition:background 0.15s,opacity 0.15s; width:fit-content; }
      .save-automation-btn ha-icon { --mdc-icon-size:15px; }
      .save-automation-btn:active { background:rgba(191,90,242,0.28); }
      .save-automation-btn:disabled { opacity:0.45; cursor:default; }

      /* ── Vote buttons ── */
      .feedback-area { display:flex; gap:2px; align-items:center; flex-shrink:0; }
      .vote-btn { width:28px; height:28px; border-radius:50%; background:none; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--secondary-text-color,#8E8E93); opacity:0.5; transition:opacity 0.15s,color 0.15s; -webkit-tap-highlight-color:transparent; }
      .vote-btn ha-icon { --mdc-icon-size:15px; }
      .vote-btn.voted-up { color:#34C759; opacity:1; }
      .vote-btn.voted-down { color:#FF3B30; opacity:1; }
      @keyframes vote-pop { 0%{transform:scale(1)} 40%{transform:scale(1.4)} 100%{transform:scale(1)} }
      .vote-btn.pop { animation:vote-pop 0.25s ease; }

      /* ── Toast ── */
      .toast { position:fixed; bottom:32px; left:50%; transform:translateX(-50%) translateY(0); background:rgba(30,30,32,0.95); color:#fff; font-size:14px; font-weight:500; padding:10px 20px; border-radius:24px; box-shadow:0 4px 20px rgba(0,0,0,0.45); z-index:9999; pointer-events:none; animation:toast-in 0.22s ease; }
      @keyframes toast-in { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }

      /* ── YAML modal ── */
      .yaml-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:9998; display:flex; align-items:flex-end; justify-content:center; }
      .yaml-drawer { background:#1C1C1E; border-radius:20px 20px 0 0; width:100%; max-width:600px; padding:20px 18px 32px; box-shadow:0 -4px 40px rgba(0,0,0,0.5); }
      .yaml-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      .yaml-title { font-size:16px; font-weight:700; color:var(--primary-text-color,#fff); }
      .yaml-close { background:none; border:none; color:var(--secondary-text-color,#8E8E93); cursor:pointer; font-size:22px; line-height:1; padding:0 2px; }
      .yaml-error { font-size:12px; color:#FF3B30; margin-bottom:10px; }
      .yaml-pre { background:rgba(255,255,255,0.06); border-radius:10px; padding:12px; overflow:auto; max-height:260px; font-size:12px; font-family:ui-monospace,monospace; color:#e2e8f0; white-space:pre; }
      .yaml-copy-btn { margin-top:12px; width:100%; padding:11px; background:rgba(255,255,255,0.09); border:1px solid rgba(255,255,255,0.13); border-radius:10px; color:var(--primary-text-color,#fff); font-size:14px; font-weight:600; cursor:pointer; }
      .yaml-copy-btn:active { background:rgba(255,255,255,0.16); }

      /* ── Empty ── */
      .empty { padding: 36px 20px; text-align: center; color: var(--secondary-text-color, #8E8E93); font-size: 14px; }
      .empty ha-icon { --mdc-icon-size: 38px; display: block; margin: 0 auto 10px; opacity: 0.22; }

      /* ── Skeleton ── */
      .skel-wrap { margin: 0 12px 14px; border-radius: 12px; overflow: hidden; background: rgba(255,255,255,0.07); }
      .skeleton { display: flex; align-items: center; gap: 12px; padding: 10px 14px; min-height: 56px; }
      .skeleton + .skeleton { border-top: 0.5px solid rgba(255,255,255,0.06); }
      .skel-icon { width: 36px; height: 36px; border-radius: 9px; background: rgba(255,255,255,0.1); animation: shimmer 1.4s ease-in-out infinite; flex-shrink: 0; }
      .skel-lines { flex: 1; }
      .skel-line { height: 11px; border-radius: 6px; background: rgba(255,255,255,0.1); animation: shimmer 1.4s ease-in-out infinite; margin-bottom: 7px; }
      .skel-line.short { width: 55%; margin-bottom: 0; }
      @keyframes shimmer { 0%,100% { opacity: 0.35; } 50% { opacity: 0.65; } }
    `;

    const subtitleHtml = isUpdating
      ? `<span class="typing-dots"><span></span><span></span><span></span></span> Thinking…`
      : this._config.show_last_updated && lastUpdated
        ? `Updated ${this._formatRelativeTime(lastUpdated)}`
        : `Based on current context`;

    const headerHtml = this._config.show_title ? `
      <div class="header">
        <div class="header-left">
          <div class="header-icon"><ha-icon icon="${this._config.icon || 'mdi:sparkles'}"></ha-icon></div>
          <div class="header-text">
            <div class="title">${this._config.title}</div>
            <div class="subtitle">${subtitleHtml}</div>
          </div>
        </div>
        <div class="header-right">
          ${this._config.show_refresh ? `
            <button class="refresh-btn ${isUpdating ? "spinning" : ""}" id="refresh-btn">
              <ha-icon icon="mdi:arrow.clockwise" onerror="this.setAttribute('icon','mdi:refresh')"></ha-icon>
            </button>
          ` : ""}
        </div>
      </div>
    ` : "";

    let bodyHtml = "";

    if (isUpdating && suggestions.length === 0) {
      bodyHtml = `<div class="skel-wrap">` + Array(4).fill(0).map(() => `
        <div class="skeleton">
          <div class="skel-icon"></div>
          <div class="skel-lines"><div class="skel-line"></div><div class="skel-line short"></div></div>
        </div>
      `).join("") + `</div>`;
    } else if (suggestions.length === 0) {
      bodyHtml = `<div class="empty"><ha-icon icon="mdi:shimmer"></ha-icon>${this._config.empty_message}</div>`;
    } else {
      // Confidence label helper
      const confidenceLabel = (s) => {
        const score = s.score ?? 50;
        const conf = s.confidence;
        let level, text;
        if (conf === "high" || score >= 70) { level = "high"; text = "High confidence"; }
        else if (conf === "medium" || score >= 40) { level = "medium"; text = "Pattern match"; }
        else { level = "low"; text = "Contextual"; }
        return `<span class="confidence-label ${level}">${text}</span>`;
      };

      const makeRow = (s, i, isScene) => {
        const icon = this._resolveIcon(s);
        const picture = this._resolveEntityPicture(s);
        const domain = s.entity_id?.split(".")[0] || "";
        const iconColor = isScene ? DOMAIN_COLORS["scene"] : (DOMAIN_COLORS[domain] || "#8E8E93");
        const actionLabel = this._getActionLabel(s.action);
        const isExpanded = this._expandedIndex === i;
        let subText = actionLabel;
        if (s.entity_id && this._hass) {
          const st = this._hass.states[s.entity_id];
          if (st && domain !== "automation" && domain !== "script" && domain !== "scene") {
            subText = `${actionLabel} · ${st.state}`;
          }
        }
        const iconInner = picture
          ? `<img src="${picture}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
          : `<ha-icon icon="${icon}"></ha-icon>`;
        const iconBg = picture ? "transparent" : iconColor;
        const compactClass = this._config.compact ? " compact" : "";
        const feedbackHtml = this._config.show_feedback ? `
              <div class="feedback-area">
                <button class="vote-btn" data-feedback-eid="${s.entity_id || ""}" data-vote="up" title="More like this">
                  <ha-icon icon="mdi:thumb-up-outline"></ha-icon>
                </button>
                <button class="vote-btn" data-feedback-eid="${s.entity_id || ""}" data-vote="down" title="Less like this">
                  <ha-icon icon="mdi:thumb-down-outline"></ha-icon>
                </button>
              </div>` : "";

        const saveAutomationHtml = (isScene && s.can_save_as_automation === true) ? `
          <button class="save-automation-btn" data-save-automation="${i}" ${this._pendingAutomation ? "disabled" : ""}>
            <ha-icon icon="mdi:robot-outline"></ha-icon> Save as Automation
          </button>` : "";

        return `
          <div class="row" data-entity="${s.entity_id || ""}" data-index="${i}">
            <div class="row-main${compactClass}" data-action="${i}">
              <div class="icon-wrap" data-more-info="${s.entity_id || ""}" style="background:${iconBg}">
                ${iconInner}
              </div>
              <div class="row-text">
                <div class="row-name">${s.name || s.entity_id}</div>
                <div class="row-sub">${subText}</div>
                ${confidenceLabel(s)}
              </div>
              ${feedbackHtml}
              <button class="info-btn ${isExpanded ? "active" : ""}" data-info="${i}">
                <ha-icon icon="mdi:information-outline"></ha-icon>
              </button>
            </div>
            ${saveAutomationHtml}
            <div class="reason-panel ${isExpanded ? "open" : ""}">
              <div class="reason-inner">${s.reason || "No reason provided."}</div>
            </div>
          </div>
        `;
      };

      const buckets = { scene: [], suggested: [], stretch: [] };
      suggestions.forEach((s, i) => {
        const domain = s.entity_id?.split(".")[0] || "";
        const isSceneType = s.type === "scene" || domain === "scene";
        const key = (s.section && buckets[s.section] !== undefined)
          ? s.section
          : isSceneType ? "scene" : "suggested";
        buckets[key].push({ s, i });
      });

      // Scenes rendered first with distinct card style, then other suggestions
      const sectionDefs = [
        { key: "scene",     label: "Scenes",             isScene: true  },
        { key: "suggested", label: "Suggested for You",  isScene: false },
        { key: "stretch",   label: "Worth Trying",       isScene: false },
      ];

      const sectionsHtml = sectionDefs
        .filter(({ key }) => buckets[key].length > 0)
        .map(({ key, label, isScene }) => {
          const wrapClass = isScene ? "scene-list-wrap" : "list-wrap";
          return `
            ${this._config.show_section_headers ? `<div class="section-header">${label}</div>` : ""}
            <div class="${wrapClass}">${buckets[key].map(({ s, i }) => makeRow(s, i, isScene)).join("")}</div>
          `;
        }).join("");

      bodyHtml = `<div class="sections">${sectionsHtml}</div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <ha-card class="card">${headerHtml}${bodyHtml}</ha-card>
    `;
    this._attachListeners();
  }

  _attachListeners() {
    const refreshBtn = this.shadowRoot.querySelector("#refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", (e) => { e.stopPropagation(); this._triggerRefresh(); });
    }
    // Row tap — behaviour controlled by tap_action config
    this.shadowRoot.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-info]") || e.target.closest("[data-more-info]") || e.target.closest("[data-feedback-eid]")) return;
        const index = parseInt(el.dataset.action);
        const suggestions = this._getSuggestions();
        const s = suggestions[index];
        if (!s) return;
        const action = this._config.tap_action;
        if (action === "more-info") {
          if (s.entity_id) this._showMoreInfo(s.entity_id);
        } else if (action === "expand") {
          this._toggleExpand(index);
        } else {
          this._callAction(s);
        }
      });
    });
    // Vote buttons
    this.shadowRoot.querySelectorAll("[data-feedback-eid]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._sendFeedback(btn.dataset.feedbackEid, btn.dataset.vote);
      });
    });
    // Icon tap / long press → more-info popup
    this.shadowRoot.querySelectorAll("[data-more-info]").forEach((el) => {
      const handler = (e) => {
        e.stopPropagation();
        const eid = el.dataset.moreInfo;
        if (eid) this._showMoreInfo(eid);
      };
      el.addEventListener("click", handler);
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); handler(e); });
    });
    // Info button → expand reason
    this.shadowRoot.querySelectorAll("[data-info]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this._toggleExpand(parseInt(el.dataset.info));
      });
    });
    // Save as Automation buttons
    this.shadowRoot.querySelectorAll("[data-save-automation]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this._pendingAutomation) return;
        const index = parseInt(btn.dataset.saveAutomation);
        const suggestions = this._getSuggestions();
        const s = suggestions[index];
        if (!s || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        this._pendingAutomation = true;
        btn.disabled = true;
        this._ws.send(JSON.stringify({ type: "save_automation", suggestion: s }));
      });
    });
  }

  getCardSize() {
    return Math.max(2, Math.ceil(this._getSuggestions().length * 0.7) + 1);
  }

  static getConfigElement() {
    return document.createElement("smart-suggestions-card-editor");
  }

  static getStubConfig() {
    return { entity: "smart_suggestions.suggestions", title: "Suggested for You" };
  }
}

customElements.define("smart-suggestions-card", SmartSuggestionsCard);

class SmartSuggestionsCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._domBuilt = false;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._domBuilt && Object.keys(this._config).length) {
      this._render();
    } else {
      // Just update the entity picker in-place — never re-build DOM here
      const picker = this.shadowRoot?.querySelector("ha-entity-picker");
      if (picker) picker.hass = hass;
    }
  }

  _fire(config) {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _setValue(key, value) {
    // No-op guard: prevents picker re-fire loops and unnecessary config-changed events
    if (this._config[key] === value) return;
    this._config = { ...this._config, [key]: value };
    this._fire(this._config);
  }

  // Returns true if el or any descendant within the shadow root is focused
  _hasFocus(el) {
    if (!el) return false;
    const active = this.shadowRoot.activeElement;
    return active === el || el.contains(active);
  }

  _render() {
    if (!this._domBuilt) {
      this._buildDOM();
      this._attachListeners();
      this._domBuilt = true;
    }
    this._syncFields();
  }

  _buildDOM() {
    this.shadowRoot.innerHTML = `
      <style>
        .editor { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; }
        .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--secondary-text-color); margin-bottom: -6px; }
        ha-textfield, ha-icon-picker { width: 100%; }
        .native-select-wrap { display:flex; flex-direction:column; gap:4px; }
        .native-select-label { font-size:12px; color:var(--secondary-text-color); }
        .native-select { width:100%; background:var(--input-fill-color,rgba(0,0,0,0.06)); color:var(--primary-text-color,#fff); border:1px solid var(--divider-color,rgba(0,0,0,0.12)); border-radius:4px; padding:10px 12px; font-size:14px; outline:none; cursor:pointer; }
        .toggle-row { display: flex; align-items: center; justify-content: space-between; height: 40px; }
        .toggle-label { font-size: 14px; color: var(--primary-text-color); }
        .toggle-hint { font-size: 12px; color: var(--secondary-text-color); margin-top: 1px; }
        .color-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .color-row label { font-size: 14px; color: var(--primary-text-color); flex: 1; }
        .color-row input[type="color"] { width: 44px; height: 32px; border: 1px solid var(--divider-color); border-radius: 8px; padding: 2px; cursor: pointer; background: none; }
        .color-clear { font-size: 12px; color: var(--secondary-text-color); cursor: pointer; text-decoration: underline; }
      </style>
      <div class="editor">
        <div class="section-title">Data</div>
        <ha-entity-picker id="entity" label="Suggestions entity" allow-custom-entity></ha-entity-picker>

        <div class="section-title">Display</div>
        <ha-textfield id="title" label="Card title"></ha-textfield>
        <ha-icon-picker id="icon" label="Header icon"></ha-icon-picker>
        <div class="toggle-row">
          <span class="toggle-label">Show title bar</span>
          <ha-switch id="show_title"></ha-switch>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Show refresh button</span>
          <ha-switch id="show_refresh"></ha-switch>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Show last updated time</span>
          <ha-switch id="show_last_updated"></ha-switch>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Show section headers</span>
          <ha-switch id="show_section_headers"></ha-switch>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Show feedback buttons</span>
          <ha-switch id="show_feedback"></ha-switch>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Compact rows</span>
          <ha-switch id="compact"></ha-switch>
        </div>
        <ha-textfield id="empty_message" label="Empty state message"></ha-textfield>
        <div class="color-row">
          <label>Accent colour</label>
          <input type="color" id="accent_color">
          <span class="color-clear" id="color-clear">Reset</span>
        </div>

        <div class="section-title">Behaviour</div>
        <div class="native-select-wrap">
          <label class="native-select-label">Tap action</label>
          <select id="tap_action" class="native-select">
            <option value="execute">Execute (perform the action)</option>
            <option value="more-info">More info (open entity dialog)</option>
            <option value="expand">Expand (show reason only)</option>
          </select>
        </div>
        <ha-textfield id="max_visible" label="Max suggestions to show (0 = all)" type="number" min="0" max="20"></ha-textfield>
      </div>
    `;
  }

  _syncFields() {
    const c = this._config;
    const q = (id) => this.shadowRoot.querySelector(`#${id}`);

    const entity = q("entity");
    if (entity) {
      entity.hass = this._hass;
      entity.value = c.entity || "smart_suggestions.suggestions";
    }

    // Only update text fields if they don't have focus (user may be mid-type)
    const title = q("title");
    if (title && !this._hasFocus(title)) {
      title.value = c.title !== undefined ? c.title : "Suggested for You";
    }

    const icon = q("icon");
    if (icon && !this._hasFocus(icon)) {
      icon.value = c.icon || "mdi:sparkles";
    }

    const empty = q("empty_message");
    if (empty && !this._hasFocus(empty)) {
      empty.value = c.empty_message || "Thinking of suggestions…";
    }

    for (const key of ["show_title", "show_refresh", "show_last_updated", "show_section_headers", "show_feedback"]) {
      const el = q(key);
      if (el) el.checked = c[key] !== false;
    }
    const compact = q("compact");
    if (compact) compact.checked = c.compact === true;

    const color = q("accent_color");
    if (color) color.value = c.accent_color || "#3b82f6";

    const tapAction = q("tap_action");
    if (tapAction && !this._hasFocus(tapAction)) tapAction.value = c.tap_action || "execute";
    // Ensure the option exists before setting (native select silently ignores unknown values)


    const maxVisible = q("max_visible");
    if (maxVisible && !this._hasFocus(maxVisible)) maxVisible.value = c.max_visible ?? 0;
  }

  _attachListeners() {
    const q = (id) => this.shadowRoot.querySelector(`#${id}`);

    q("entity")?.addEventListener("value-changed", (e) => this._setValue("entity", e.detail.value));
    q("title")?.addEventListener("input", (e) => this._setValue("title", e.target.value));
    q("icon")?.addEventListener("value-changed", (e) => this._setValue("icon", e.detail.value));
    q("empty_message")?.addEventListener("input", (e) => this._setValue("empty_message", e.target.value));

    for (const key of ["show_title", "show_refresh", "show_last_updated", "show_section_headers", "show_feedback", "compact"]) {
      q(key)?.addEventListener("change", (e) => this._setValue(key, e.target.checked));
    }

    q("accent_color")?.addEventListener("input", (e) => this._setValue("accent_color", e.target.value));

    q("color-clear")?.addEventListener("click", () => {
      delete this._config.accent_color;
      this._fire(this._config);
      this._syncFields();
    });

    q("tap_action")?.addEventListener("change", (e) => this._setValue("tap_action", e.target.value));

    q("max_visible")?.addEventListener("input", (e) => {
      const v = parseInt(e.target.value);
      this._setValue("max_visible", isNaN(v) ? 0 : Math.max(0, v));
    });
  }
}

customElements.define("smart-suggestions-card-editor", SmartSuggestionsCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "smart-suggestions-card",
  name: "Smart Suggestions",
  description: "AI-powered contextual suggestions via Ollama",
  preview: false,
});

console.info(
  `%c SMART-SUGGESTIONS-CARD %c v${CARD_VERSION} `,
  "background:#3b82f6;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px;font-weight:700",
  "background:#1e293b;color:#94a3b8;padding:2px 6px;border-radius:0 4px 4px 0"
);
