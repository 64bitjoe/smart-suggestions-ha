/**
 * Smart Suggestions Card
 * AI-powered contextual action suggestions for Home Assistant
 */

const CARD_VERSION = "2.2.0";

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

// ── Shared helpers ──────────────────────────────────────────────

function confidenceColor(label) {
  return { high: "#34C759", medium: "#FF9F0A", low: "#8E8E93" }[label] ?? "#8E8E93";
}

function confidenceVisible(label) {
  return label === "high" || label === "medium";
}

function reportOutcome(ws, entityId, action, outcome, confidence) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "outcome", entity_id: entityId, action, outcome, confidence }));
  }
}

function getAddonWsUrl(config) {
  if (config && config.addon_url) {
    const base = config.addon_url.replace(/\/$/, "");
    return base.replace(/^http/, "ws") + "/ws";
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/hassio_ingress/smart_suggestions/ws`;
}

function confScore(s) {
  return ({ high: 1.0, medium: 0.6, low: 0.3 }[s?.confidence] ?? 0);
}

function stateColor(state) {
  if (!state) return "#8E8E93";
  const s = state.toLowerCase();
  if (["on","open","unlocked","playing","home","cleaning"].includes(s)) return "#34C759";
  if (["off","closed","locked","idle","paused","standby"].includes(s)) return "#78909C";
  if (["error","unavailable"].includes(s)) return "#FF3B30";
  return "#FF9F0A";
}

function actionLabel(action) {
  return { activate:"Activate", trigger:"Trigger", turn_on:"Turn On", turn_off:"Turn Off", lock:"Lock", unlock:"Unlock", open_cover:"Open", close_cover:"Close", toggle:"Toggle" }[action] || action || "";
}

function stateTransitionHtml(s) {
  const cur = s.current_state || s.state || "";
  const act = s.action || "";
  if (!cur && !act) return "";
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;margin-top:2px;">
    <span style="display:inline-block;padding:1px 6px;border-radius:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;background:${stateColor(cur)};color:#fff;font-size:10px;">${cur || "?"}</span>
    <span style="color:var(--secondary-text-color,#8E8E93);">→</span>
    <span style="display:inline-block;padding:1px 6px;border-radius:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;background:#007AFF;color:#fff;font-size:10px;">${actionLabel(act)}</span>
  </span>`;
}

// ── Shared WebSocket Singleton ──────────────────────────────────

const SmartSuggestionsWS = (() => {
  let _ws = null;
  let _retryTimeout = null;
  let _retryDelay = 5000;
  let _enabled = false;
  let _suggestions = [];
  let _isRefreshing = false;
  let _listeners = new Set();
  let _config = null;

  function _broadcast() {
    for (const card of _listeners) {
      card._onWsUpdate(_suggestions, _isRefreshing);
    }
  }

  function _connect() {
    if (!_enabled || _listeners.size === 0) return;
    const url = getAddonWsUrl(_config);
    try {
      const ws = new WebSocket(url);
      _ws = ws;

      ws.addEventListener("open", () => {
        _retryDelay = 5000;
        console.info("[SmartSuggestionsWS] Connected");
      });

      ws.addEventListener("message", (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (msg.type === "suggestions") {
          _suggestions = Array.isArray(msg.data) ? msg.data : [];
          _isRefreshing = false;
          _broadcast();
        } else if (msg.type === "status") {
          const refreshing = msg.state === "updating";
          if (refreshing !== _isRefreshing) {
            _isRefreshing = refreshing;
            _broadcast();
          }
        } else {
          for (const card of _listeners) {
            if (card._onWsMessage) card._onWsMessage(msg);
          }
        }
      });

      ws.addEventListener("close", () => {
        _ws = null;
        if (_enabled && _listeners.size > 0) {
          _retryTimeout = setTimeout(() => _connect(), _retryDelay);
          _retryDelay = Math.min(30000, _retryDelay * 2);
        }
      });

      ws.addEventListener("error", () => ws.close());
    } catch (_) {}
  }

  function _teardown() {
    _enabled = false;
    if (_retryTimeout) { clearTimeout(_retryTimeout); _retryTimeout = null; }
    if (_ws) { _ws.close(); _ws = null; }
    _retryDelay = 5000;
  }

  return {
    register(card) {
      _listeners.add(card);
      if (_listeners.size === 1) {
        if (card._config && Object.keys(card._config).length > 0) _config = card._config;
        _enabled = true;
        _connect();
      }
      if (_suggestions.length > 0 || _isRefreshing) {
        card._onWsUpdate(_suggestions, _isRefreshing);
      }
    },
    unregister(card) {
      _listeners.delete(card);
      if (_listeners.size === 0) _teardown();
    },
    get ws() { return _ws; },
    send(msg) {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify(msg));
      }
    },
    setConfig(cfg) {
      if (cfg && Object.keys(cfg).length > 0) {
        _config = cfg;
      }
    },
  };
})();

// ── Base Card ───────────────────────────────────────────────────

class SmartSuggestionsBaseCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._wsSuggestions = [];
    this._isRefreshing = false;
    this._lastStateStr = null;
  }

  /** Subclasses override to provide card-specific default config. */
  _defaultConfig() {
    return {
      entity: "smart_suggestions.suggestions",
      title: "Suggested for You",
      show_title: true,
      accent_color: null,
      max_visible: 0,
      empty_message: "Thinking of suggestions…",
    };
  }

  setConfig(config) {
    try {
      const defaults = this._defaultConfig();
      const c = {};
      for (const key of Object.keys(defaults)) {
        c[key] = config[key] !== undefined ? config[key] : defaults[key];
      }
      // Preserve any extra keys from config (addon_url, etc.)
      for (const key of Object.keys(config)) {
        if (!(key in c)) c[key] = config[key];
      }
      this._config = c;
      SmartSuggestionsWS.setConfig(this._config);
      requestAnimationFrame(() => this._render());
    } catch (e) {
      console.error("[SmartSuggestions] setConfig error:", e);
    }
  }

  connectedCallback() { SmartSuggestionsWS.register(this); }
  disconnectedCallback() { SmartSuggestionsWS.unregister(this); }

  set hass(hass) {
    this._hass = hass;
    const entity = this._config.entity || "smart_suggestions.suggestions";
    const state = hass.states[entity];
    const stateStr = JSON.stringify(state?.attributes?.suggestions) + state?.state;
    if (stateStr !== this._lastStateStr) {
      this._lastStateStr = stateStr;
      this._render();
    }
  }

  _onWsUpdate(suggestions, isRefreshing) {
    this._wsSuggestions = suggestions;
    this._isRefreshing = isRefreshing;
    this._render();
  }

  _onWsMessage(_msg) {}

  _getSuggestions() {
    let suggestions;
    if (SmartSuggestionsWS.ws !== null && Array.isArray(this._wsSuggestions) && this._wsSuggestions.length) {
      suggestions = this._wsSuggestions;
    } else {
      if (!this._hass) return [];
      const entity = this._config.entity || "smart_suggestions.suggestions";
      const state = this._hass.states[entity];
      if (!state) return [];
      const s = state.attributes.suggestions;
      suggestions = Array.isArray(s) ? s : [];
    }
    const max = parseInt(this._config.max_visible) || 0;
    return max > 0 ? suggestions.slice(0, max) : suggestions;
  }

  _getStatus() {
    if (SmartSuggestionsWS.ws !== null) {
      return this._isRefreshing ? "updating" : "ready";
    }
    if (!this._hass) return "idle";
    const entity = this._config.entity || "smart_suggestions.suggestions";
    return this._hass.states[entity]?.state || "idle";
  }

  _getLastUpdated() {
    if (!this._hass) return null;
    const entity = this._config.entity || "smart_suggestions.suggestions";
    const lu = this._hass.states[entity]?.attributes?.last_updated;
    return lu ? new Date(lu) : null;
  }

  _render() {
    // Subclasses implement this
  }

  _callService(s) {
    if (!this._hass || !s.entity_id) return;
    const domain = s.entity_id.split(".")[0];
    const svc = s.action || (domain === "scene" ? "turn_on" : domain === "automation" ? "trigger" : domain === "script" ? "turn_on" : "toggle");
    this._hass.callService(domain, svc, { entity_id: s.entity_id }).catch(() => {});
    reportOutcome(SmartSuggestionsWS.ws, s.entity_id, svc, "run", confScore(s));
  }

  _showMoreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      bubbles: true, composed: true, detail: { entityId },
    }));
  }

  getCardSize() { return 3; }

  static getStubConfig() {
    return { entity: "smart_suggestions.suggestions", title: "Suggested for You" };
  }
}

