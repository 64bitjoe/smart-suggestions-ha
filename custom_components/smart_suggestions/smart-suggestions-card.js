/**
 * Smart Suggestions Card
 * AI-powered contextual action suggestions for Home Assistant
 * Drop in /config/www/smart-suggestions-card.js
 */

const CARD_VERSION = "1.0.4";

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

class SmartSuggestionsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._expandedIndex = null;
    this._isRefreshing = false;
    this._lastStateStr = null;
    // Streaming / add-on WebSocket state
    this._ws = null;
    this._wsConnected = false;
    this._streamingBuffer = "";
    this._streamingSuggestions = [];
    this._wsRetryTimeout = null;
    this._wsEnabled = false;
    this._wsRetryDelay = 5000;
  }

  setConfig(config) {
    this._config = {
      entity: config.entity || "smart_suggestions.suggestions",
      title: config.title !== undefined ? config.title : "Suggested for You",
      show_title: config.show_title !== false,
      show_refresh: config.show_refresh !== false,
      show_last_updated: config.show_last_updated !== false,
      accent_color: config.accent_color || null,
      empty_message: config.empty_message || "Thinking of suggestions…",
      addon_url: config.addon_url || null,
      ...config,
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
      case "streaming": {
        this._streamingBuffer += (msg.token || "");
        // Show streaming state in the card header
        if (!this._isRefreshing) {
          this._isRefreshing = true;
          this._render();
        }
        break;
      }
      case "suggestions": {
        this._streamingBuffer = "";
        this._isRefreshing = false;
        // Directly inject suggestions — bypasses HA state polling
        this._streamingSuggestions = Array.isArray(msg.data) ? msg.data : [];
        this._render();
        break;
      }
      case "status": {
        const isUpdating = msg.state === "updating";
        if (isUpdating !== this._isRefreshing) {
          this._isRefreshing = isUpdating;
          if (!isUpdating) this._streamingBuffer = "";
          this._render();
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
    if (this._wsConnected && Array.isArray(this._streamingSuggestions) && this._streamingSuggestions.length) {
      return this._streamingSuggestions;
    }
    // Fallback: read from HA state (works without the add-on)
    if (!this._hass) return [];
    const state = this._hass.states[this._config.entity];
    if (!state) return [];
    const s = state.attributes.suggestions;
    return Array.isArray(s) ? s : [];
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
    if (suggestion.icon) return suggestion.icon;
    if (suggestion.entity_id) {
      const domain = suggestion.entity_id.split(".")[0];
      return DOMAIN_ICONS[domain] || "mdi:star-circle";
    }
    return "mdi:star-circle";
  }

  async _callAction(suggestion) {
    if (!this._hass) return;
    const { entity_id, action, action_data, type } = suggestion;
    try {
      if (action === "navigate" && action_data?.path) {
        history.pushState(null, "", action_data.path);
        window.dispatchEvent(new PopStateEvent("popstate"));
        return;
      }
      if (type === "automation" || action === "trigger") {
        await this._hass.callService("automation", "trigger", { entity_id });
        return;
      }
      if (type === "script") {
        await this._hass.callService("script", "turn_on", { entity_id });
        return;
      }
      const domain = entity_id.split(".")[0];
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
    this._attachListeners();
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
    const accent = this._config.accent_color || "var(--primary-color, #3b82f6)";
    const suggestions = this._getSuggestions();
    const status = this._getStatus();
    const isUpdating = status === "updating" || this._isRefreshing;
    const lastUpdated = this._getLastUpdated();

    const styles = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :host { display: block; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
      .card { background: var(--ha-card-background, var(--card-background-color, #1c1c1e)); border-radius: 16px; overflow: hidden; border: 1px solid rgba(255,255,255,0.06); }
      .header { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
      .header-left { display: flex; align-items: center; gap: 10px; }
      .header-icon { width: 32px; height: 32px; border-radius: 9px; background: ${accent}; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .header-icon ha-icon { --mdc-icon-size: 18px; color: white; }
      .title { font-size: 14px; font-weight: 600; color: var(--primary-text-color, #f1f1f1); letter-spacing: -0.01em; line-height: 1.2; }
      .subtitle { font-size: 11px; color: var(--secondary-text-color, #888); margin-top: 1px; }
      .header-actions { display: flex; align-items: center; gap: 6px; }
      .refresh-btn { width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.06); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s; color: var(--secondary-text-color, #888); }
      .refresh-btn:hover { background: rgba(255,255,255,0.1); }
      .refresh-btn ha-icon { --mdc-icon-size: 16px; transition: transform 0.6s ease; }
      .refresh-btn.spinning ha-icon { animation: spin 1s linear infinite; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: ${accent}; opacity: ${isUpdating ? "1" : "0.4"}; animation: ${isUpdating ? "pulse 1s ease-in-out infinite" : "none"}; flex-shrink: 0; }
      @keyframes pulse { 0%, 100% { opacity: 0.4; transform: scale(1); } 50% { opacity: 1; transform: scale(1.3); } }
      .streaming-indicator { font-size: 11px; color: ${accent}; opacity: 0.85; display: flex; align-items: center; gap: 4px; }
      .typing-dots span { display: inline-block; width: 4px; height: 4px; border-radius: 50%; background: ${accent}; margin: 0 1px; animation: typing-bounce 1.2s ease-in-out infinite; }
      .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
      .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes typing-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.4; } 40% { transform: translateY(-3px); opacity: 1; } }
      .list { padding: 6px 0; }
      .row { display: flex; flex-direction: column; border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.15s; position: relative; overflow: hidden; }
      .row:last-child { border-bottom: none; }
      .row.flash { animation: flash-bg 0.7s ease; }
      @keyframes flash-bg { 0% { background: rgba(74,222,128,0); } 30% { background: rgba(74,222,128,0.15); } 100% { background: rgba(74,222,128,0); } }
      .row-main { display: flex; align-items: center; padding: 10px 14px; cursor: pointer; gap: 12px; user-select: none; -webkit-tap-highlight-color: transparent; }
      .row-main:hover { background: rgba(255,255,255,0.03); }
      .row-main:active { background: rgba(255,255,255,0.06); }
      .icon-wrap { width: 38px; height: 38px; border-radius: 11px; background: rgba(255,255,255,0.07); display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; }
      .icon-wrap ha-icon { --mdc-icon-size: 20px; color: var(--primary-text-color, #e8e8e8); }
      .action-dot { position: absolute; bottom: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--ha-card-background, #1c1c1e); }
      .row-info { flex: 1; min-width: 0; }
      .row-name { font-size: 13.5px; font-weight: 500; color: var(--primary-text-color, #f1f1f1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
      .row-meta { font-size: 11.5px; color: var(--secondary-text-color, #777); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .row-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .info-btn { width: 28px; height: 28px; border-radius: 8px; background: rgba(255,255,255,0.06); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--secondary-text-color, #777); transition: background 0.15s, color 0.15s; flex-shrink: 0; }
      .info-btn:hover, .info-btn.active { background: ${accent}22; color: ${accent}; }
      .info-btn ha-icon { --mdc-icon-size: 15px; }
      .reason-panel { padding: 0 14px 12px 64px; display: none; animation: slide-down 0.2s ease; }
      .reason-panel.open { display: block; }
      @keyframes slide-down { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      .reason-bubble { background: rgba(255,255,255,0.05); border-left: 2px solid ${accent}; border-radius: 0 8px 8px 0; padding: 8px 12px; font-size: 12px; line-height: 1.5; color: var(--secondary-text-color, #aaa); }
      .reason-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: ${accent}; margin-bottom: 3px; opacity: 0.8; }
      .empty { padding: 32px 20px; text-align: center; color: var(--secondary-text-color, #666); font-size: 13px; }
      .empty ha-icon { --mdc-icon-size: 36px; display: block; margin: 0 auto 10px; opacity: 0.3; }
      .skeleton { padding: 8px 14px; display: flex; align-items: center; gap: 12px; }
      .skel-icon { width: 38px; height: 38px; border-radius: 11px; background: rgba(255,255,255,0.07); animation: shimmer 1.5s ease-in-out infinite; flex-shrink: 0; }
      .skel-lines { flex: 1; }
      .skel-line { height: 10px; border-radius: 5px; background: rgba(255,255,255,0.07); animation: shimmer 1.5s ease-in-out infinite; margin-bottom: 6px; }
      .skel-line:last-child { width: 60%; margin-bottom: 0; }
      @keyframes shimmer { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.7; } }
    `;

    const headerHtml = this._config.show_title ? `
      <div class="header">
        <div class="header-left">
          <div class="header-icon"><ha-icon icon="mdi:sparkles"></ha-icon></div>
          <div class="header-text">
            <div class="title">${this._config.title}</div>
            ${isUpdating && this._wsConnected
              ? `<div class="subtitle streaming-indicator"><span class="typing-dots"><span></span><span></span><span></span></span> Thinking…</div>`
              : this._config.show_last_updated && lastUpdated
                ? `<div class="subtitle">Updated ${this._formatRelativeTime(lastUpdated)}</div>`
                : `<div class="subtitle">Based on current context</div>`
            }
          </div>
        </div>
        <div class="header-actions">
          <div class="status-dot"></div>
          ${this._config.show_refresh ? `
            <button class="refresh-btn ${isUpdating || this._isRefreshing ? "spinning" : ""}" id="refresh-btn" title="Refresh suggestions">
              <ha-icon icon="mdi:refresh"></ha-icon>
            </button>
          ` : ""}
        </div>
      </div>
    ` : "";

    let listHtml = "";

    if (isUpdating && suggestions.length === 0) {
      listHtml = `<div class="list">` + Array(4).fill(0).map(() => `
        <div class="skeleton">
          <div class="skel-icon"></div>
          <div class="skel-lines"><div class="skel-line"></div><div class="skel-line"></div></div>
        </div>
      `).join("") + `</div>`;
    } else if (suggestions.length === 0) {
      listHtml = `<div class="empty"><ha-icon icon="mdi:shimmer"></ha-icon>${this._config.empty_message}</div>`;
    } else {
      const rows = suggestions.map((s, i) => {
        const icon = this._resolveIcon(s);
        const actionDotColor = this._getActionDot(s.action);
        const actionLabel = this._getActionLabel(s.action);
        const isExpanded = this._expandedIndex === i;
        let metaText = actionLabel;
        if (s.entity_id && this._hass) {
          const entityState = this._hass.states[s.entity_id];
          if (entityState) {
            const domain = s.entity_id.split(".")[0];
            if (domain !== "automation" && domain !== "script") {
              metaText = `${actionLabel} · ${entityState.state}`;
            }
          }
        }
        return `
          <div class="row" data-entity="${s.entity_id || ""}" data-index="${i}">
            <div class="row-main" data-action="${i}">

              <div class="icon-wrap">
                <ha-icon icon="${icon}"></ha-icon>
                <div class="action-dot" style="background:${actionDotColor}"></div>
              </div>
              <div class="row-info">
                <div class="row-name">${s.name || s.entity_id}</div>
                <div class="row-meta">${metaText}</div>
              </div>
              <div class="row-actions">
                <button class="info-btn ${isExpanded ? "active" : ""}" data-info="${i}" title="Why this suggestion?">
                  <ha-icon icon="mdi:information-outline"></ha-icon>
                </button>
              </div>
            </div>
            <div class="reason-panel ${isExpanded ? "open" : ""}">
              <div class="reason-bubble">
                <div class="reason-label">Why suggested</div>
                ${s.reason || "No reason provided."}
              </div>
            </div>
          </div>
        `;
      }).join("");
      listHtml = `<div class="list">${rows}</div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <ha-card class="card">${headerHtml}${listHtml}</ha-card>
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
        if (e.target.closest("[data-info]")) return;
        const index = parseInt(el.dataset.action);
        const suggestions = this._getSuggestions();
        if (suggestions[index]) this._callAction(suggestions[index]);
      });
    });
    this.shadowRoot.querySelectorAll("[data-info]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this._toggleExpand(parseInt(el.dataset.info));
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
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // Re-render so entity picker can access hass if it loaded late
    if (Object.keys(this._config).length) this._render();
  }

  _fire(config) {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _setValue(key, value) {
    this._config = { ...this._config, [key]: value };
    this._fire(this._config);
  }

  _render() {
    const c = this._config;

    this.shadowRoot.innerHTML = `
      <style>
        .editor { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; }
        .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--secondary-text-color); margin-bottom: -6px; }
        ha-textfield { width: 100%; }
        .toggle-row { display: flex; align-items: center; justify-content: space-between; height: 40px; }
        .toggle-label { font-size: 14px; color: var(--primary-text-color); }
        .color-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .color-row label { font-size: 14px; color: var(--primary-text-color); flex: 1; }
        .color-row input[type="color"] { width: 44px; height: 32px; border: 1px solid var(--divider-color); border-radius: 8px; padding: 2px; cursor: pointer; background: none; }
        .color-clear { font-size: 12px; color: var(--secondary-text-color); cursor: pointer; text-decoration: underline; }
      </style>
      <div class="editor">
        <div class="section-title">Data</div>

        <ha-entity-picker
          id="entity"
          label="Suggestions entity"
          .value="${c.entity || "smart_suggestions.suggestions"}"
          .hass="${this._hass}"
          allow-custom-entity
        ></ha-entity-picker>

        <div class="section-title">Display</div>

        <ha-textfield
          id="title"
          label="Card title"
          .value="${c.title !== undefined ? c.title : "Suggested for You"}"
        ></ha-textfield>

        <div class="toggle-row">
          <span class="toggle-label">Show title</span>
          <ha-switch id="show_title" ?checked="${c.show_title !== false}"></ha-switch>
        </div>

        <div class="toggle-row">
          <span class="toggle-label">Show refresh button</span>
          <ha-switch id="show_refresh" ?checked="${c.show_refresh !== false}"></ha-switch>
        </div>

        <div class="toggle-row">
          <span class="toggle-label">Show last updated time</span>
          <ha-switch id="show_last_updated" ?checked="${c.show_last_updated !== false}"></ha-switch>
        </div>

        <ha-textfield
          id="empty_message"
          label="Empty state message"
          .value="${c.empty_message || "Thinking of suggestions…"}"
        ></ha-textfield>

        <div class="color-row">
          <label for="accent_color">Accent colour</label>
          <input type="color" id="accent_color" value="${c.accent_color || "#3b82f6"}">
          <span class="color-clear" id="color-clear">Reset</span>
        </div>
      </div>
    `;

    this._attachListeners();
  }

  _attachListeners() {
    const q = (id) => this.shadowRoot.querySelector(`#${id}`);

    const entityPicker = q("entity");
    if (entityPicker) {
      entityPicker.addEventListener("value-changed", (e) => {
        this._setValue("entity", e.detail.value);
      });
    }

    const titleField = q("title");
    if (titleField) {
      titleField.addEventListener("change", (e) => this._setValue("title", e.target.value));
    }

    const emptyField = q("empty_message");
    if (emptyField) {
      emptyField.addEventListener("change", (e) => this._setValue("empty_message", e.target.value));
    }

    for (const key of ["show_title", "show_refresh", "show_last_updated"]) {
      const el = q(key);
      if (el) {
        el.addEventListener("change", (e) => this._setValue(key, e.target.checked));
      }
    }

    const colorInput = q("accent_color");
    if (colorInput) {
      colorInput.addEventListener("input", (e) => this._setValue("accent_color", e.target.value));
    }

    const colorClear = q("color-clear");
    if (colorClear) {
      colorClear.addEventListener("click", () => {
        this._config = { ...this._config };
        delete this._config.accent_color;
        this._fire(this._config);
        this._render();
      });
    }
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