// ── Main Card ───────────────────────────────────────────────────

class SmartSuggestionsCard extends SmartSuggestionsBaseCard {
  constructor() {
    super();
    this._expandedIndex = null;
    this._pendingAutomation = false;
    this._pendingYamlEid = null;
  }

  _defaultConfig() {
    return {
      entity:               "smart_suggestions.suggestions",
      title:                "Suggested for You",
      show_title:           true,
      show_refresh:         true,
      show_last_updated:    true,
      accent_color:         null,
      empty_message:        "Thinking of suggestions…",
      addon_url:            null,
      compact:              false,
      max_visible:          0,
      tap_action:           "execute",
      show_feedback:        true,
      show_section_headers: true,
      icon:                 undefined,
    };
  }

  _onWsUpdate(suggestions, isRefreshing) {
    this._wsSuggestions = suggestions;
    this._isRefreshing = isRefreshing;
    if (!isRefreshing && this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }
    this._render();
  }

  _onWsMessage(msg) {
    switch (msg.type) {
      case "automation_result": {
        this._pendingAutomation = false;
        this._render();
        if (msg.success) {
          this._showToast("Automation created!");
        } else {
          this._showYamlFallback(msg.yaml || "", msg.error || "Unknown error");
        }
        break;
      }
      case "yaml_result": {
        this._pendingYamlEid = null;
        this.shadowRoot.querySelectorAll(".get-yaml-btn.loading").forEach(btn => {
          btn.classList.remove("loading");
          btn.textContent = "Get Automation YAML";
        });
        if (msg.yaml) {
          this._showYamlFallback(msg.yaml, "");
        } else {
          this._showYamlFallback("", msg.error || "Failed to generate YAML");
        }
        break;
      }
    }
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
    if (state?.attributes?.icon) return state.attributes.icon;
    const sugIcon = suggestion.icon;
    if (sugIcon && typeof sugIcon === "string" && sugIcon.startsWith("mdi:") && sugIcon.length > 5) {
      return sugIcon;
    }
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

    if (!this._hass.states[entity_id] && domain !== "scene" && domain !== "script" && domain !== "automation") {
      console.warn("[SmartSuggestions] Entity not in HA states — skipping:", entity_id);
      return;
    }

    const cs = confScore(suggestion);
    try {
      if (domain === "scene") {
        await this._hass.callService("scene", "turn_on", { entity_id });
        this._flashRow(entity_id);
        reportOutcome(SmartSuggestionsWS.ws, entity_id, action || "turn_on", "run", cs);
        return;
      }
      if (domain === "automation" || type === "automation") {
        await this._hass.callService("automation", "trigger", { entity_id });
        reportOutcome(SmartSuggestionsWS.ws, entity_id, action || "trigger", "run", cs);
        return;
      }
      if (domain === "script" || type === "script") {
        await this._hass.callService("script", "turn_on", { entity_id });
        reportOutcome(SmartSuggestionsWS.ws, entity_id, action || "turn_on", "run", cs);
        return;
      }
      const svc = action || "toggle";
      await this._hass.callService(domain, svc, { entity_id, ...(action_data || {}) });
      this._flashRow(entity_id);
      reportOutcome(SmartSuggestionsWS.ws, entity_id, svc, "run", cs);
    } catch (e) {
      console.error("[SmartSuggestions] Action failed:", e);
    }
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
    SmartSuggestionsWS.send({ type: "refresh_all" });
    this._showToast("Refreshing everything…");
    this._refreshTimeout = setTimeout(() => {
      this._isRefreshing = false;
      this._render();
    }, 30000);
  }

  _toggleExpand(index) {
    this._expandedIndex = this._expandedIndex === index ? null : index;
    this._render();
  }

  _showToast(message) {
    const existing = this.shadowRoot.querySelector(".toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    this.shadowRoot.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = "opacity 0.3s";
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 320);
    }, 3000);
  }

  _showYamlFallback(yaml, error) {
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
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    return { turn_on: "Turn On", turn_off: "Turn Off", toggle: "Toggle", trigger: "Trigger", navigate: "Go To" }[action] || action;
  }

  _getActionDot(action) {
    return { turn_on: "#4ade80", turn_off: "#f87171", toggle: "#60a5fa", trigger: "#a78bfa", navigate: "#fb923c" }[action] || "#94a3b8";
  }

  _render() {
    try {
      this._renderInner();
    } catch (e) {
      console.error("[SmartSuggestions] Render error:", e);
      try {
        this.shadowRoot.innerHTML = `<ha-card style="padding:16px;color:var(--error-color,#f44336)">
          Smart Suggestions render error — check browser console for details.
        </ha-card>`;
      } catch (_) {}
    }
  }

  _renderInner() {
    if (!this._config || !this._hass) return;
    const accent = this._config.accent_color || "#007AFF";
    const suggestions = this._getSuggestions();
    const status = this._getStatus();
    const isUpdating = status === "updating" || this._isRefreshing;
    const lastUpdated = this._getLastUpdated();

    const styles = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :host { display: block; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif; }
      .card { background: var(--ha-card-background, #1C1C1E); border-radius: 16px; overflow: hidden; }
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
      .typing-dots span { display: inline-block; width: 3px; height: 3px; border-radius: 50%; background: ${accent}; margin: 0 1px; animation: tdot 1.2s ease-in-out infinite; vertical-align: middle; }
      .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
      .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes tdot { 0%,80%,100% { transform: translateY(0); opacity: 0.35; } 40% { transform: translateY(-2px); opacity: 1; } }
      .sections { margin: 0 12px 14px; }
      .section-header { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--secondary-text-color, #8E8E93); padding: 10px 2px 5px; }
      .sections > .section-header:first-child { padding-top: 0; }
      .list-wrap { border-radius: 12px; overflow: hidden; background: rgba(255,255,255,0.07); margin-bottom: 6px; }
      .sections .list-wrap:last-child { margin-bottom: 0; }
      .row { display: flex; flex-direction: column; position: relative; }
      .row + .row .row-main::before { content: ''; position: absolute; top: 0; left: 62px; right: 0; height: 0.5px; background: rgba(255,255,255,0.09); }
      .row-main { display: flex; align-items: center; padding: 10px 12px 10px 14px; min-height: 56px; cursor: pointer; gap: 12px; user-select: none; -webkit-tap-highlight-color: transparent; position: relative; transition: background 0.12s; }
      .row-main:active { background: rgba(255,255,255,0.07); }
      .icon-wrap { width: 36px; height: 36px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; }
      .icon-wrap ha-icon { --mdc-icon-size: 20px; color: #fff; }
      .row-text { flex: 1; min-width: 0; }
      .row-name { font-size: 15px; font-weight: 400; color: var(--primary-text-color, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
      .row-sub { font-size: 12px; color: var(--secondary-text-color, #8E8E93); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .info-btn { width: 30px; height: 30px; border-radius: 50%; background: none; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: ${accent}; opacity: 0.65; -webkit-tap-highlight-color: transparent; flex-shrink: 0; transition: opacity 0.15s; }
      .info-btn:active, .info-btn.active { opacity: 1; }
      .info-btn ha-icon { --mdc-icon-size: 19px; }
      .reason-panel { overflow: hidden; max-height: 0; transition: max-height 0.28s cubic-bezier(0.4,0,0.2,1); }
      .reason-panel.open { max-height: 220px; }
      .reason-inner { padding: 8px 14px 13px 62px; font-size: 13px; line-height: 1.55; color: var(--secondary-text-color, #8E8E93); border-top: 0.5px solid rgba(255,255,255,0.07); }
      .get-yaml-btn { margin-top: 8px; background: none; border: 1px solid ${accent}; color: ${accent}; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
      .get-yaml-btn.loading { opacity: 0.5; pointer-events: none; }
      .row.flash .row-main { animation: flash-row 0.6s ease; }
      @keyframes flash-row { 0% { background: rgba(52,199,89,0); } 25% { background: rgba(52,199,89,0.14); } 100% { background: rgba(52,199,89,0); } }
      .row-main.compact { padding: 6px 10px 6px 12px; min-height: 44px; gap: 10px; }
      .row-main.compact .icon-wrap { width: 30px; height: 30px; border-radius: 8px; }
      .row-main.compact .icon-wrap ha-icon { --mdc-icon-size: 17px; }
      .row-main.compact .row-name { font-size: 13.5px; }
      .row-main.compact .row-sub { font-size: 11px; }
      .confidence-label { display:inline-block; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; padding:1px 6px; border-radius:20px; background:rgba(255,255,255,0.08); color:var(--secondary-text-color,#8E8E93); margin-top:2px; white-space:nowrap; }
      .confidence-label.high { background:rgba(52,199,89,0.15); color:#34C759; }
      .confidence-label.medium { background:rgba(255,159,10,0.15); color:#FF9F0A; }
      .confidence-label.low { background:rgba(142,142,147,0.12); color:#8E8E93; }
      .scene-list-wrap { border-radius: 12px; overflow: hidden; background: rgba(191,90,242,0.10); border: 1px solid rgba(191,90,242,0.22); margin-bottom: 10px; }
      .scene-list-wrap .row-main { padding: 12px 12px 12px 14px; min-height: 62px; }
      .scene-list-wrap .row-name { font-size: 15.5px; font-weight: 500; }
      .save-automation-btn { display:flex; align-items:center; gap:4px; margin:0 14px 12px 62px; padding:7px 14px; background:rgba(191,90,242,0.18); border:1px solid rgba(191,90,242,0.35); border-radius:9px; color:#BF5AF2; font-size:13px; font-weight:600; cursor:pointer; -webkit-tap-highlight-color:transparent; transition:background 0.15s,opacity 0.15s; width:fit-content; }
      .save-automation-btn ha-icon { --mdc-icon-size:15px; }
      .save-automation-btn:active { background:rgba(191,90,242,0.28); }
      .save-automation-btn:disabled { opacity:0.45; cursor:default; }
      .feedback-area { display:flex; gap:2px; align-items:center; flex-shrink:0; }
      .vote-btn { width:28px; height:28px; border-radius:50%; background:none; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--secondary-text-color,#8E8E93); opacity:0.5; transition:opacity 0.15s,color 0.15s; -webkit-tap-highlight-color:transparent; }
      .vote-btn ha-icon { --mdc-icon-size:15px; }
      .vote-btn.voted-up { color:#34C759; opacity:1; }
      .vote-btn.voted-down { color:#FF3B30; opacity:1; }
      @keyframes vote-pop { 0%{transform:scale(1)} 40%{transform:scale(1.4)} 100%{transform:scale(1)} }
      .vote-btn.pop { animation:vote-pop 0.25s ease; }
      .toast { position:fixed; bottom:32px; left:50%; transform:translateX(-50%) translateY(0); background:rgba(30,30,32,0.95); color:#fff; font-size:14px; font-weight:500; padding:10px 20px; border-radius:24px; box-shadow:0 4px 20px rgba(0,0,0,0.45); z-index:9999; pointer-events:none; animation:toast-in 0.22s ease; }
      @keyframes toast-in { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
      .yaml-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:9998; display:flex; align-items:flex-end; justify-content:center; }
      .yaml-drawer { background:#1C1C1E; border-radius:20px 20px 0 0; width:100%; max-width:600px; padding:20px 18px 32px; box-shadow:0 -4px 40px rgba(0,0,0,0.5); }
      .yaml-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      .yaml-title { font-size:16px; font-weight:700; color:var(--primary-text-color,#fff); }
      .yaml-close { background:none; border:none; color:var(--secondary-text-color,#8E8E93); cursor:pointer; font-size:22px; line-height:1; padding:0 2px; }
      .yaml-error { font-size:12px; color:#FF3B30; margin-bottom:10px; }
      .yaml-pre { background:rgba(255,255,255,0.06); border-radius:10px; padding:12px; overflow:auto; max-height:260px; font-size:12px; font-family:ui-monospace,monospace; color:#e2e8f0; white-space:pre; }
      .yaml-copy-btn { margin-top:12px; width:100%; padding:11px; background:rgba(255,255,255,0.09); border:1px solid rgba(255,255,255,0.13); border-radius:10px; color:var(--primary-text-color,#fff); font-size:14px; font-weight:600; cursor:pointer; }
      .yaml-copy-btn:active { background:rgba(255,255,255,0.16); }
      .empty { padding: 36px 20px; text-align: center; color: var(--secondary-text-color, #8E8E93); font-size: 14px; }
      .empty ha-icon { --mdc-icon-size: 38px; display: block; margin: 0 auto 10px; opacity: 0.22; }
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
        const actionLbl = this._getActionLabel(s.action);
        const isExpanded = this._expandedIndex === i;
        let subText = actionLbl;
        if (s.entity_id && this._hass) {
          const st = this._hass.states[s.entity_id];
          if (st && domain !== "automation" && domain !== "script" && domain !== "scene") {
            subText = `${actionLbl} · ${st.state}`;
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
                <div class="row-sub">${stateTransitionHtml(s) || subText}</div>
                ${confidenceLabel(s)}
              </div>
              ${feedbackHtml}
              <button class="info-btn ${isExpanded ? "active" : ""}" data-info="${i}">
                <ha-icon icon="mdi:information-outline"></ha-icon>
              </button>
            </div>
            ${saveAutomationHtml}
            <div class="reason-panel ${isExpanded ? "open" : ""}">
              <div class="reason-inner">
                ${s.reason || "No reason provided."}
                <br>${(() => { const yamlPending = this._pendingYamlEid === s.entity_id; return `<button class="get-yaml-btn${yamlPending ? ' loading' : ''}" data-eid="${this._escapeHtml(s.entity_id || "")}" data-action="${this._escapeHtml(s.action || "")}">${yamlPending ? 'Building…' : 'Get Automation YAML'}</button>`; })()}
              </div>
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
    this.shadowRoot.querySelectorAll("[data-feedback-eid]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const eid = btn.dataset.feedbackEid;
        const vote = btn.dataset.vote;
        this._sendFeedback(eid, vote);
        if (vote === "down") {
          const suggestion = this._getSuggestions().find(s => s.entity_id === eid);
          reportOutcome(SmartSuggestionsWS.ws, eid, suggestion?.action || "toggle", "dismissed", confScore(suggestion));
        }
      });
    });
    this.shadowRoot.querySelectorAll("[data-more-info]").forEach((el) => {
      const handler = (e) => {
        e.stopPropagation();
        const eid = el.dataset.moreInfo;
        if (eid) this._showMoreInfo(eid);
      };
      el.addEventListener("click", handler);
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); handler(e); });
    });
    this.shadowRoot.querySelectorAll("[data-info]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this._toggleExpand(parseInt(el.dataset.info));
      });
    });
    this.shadowRoot.querySelectorAll(".get-yaml-btn").forEach((yamlBtnEl) => {
      yamlBtnEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const eid = yamlBtnEl.dataset.eid;
        const action = yamlBtnEl.dataset.action;
        const suggestions = this._getSuggestions();
        const suggestion = suggestions.find(s => s.entity_id === eid);
        this._pendingYamlEid = eid;
        yamlBtnEl.classList.add("loading");
        yamlBtnEl.textContent = "Building…";
        SmartSuggestionsWS.send({
          type: "build_yaml", entity_id: eid, action: action,
          name: suggestion?.name || eid, reason: suggestion?.reason || "",
        });
      });
    });
    this.shadowRoot.querySelectorAll("[data-save-automation]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this._pendingAutomation) return;
        const index = parseInt(btn.dataset.saveAutomation);
        const suggestions = this._getSuggestions();
        const s = suggestions[index];
        if (!s || SmartSuggestionsWS.ws === null) return;
        this._pendingAutomation = true;
        btn.disabled = true;
        SmartSuggestionsWS.send({ type: "save_automation", suggestion: s });
      });
    });
  }

  getCardSize() {
    return Math.max(2, Math.ceil(this._getSuggestions().length * 0.7) + 1);
  }

  static getConfigElement() {
    const el = document.createElement("smart-suggestions-card-editor");
    el._cardType = "main";
    return el;
  }

  static getStubConfig() {
    return { entity: "smart_suggestions.suggestions", title: "Suggested for You" };
  }
}

// ── Spotlight Card ──────────────────────────────────────────────

class SmartSuggestionsSpotlightCard extends SmartSuggestionsBaseCard {
  constructor() {
    super();
    this._currentIndex = 0;
  }

  _defaultConfig() {
    return {
      entity:        "smart_suggestions.suggestions",
      title:         "Suggested for You",
      show_title:    true,
      accent_color:  "#007AFF",
      max_visible:   0,
      empty_message: "Thinking of suggestions…",
    };
  }

  _onWsMessage(msg) {
    if (msg.type === "yaml_result") {
      const drawer = this.shadowRoot.querySelector(".yaml-overlay");
      if (!drawer) {
        msg.yaml ? this._showYamlDrawer(msg.yaml) : this._showYamlDrawer("", msg.error || "Failed");
      }
    }
  }

  _showYamlDrawer(yaml, error = "") {
    const existing = this.shadowRoot.querySelector(".yaml-overlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "yaml-overlay";
    overlay.innerHTML = `
      <div class="yaml-drawer">
        <div class="yaml-header"><span>Automation YAML</span><button id="yaml-close">&times;</button></div>
        ${error ? `<div class="yaml-error">${error}</div>` : ""}
        <pre class="yaml-pre">${String(yaml).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</pre>
        <button class="yaml-copy" id="yaml-copy">Copy YAML</button>
      </div>`;
    this.shadowRoot.appendChild(overlay);
    overlay.querySelector("#yaml-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#yaml-copy").addEventListener("click", () => {
      navigator.clipboard.writeText(yaml).then(() => {
        overlay.querySelector("#yaml-copy").textContent = "Copied!";
        setTimeout(() => overlay.querySelector("#yaml-copy") && (overlay.querySelector("#yaml-copy").textContent = "Copy YAML"), 2000);
      }).catch(() => {});
    });
  }

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color;
    const suggestions = this._getSuggestions();
    const s = suggestions[this._currentIndex];
    if (this._currentIndex >= suggestions.length) this._currentIndex = 0;

    if (!s) {
      this.shadowRoot.innerHTML = `
        <style>:host { display: block; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
        .empty { padding: 36px 20px; text-align:center; color:var(--secondary-text-color,#8E8E93); font-size:14px; }</style>
        <ha-card><div class="empty">${this._config.empty_message}</div></ha-card>`;
      return;
    }

    const domain = s.entity_id?.split(".")[0] || "scene";
    const icon = DOMAIN_ICONS[domain] || "mdi:star-circle";
    const color = DOMAIN_COLORS[domain] || "#8E8E93";
    const confCol = confidenceColor(s.confidence);
    const isFirst = this._currentIndex === 0;
    const isLast = this._currentIndex >= suggestions.length - 1;

    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
        .card { background: var(--ha-card-background, #1C1C1E); border-radius: 16px; padding: 24px 20px; text-align: center; position: relative; }
        ${this._config.show_title ? `.title { font-size: 13px; font-weight: 600; color: var(--secondary-text-color, #8E8E93); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 20px; }` : ""}
        .icon-circle { width: 64px; height: 64px; border-radius: 20px; background: ${color}; display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; }
        .icon-circle ha-icon { --mdc-icon-size: 32px; color: #fff; }
        .name { font-size: 20px; font-weight: 600; color: var(--primary-text-color, #fff); margin-bottom: 6px; }
        .transition { margin-bottom: 8px; display: flex; justify-content: center; }
        .reason { font-size: 14px; color: var(--secondary-text-color, #8E8E93); line-height: 1.5; margin-bottom: 12px; padding: 0 10px; }
        .badge { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 20px; background: ${confCol}22; color: ${confCol}; margin-bottom: 18px; }
        .actions { display: flex; gap: 8px; justify-content: center; margin-bottom: 16px; }
        .act-btn { padding: 10px 20px; border-radius: 10px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; }
        .act-run { background: ${accent}; color: #fff; }
        .act-yaml { background: rgba(255,255,255,0.1); color: var(--primary-text-color, #fff); }
        .nav { display: flex; justify-content: space-between; padding: 0 10px; }
        .nav-btn { background: none; border: none; color: ${accent}; font-size: 14px; font-weight: 600; cursor: pointer; padding: 4px 8px; opacity: 1; -webkit-tap-highlight-color: transparent; }
        .nav-btn:disabled { opacity: 0.3; cursor: default; }
        .counter { font-size: 12px; color: var(--secondary-text-color, #8E8E93); }
        .yaml-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:9999; display:flex; align-items:flex-end; justify-content:center; }
        .yaml-drawer { background:#1C1C1E; border-radius:20px 20px 0 0; width:100%; max-width:600px; padding:20px 18px 32px; }
        .yaml-header { display:flex; justify-content:space-between; margin-bottom:12px; font-size:16px; font-weight:700; color:var(--primary-text-color,#fff); }
        .yaml-header button { background:none; border:none; color:var(--secondary-text-color); font-size:22px; cursor:pointer; }
        .yaml-error { font-size:12px; color:#FF3B30; margin-bottom:8px; }
        .yaml-pre { background:rgba(255,255,255,0.06); border-radius:10px; padding:12px; overflow:auto; max-height:260px; font-size:12px; font-family:ui-monospace,monospace; color:#e2e8f0; white-space:pre; }
        .yaml-copy { margin-top:12px; width:100%; padding:11px; background:rgba(255,255,255,0.09); border:1px solid rgba(255,255,255,0.13); border-radius:10px; color:var(--primary-text-color,#fff); font-size:14px; font-weight:600; cursor:pointer; }
      </style>
      <ha-card>
        <div class="card">
          ${this._config.show_title ? `<div class="title">${this._config.title}</div>` : ""}
          <div class="icon-circle"><ha-icon icon="${icon}"></ha-icon></div>
          <div class="name">${s.name || s.entity_id}</div>
          <div class="transition">${stateTransitionHtml(s)}</div>
          <div class="reason">${s.reason || ""}</div>
          <div class="badge">${s.confidence || "low"}</div>
          <div class="actions">
            <button class="act-btn act-run" id="btn-run">Run Now</button>
            <button class="act-btn act-yaml" id="btn-yaml">Get YAML</button>
          </div>
          <div class="nav">
            <button class="nav-btn" id="btn-prev" ${isFirst ? "disabled" : ""}>&larr; Previous</button>
            <span class="counter">${this._currentIndex + 1} / ${suggestions.length}</span>
            <button class="nav-btn" id="btn-next" ${isLast ? "disabled" : ""}>Next &rarr;</button>
          </div>
        </div>
      </ha-card>`;

    this.shadowRoot.querySelector("#btn-run")?.addEventListener("click", () => {
      this._callService(s);
    });

    this.shadowRoot.querySelector("#btn-yaml")?.addEventListener("click", () => {
      SmartSuggestionsWS.send({ type: "build_yaml", entity_id: s.entity_id, action: s.action || "", name: s.name || s.entity_id, reason: s.reason || "" });
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "saved", confScore(s));
    });

    this.shadowRoot.querySelector("#btn-prev")?.addEventListener("click", () => {
      if (this._currentIndex > 0) { this._currentIndex--; this._render(); }
    });
    this.shadowRoot.querySelector("#btn-next")?.addEventListener("click", () => {
      if (this._currentIndex < suggestions.length - 1) { this._currentIndex++; this._render(); }
    });
  }

  static getConfigElement() {
    const el = document.createElement("smart-suggestions-card-editor");
    el._cardType = "spotlight";
    return el;
  }

  static getStubConfig() {
    return { entity: "smart_suggestions.suggestions", title: "Suggested for You" };
  }
}

// ── Chip Card ───────────────────────────────────────────────────

class SmartSuggestionsChipCard extends SmartSuggestionsBaseCard {
  constructor() {
    super();
    this._dismissed = new Set();
    this._longPressTimer = null;
    this._pressOrigin = null;
    this._longPressHandled = false;
  }

  _defaultConfig() {
    return {
      entity:        "smart_suggestions.suggestions",
      title:         "",
      show_title:    false,
      accent_color:  "#007AFF",
      max_visible:   5,
      empty_message: "No suggestions right now",
    };
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._longPressTimer) clearTimeout(this._longPressTimer);
  }

  _onWsUpdate(suggestions, isRefreshing) {
    const max = parseInt(this._config.max_visible) || 5;
    this._wsSuggestions = suggestions;
    this._isRefreshing = isRefreshing;
    this._render();
  }

  _getSuggestions() {
    const all = super._getSuggestions();
    return all.filter(s => !this._dismissed.has(s.entity_id));
  }

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color || "#007AFF";
    const suggestions = this._getSuggestions();

    const chips = suggestions.map((s, i) => {
      const domain = s.entity_id?.split(".")[0] || "scene";
      const icon = DOMAIN_ICONS[domain] || "mdi:star-circle";
      const label = (s.name || s.entity_id || "").substring(0, 22);
      const opacity = s.confidence === "high" ? 1 : s.confidence === "medium" ? 0.75 : 0.5;
      return `<div class="chip" data-index="${i}" style="opacity:${opacity}">
        <ha-icon icon="${icon}" style="--mdc-icon-size:16px;color:#fff;flex-shrink:0"></ha-icon>
        <span class="chip-label">${label}</span>
      </div>`;
    }).join("");

    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
        .title { font-size: 13px; font-weight: 600; color: var(--secondary-text-color, #8E8E93); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; padding: 0 4px; }
        .chip-row { display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 4px; scrollbar-width: none; }
        .chip-row::-webkit-scrollbar { display: none; }
        .chip { display: flex; align-items: center; gap: 6px; background: ${accent}; border-radius: 20px; padding: 6px 12px; cursor: pointer; flex-shrink: 0; user-select: none; -webkit-tap-highlight-color: transparent; transition: transform 0.1s; }
        .chip:active { transform: scale(0.95); }
        .chip.flash { animation: chip-flash 0.5s ease; }
        @keyframes chip-flash { 0% { background: ${accent}; } 50% { background: #34C759; } 100% { background: ${accent}; } }
        .chip-label { font-size: 13px; font-weight: 500; color: #fff; white-space: nowrap; }
        .empty { font-size: 13px; color: var(--secondary-text-color, #8E8E93); padding: 4px; }
        .popover { position: absolute; background: var(--ha-card-background, #2C2C2E); border-radius: 12px; padding: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); z-index: 100; min-width: 200px; max-width: 260px; }
        .pop-reason { font-size: 13px; color: var(--secondary-text-color, #8E8E93); margin-bottom: 10px; line-height: 1.4; }
        .pop-btn { display: block; width: 100%; text-align: left; background: none; border: none; color: ${accent}; font-size: 13px; font-weight: 600; padding: 6px 0; cursor: pointer; }
        .pop-btn.dismiss { color: #f87171; }
      </style>
      ${this._config.show_title && this._config.title ? `<div class="title">${this._config.title}</div>` : ""}
      <div class="chip-row" id="chip-row">
        ${this._isRefreshing ? `<div class="empty">Thinking…</div>` : chips || `<div class="empty">${this._config.empty_message}</div>`}
      </div>`;

    this.shadowRoot.querySelectorAll(".chip").forEach((chip, i) => {
      const s = suggestions[i];
      if (!s) return;

      chip.addEventListener("click", async () => {
        if (this._longPressHandled) return;
        this._callService(s);
        chip.classList.add("flash");
        setTimeout(() => chip.classList.remove("flash"), 600);
      });

      const startLongPress = (clientX, clientY) => {
        this._pressOrigin = { x: clientX, y: clientY };
        this._longPressTimer = setTimeout(() => {
          this._longPressHandled = true;
          this._showPopover(chip, s);
          this._longPressTimer = null;
        }, 400);
      };
      const cancelLongPress = () => {
        if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
      };

      chip.addEventListener("pointerdown", e => {
        this._longPressHandled = false;
        startLongPress(e.clientX, e.clientY);
      });
      chip.addEventListener("pointerup", cancelLongPress);
      chip.addEventListener("pointercancel", cancelLongPress);
      chip.addEventListener("pointermove", e => {
        if (!this._pressOrigin) return;
        const dx = Math.abs(e.clientX - this._pressOrigin.x);
        const dy = Math.abs(e.clientY - this._pressOrigin.y);
        if (dx > 8 || dy > 8) cancelLongPress();
      });
    });

    this.shadowRoot.addEventListener("click", e => {
      const popover = this.shadowRoot.querySelector(".popover");
      if (popover && !popover.contains(e.target)) popover.remove();
    }, { capture: true });
  }

  _showPopover(chip, s) {
    this.shadowRoot.querySelector(".popover")?.remove();
    const pop = document.createElement("div");
    pop.className = "popover";
    pop.innerHTML = `
      <div style="margin-bottom:6px;">${stateTransitionHtml(s)}</div>
      <div class="pop-reason">${s.reason || "No reason provided."}</div>
      <button class="pop-btn" id="pop-yaml">Save as Automation</button>
      <button class="pop-btn dismiss" id="pop-dismiss">Dismiss</button>`;
    const rect = chip.getBoundingClientRect();
    const hostRect = this.getBoundingClientRect();
    pop.style.position = "absolute";
    pop.style.top = (rect.bottom - hostRect.top + 6) + "px";
    pop.style.left = Math.max(0, rect.left - hostRect.left) + "px";
    this.shadowRoot.appendChild(pop);

    pop.querySelector("#pop-yaml").addEventListener("click", () => {
      SmartSuggestionsWS.send({ type: "build_yaml", entity_id: s.entity_id, action: s.action || "", name: s.name || s.entity_id, reason: s.reason || "" });
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "saved", confScore(s));
      pop.remove();
    });
    pop.querySelector("#pop-dismiss").addEventListener("click", () => {
      this._dismissed.add(s.entity_id);
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "dismissed", confScore(s));
      pop.remove();
      this._render();
    });
  }

  getCardSize() { return 1; }

  static getConfigElement() {
    const el = document.createElement("smart-suggestions-card-editor");
    el._cardType = "chip";
    return el;
  }

  static getStubConfig() {
    return { entity: "smart_suggestions.suggestions" };
  }
}

// ── Tile Card ───────────────────────────────────────────────────

class SmartSuggestionsTileCard extends SmartSuggestionsBaseCard {
  _defaultConfig() {
    return {
      entity:        "smart_suggestions.suggestions",
      title:         "Suggestions",
      show_title:    true,
      accent_color:  "#007AFF",
      columns:       2,
      max_visible:   6,
      empty_message: "Thinking of suggestions…",
    };
  }

  setConfig(config) {
    super.setConfig(config);
    this._config.columns = Math.min(3, Math.max(2, parseInt(config.columns) || 2));
  }

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color || "#007AFF";
    const cols = this._config.columns;
    const suggestions = this._getSuggestions();

    const tiles = suggestions.map((s, i) => {
      const domain = s.entity_id?.split(".")[0] || "scene";
      const icon = DOMAIN_ICONS[domain] || "mdi:star-circle";
      const borderColor = confidenceColor(s.confidence);
      const cur = s.current_state || "";
      return `<div class="tile" data-index="${i}" style="border-color:${borderColor}">
        <ha-icon icon="${icon}" style="--mdc-icon-size:36px;color:${borderColor}"></ha-icon>
        <div class="tile-name">${(s.name || s.entity_id || "").substring(0, 20)}</div>
        ${cur ? `<div class="tile-state" style="color:${stateColor(cur)}">${cur}</div>` : ""}
        <div class="tile-badge ${s.confidence || 'low'}">${s.confidence || "low"}</div>
      </div>`;
    }).join("");

    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
        .card { background: var(--ha-card-background, #1C1C1E); border-radius: 16px; padding: 14px; }
        .title { font-size: 15px; font-weight: 600; color: var(--primary-text-color, #fff); margin-bottom: 12px; }
        .grid { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 8px; }
        .tile { background: rgba(255,255,255,0.07); border-radius: 12px; border: 2px solid #8E8E93; padding: 14px 8px; display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent; transition: background 0.1s; aspect-ratio: 1; justify-content: center; }
        .tile:active { background: rgba(255,255,255,0.12); }
        .tile.flash { animation: tile-flash 0.5s ease; }
        @keyframes tile-flash { 0%,100% { background: rgba(255,255,255,0.07); } 50% { background: rgba(52,199,89,0.15); } }
        .tile-name { font-size: 12px; color: var(--primary-text-color, #fff); text-align: center; line-height: 1.3; }
        .tile-state { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
        .tile-badge { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 1px 6px; border-radius: 20px; }
        .tile-badge.high { background: rgba(52,199,89,0.15); color: #34C759; }
        .tile-badge.medium { background: rgba(255,159,10,0.15); color: #FF9F0A; }
        .tile-badge.low { background: rgba(142,142,147,0.12); color: #8E8E93; }
        .empty { text-align: center; padding: 24px; color: var(--secondary-text-color, #8E8E93); font-size: 14px; }
        .sheet-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 9990; display: flex; align-items: flex-end; }
        .sheet { background: var(--ha-card-background, #1C1C1E); width: 100%; border-radius: 16px 16px 0 0; padding: 16px; }
        .sheet-name { font-size: 17px; font-weight: 600; color: var(--primary-text-color, #fff); margin-bottom: 4px; }
        .sheet-reason { font-size: 14px; color: var(--secondary-text-color, #8E8E93); margin-bottom: 16px; line-height: 1.4; }
        .sheet-btn { display: block; width: 100%; padding: 13px; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; margin-bottom: 8px; text-align: center; }
        .sheet-run { background: ${accent}; color: #fff; }
        .sheet-yaml { background: rgba(255,255,255,0.1); color: var(--primary-text-color, #fff); }
        .sheet-dismiss { background: rgba(255,255,255,0.07); color: #f87171; }
        .sheet-cancel { background: none; color: var(--secondary-text-color, #8E8E93); }
      </style>
      <ha-card>
        <div class="card">
          ${this._config.show_title ? `<div class="title">${this._config.title}</div>` : ""}
          ${this._isRefreshing || suggestions.length === 0
            ? `<div class="empty">${this._isRefreshing ? "Thinking…" : this._config.empty_message}</div>`
            : `<div class="grid">${tiles}</div>`}
        </div>
      </ha-card>`;

    this.shadowRoot.querySelectorAll(".tile").forEach((tile, i) => {
      const s = suggestions[i];
      if (!s) return;
      tile.addEventListener("click", () => this._showSheet(s, tile));
    });
  }

  _showSheet(s, tile) {
    const existing = this.shadowRoot.querySelector(".sheet-overlay");
    if (existing) existing.remove();
    const accent = this._config.accent_color || "#007AFF";
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-name">${s.name || s.entity_id}</div>
        <div style="margin-bottom:8px;">${stateTransitionHtml(s)}</div>
        <div class="sheet-reason">${s.reason || ""}</div>
        <button class="sheet-btn sheet-run" id="s-run">Run Now</button>
        <button class="sheet-btn sheet-yaml" id="s-yaml">Save as Automation</button>
        <button class="sheet-btn sheet-dismiss" id="s-dismiss">Dismiss</button>
        <button class="sheet-btn sheet-cancel" id="s-cancel">Cancel</button>
      </div>`;
    this.shadowRoot.appendChild(overlay);

    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#s-cancel").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#s-run").addEventListener("click", async () => {
      overlay.remove();
      this._callService(s);
      tile.classList.add("flash");
      setTimeout(() => tile.classList.remove("flash"), 600);
    });
    overlay.querySelector("#s-yaml").addEventListener("click", () => {
      overlay.remove();
      SmartSuggestionsWS.send({ type: "build_yaml", entity_id: s.entity_id, action: s.action || "", name: s.name || s.entity_id, reason: s.reason || "" });
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "saved", confScore(s));
    });
    overlay.querySelector("#s-dismiss").addEventListener("click", () => {
      overlay.remove();
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "dismissed", confScore(s));
      this._wsSuggestions = this._wsSuggestions.filter(x => x.entity_id !== s.entity_id);
      this._render();
    });
  }

  getCardSize() { return 3; }

  static getConfigElement() {
    const el = document.createElement("smart-suggestions-card-editor");
    el._cardType = "tile";
    return el;
  }

  static getStubConfig() {
    return { entity: "smart_suggestions.suggestions", columns: 2 };
  }
}

// ── Glance Card ─────────────────────────────────────────────────

class SmartSuggestionsGlanceCard extends SmartSuggestionsBaseCard {
  constructor() {
    super();
    this._spotlightOverlay = null;
  }

  _defaultConfig() {
    return {
      entity:        "smart_suggestions.suggestions",
      accent_color:  "#007AFF",
      show_reason:   false,
      on_tap:        "navigate",
      empty_message: "No suggestions",
      max_visible:   0,
    };
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._spotlightOverlay) {
      this._spotlightOverlay.remove();
      this._spotlightOverlay = null;
    }
  }

  _onWsUpdate(suggestions, isRefreshing) {
    super._onWsUpdate(suggestions, isRefreshing);
    if (this._spotlightOverlay) {
      this._spotlightOverlay._onWsUpdate(suggestions, false);
    }
  }

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color || "#007AFF";
    const suggestions = this._getSuggestions();
    const s = suggestions[0];
    const domain = s?.entity_id?.split(".")[0];
    const icon = s ? (DOMAIN_ICONS[domain] || "mdi:star-circle") : "mdi:star-circle";

    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
        .row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--ha-card-background, #1C1C1E); border-radius: 12px; cursor: pointer; min-height: 48px; -webkit-tap-highlight-color: transparent; }
        .row:active { background: rgba(255,255,255,0.05); }
        ha-icon { --mdc-icon-size: 22px; color: ${accent}; flex-shrink: 0; }
        .text { flex: 1; min-width: 0; }
        .name { font-size: 15px; color: var(--primary-text-color, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .reason { font-size: 12px; color: var(--secondary-text-color, #8E8E93); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
        .run-btn { background: none; border: none; color: ${accent}; font-size: 14px; font-weight: 600; cursor: pointer; padding: 4px 8px; flex-shrink: 0; -webkit-tap-highlight-color: transparent; }
        .empty { font-size: 13px; color: var(--secondary-text-color, #8E8E93); padding: 10px 12px; }
      </style>
      ${s ? `
        <div class="row" id="row">
          <ha-icon icon="${icon}"></ha-icon>
          <div class="text">
            <div class="name">${s.name || s.entity_id}</div>
            ${this._config.show_reason ? `<div class="reason">${stateTransitionHtml(s)} ${s.reason || ""}</div>` : ""}
          </div>
          <button class="run-btn" id="run-btn">Run</button>
        </div>` : `<div class="empty">${this._config.empty_message}</div>`}`;

    if (s) {
      this.shadowRoot.querySelector("#row").addEventListener("click", e => {
        if (e.target.closest("#run-btn")) return;
        const tap = this._config.on_tap;
        if (tap === "more-info") {
          this._showMoreInfo(s.entity_id);
        } else if (tap === "spotlight") {
          if (this._spotlightOverlay) {
            this._spotlightOverlay.remove();
            this._spotlightOverlay = null;
          }
          const overlay = document.createElement("smart-suggestions-spotlight-card");
          overlay.style.cssText = "position:fixed;inset:0;z-index:9999;padding:20px;background:rgba(0,0,0,0.7);display:flex;align-items:center;";
          overlay.setConfig(this._config);
          overlay.hass = this._hass;
          this._spotlightOverlay = overlay;
          document.body.appendChild(overlay);
          overlay.addEventListener("click", e => {
            if (e.target === overlay) {
              overlay.remove();
              this._spotlightOverlay = null;
            }
          });
        }
      });
      this.shadowRoot.querySelector("#run-btn").addEventListener("click", async e => {
        e.stopPropagation();
        this._callService(s);
      });
    }
  }

  getCardSize() { return 1; }

  static getConfigElement() {
    const el = document.createElement("smart-suggestions-card-editor");
    el._cardType = "glance";
    return el;
  }

  static getStubConfig() {
    return { entity: "smart_suggestions.suggestions" };
  }
}

// ── Banner Card ─────────────────────────────────────────────────

class SmartSuggestionsBannerCard extends SmartSuggestionsBaseCard {
  constructor() {
    super();
    this._dismissed = false;
  }

  _defaultConfig() {
    return {
      entity:       "smart_suggestions.suggestions",
      accent_color: "#007AFF",
      show_title:   false,
      title:        "",
      max_visible:  0,
    };
  }

  _onWsUpdate(suggestions, isRefreshing) {
    const newFirst = suggestions[0]?.entity_id;
    const oldFirst = this._wsSuggestions[0]?.entity_id;
    if (newFirst !== oldFirst) {
      this._dismissed = false;
    }
    super._onWsUpdate(suggestions, isRefreshing);
  }

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color || "#007AFF";
    const suggestions = this._getSuggestions();
    const s = suggestions[0];
    const visible = s && confidenceVisible(s.confidence) && !this._dismissed;

    if (!visible) {
      this.shadowRoot.innerHTML = "";
      return;
    }

    const domain = s.entity_id?.split(".")[0];
    const icon = DOMAIN_ICONS[domain] || "mdi:star-circle";

    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
        .banner { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: rgba(0,122,255,0.1); border-radius: 12px; border: 1px solid rgba(0,122,255,0.2); min-height: 48px; }
        ha-icon { --mdc-icon-size: 20px; color: ${accent}; flex-shrink: 0; }
        .reason { flex: 1; font-size: 13px; color: var(--primary-text-color, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
        .run-btn { background: none; border: none; color: ${accent}; font-size: 14px; font-weight: 600; cursor: pointer; flex-shrink: 0; padding: 4px 6px; -webkit-tap-highlight-color: transparent; }
        .dismiss-btn { background: none; border: none; color: var(--secondary-text-color, #8E8E93); font-size: 18px; cursor: pointer; flex-shrink: 0; padding: 0 4px; line-height: 1; -webkit-tap-highlight-color: transparent; }
      </style>
      <div class="banner">
        <ha-icon icon="${icon}"></ha-icon>
        <div class="reason" id="reason">${stateTransitionHtml(s)} ${s.reason || s.name || s.entity_id}</div>
        <button class="run-btn" id="run-btn">Run</button>
        <button class="dismiss-btn" id="dismiss-btn">&times;</button>
      </div>`;

    this.shadowRoot.querySelector("#reason").addEventListener("click", () => {
      this._showMoreInfo(s.entity_id);
    });
    this.shadowRoot.querySelector("#run-btn").addEventListener("click", async () => {
      this._callService(s);
      this._dismissed = true;
      this._render();
    });
    this.shadowRoot.querySelector("#dismiss-btn").addEventListener("click", () => {
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "dismissed", confScore(s));
      this._dismissed = true;
      this._render();
    });
  }

  getCardSize() { return 1; }

  static getConfigElement() {
    const el = document.createElement("smart-suggestions-card-editor");
    el._cardType = "banner";
    return el;
  }

  static getStubConfig() {
    return { entity: "smart_suggestions.suggestions" };
  }
}

// ── Shared Config Editor ────────────────────────────────────────

class SmartSuggestionsCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._domBuilt = false;
    this._cardType = "main"; // set by getConfigElement()
  }

  setConfig(config) {
    this._config = { ...config };
    // Detect card type from config context if not already set externally
    if (config._cardType) this._cardType = config._cardType;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._domBuilt && Object.keys(this._config).length) {
      this._render();
    } else {
      const picker = this.shadowRoot?.querySelector("ha-entity-picker");
      if (picker) picker.hass = hass;
    }
  }

  _fire(config) {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _setValue(key, value) {
    if (this._config[key] === value) return;
    this._config = { ...this._config, [key]: value };
    this._fire(this._config);
  }

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
    const t = this._cardType;
    const isMain = t === "main";
    const isTile = t === "tile";
    const isGlance = t === "glance";

    // All cards get entity, title, show_title, accent_color, max_visible, empty_message
    // Main adds: icon, show_refresh, show_last_updated, show_section_headers, show_feedback, compact, tap_action
    // Tile adds: columns
    // Glance adds: show_reason, on_tap

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
        .color-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .color-row label { font-size: 14px; color: var(--primary-text-color); flex: 1; }
        .color-row input[type="color"] { width: 44px; height: 32px; border: 1px solid var(--divider-color); border-radius: 8px; padding: 2px; cursor: pointer; background: none; }
        .color-clear { font-size: 12px; color: var(--secondary-text-color); cursor: pointer; text-decoration: underline; }
      </style>
      <div class="editor">
        <div class="section-title">Data</div>
        <ha-entity-picker id="entity" label="Suggestions entity" allow-custom-entity></ha-entity-picker>
        <ha-textfield id="addon_url" label="Add-on URL (optional, auto-detected)" placeholder="http://homeassistant.local:8099"></ha-textfield>

        <div class="section-title">Display</div>
        <ha-textfield id="title" label="Card title"></ha-textfield>
        ${isMain ? `<ha-icon-picker id="icon" label="Header icon"></ha-icon-picker>` : ""}
        <div class="toggle-row">
          <span class="toggle-label">Show title bar</span>
          <ha-switch id="show_title"></ha-switch>
        </div>
        ${isMain ? `
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
        </div>` : ""}
        ${isGlance ? `
        <div class="toggle-row">
          <span class="toggle-label">Show reason text</span>
          <ha-switch id="show_reason"></ha-switch>
        </div>` : ""}
        <ha-textfield id="empty_message" label="Empty state message"></ha-textfield>
        <div class="color-row">
          <label>Accent colour</label>
          <input type="color" id="accent_color">
          <span class="color-clear" id="color-clear">Reset</span>
        </div>

        <div class="section-title">Behaviour</div>
        ${isMain ? `
        <div class="native-select-wrap">
          <label class="native-select-label">Tap action</label>
          <select id="tap_action" class="native-select">
            <option value="execute">Execute (perform the action)</option>
            <option value="more-info">More info (open entity dialog)</option>
            <option value="expand">Expand (show reason only)</option>
          </select>
        </div>` : ""}
        ${isGlance ? `
        <div class="native-select-wrap">
          <label class="native-select-label">Tap action</label>
          <select id="on_tap" class="native-select">
            <option value="navigate">Navigate</option>
            <option value="more-info">More info</option>
            <option value="spotlight">Spotlight overlay</option>
          </select>
        </div>` : ""}
        ${isTile ? `
        <div class="native-select-wrap">
          <label class="native-select-label">Columns</label>
          <select id="columns" class="native-select">
            <option value="2">2 columns</option>
            <option value="3">3 columns</option>
          </select>
        </div>` : ""}
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

    const addonUrl = q("addon_url");
    if (addonUrl && !this._hasFocus(addonUrl)) {
      addonUrl.value = c.addon_url || "";
    }

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

    for (const key of ["show_title", "show_refresh", "show_last_updated", "show_section_headers", "show_feedback", "show_reason"]) {
      const el = q(key);
      if (el) el.checked = c[key] !== false;
    }
    const compact = q("compact");
    if (compact) compact.checked = c.compact === true;

    const color = q("accent_color");
    if (color) color.value = c.accent_color || "#3b82f6";

    const tapAction = q("tap_action");
    if (tapAction && !this._hasFocus(tapAction)) tapAction.value = c.tap_action || "execute";

    const onTap = q("on_tap");
    if (onTap && !this._hasFocus(onTap)) onTap.value = c.on_tap || "navigate";

    const columns = q("columns");
    if (columns && !this._hasFocus(columns)) columns.value = String(c.columns || 2);

    const maxVisible = q("max_visible");
    if (maxVisible && !this._hasFocus(maxVisible)) maxVisible.value = c.max_visible ?? 0;
  }

  _attachListeners() {
    const q = (id) => this.shadowRoot.querySelector(`#${id}`);

    q("entity")?.addEventListener("value-changed", (e) => this._setValue("entity", e.detail.value));
    q("addon_url")?.addEventListener("input", (e) => this._setValue("addon_url", e.target.value || null));
    q("title")?.addEventListener("input", (e) => this._setValue("title", e.target.value));
    q("icon")?.addEventListener("value-changed", (e) => this._setValue("icon", e.detail.value));
    q("empty_message")?.addEventListener("input", (e) => this._setValue("empty_message", e.target.value));

    for (const key of ["show_title", "show_refresh", "show_last_updated", "show_section_headers", "show_feedback", "compact", "show_reason"]) {
      q(key)?.addEventListener("change", (e) => this._setValue(key, e.target.checked));
    }

    q("accent_color")?.addEventListener("input", (e) => this._setValue("accent_color", e.target.value));

    q("color-clear")?.addEventListener("click", () => {
      delete this._config.accent_color;
      this._fire(this._config);
      this._syncFields();
    });

    q("tap_action")?.addEventListener("change", (e) => this._setValue("tap_action", e.target.value));
    q("on_tap")?.addEventListener("change", (e) => this._setValue("on_tap", e.target.value));
    q("columns")?.addEventListener("change", (e) => this._setValue("columns", parseInt(e.target.value)));

    q("max_visible")?.addEventListener("input", (e) => {
      const v = parseInt(e.target.value);
      this._setValue("max_visible", isNaN(v) ? 0 : Math.max(0, v));
    });
  }
}

// ── Register all elements ───────────────────────────────────────

customElements.define("smart-suggestions-card", SmartSuggestionsCard);
customElements.define("smart-suggestions-card-editor", SmartSuggestionsCardEditor);
customElements.define("smart-suggestions-spotlight-card", SmartSuggestionsSpotlightCard);
customElements.define("smart-suggestions-chip-card", SmartSuggestionsChipCard);
customElements.define("smart-suggestions-tile-card", SmartSuggestionsTileCard);
customElements.define("smart-suggestions-glance-card", SmartSuggestionsGlanceCard);
customElements.define("smart-suggestions-banner-card", SmartSuggestionsBannerCard);

// ── Card picker registration ────────────────────────────────────

window.customCards = window.customCards || [];

const CARD_DEFS = [
  { type: "smart-suggestions-card",           name: "Smart Suggestions",            description: "AI-powered contextual suggestions — full list view" },
  { type: "smart-suggestions-spotlight-card",  name: "Smart Suggestions Spotlight",  description: "Full-screen carousel of suggestions" },
  { type: "smart-suggestions-chip-card",       name: "Smart Suggestions Chips",      description: "Horizontal scrolling chip bar" },
  { type: "smart-suggestions-tile-card",       name: "Smart Suggestions Tiles",      description: "Grid of suggestion tiles" },
  { type: "smart-suggestions-glance-card",     name: "Smart Suggestions Glance",     description: "Single-row at-a-glance suggestion" },
  { type: "smart-suggestions-banner-card",     name: "Smart Suggestions Banner",     description: "Minimal dismissible banner" },
];

CARD_DEFS.forEach(def => {
  if (!window.customCards.find(c => c.type === def.type)) {
    window.customCards.push({ ...def, preview: false, configurable: true });
  }
});

console.info(
  `%c SMART-SUGGESTIONS-CARD %c v${CARD_VERSION} `,
  "background:#3b82f6;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px;font-weight:700",
  "background:#1e293b;color:#94a3b8;padding:2px 6px;border-radius:0 4px 4px 0"
);
