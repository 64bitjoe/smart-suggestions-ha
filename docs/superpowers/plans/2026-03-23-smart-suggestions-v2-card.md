# Smart Suggestions v2 — Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the intermittent render/config error and add five new Lovelace card types (Spotlight, Chip Bar, Tile Grid, Glance, Context Banner) alongside the improved existing list card, all sharing a single WebSocket connection and reporting user outcomes to the add-on.

**Architecture:** A `SmartSuggestionsWS` singleton manages the shared WebSocket connection and broadcasts suggestions to all registered card instances. Shared helpers (`reportOutcome`, `confidenceColor`, `confidenceVisible`) are module-level functions. Each card type is a separate class registered via `customElements.define`. All cards accept an optional `suggestions` property for testability without a live WS connection.

**Tech Stack:** Vanilla JS, Web Components (shadow DOM), Home Assistant Lovelace card API, no build step

**Working directory:** `/Users/jgray/Desktop/smart-suggestions-ha`

**Testing approach:** No automated test framework for browser JS — each task has a manual verification checklist instead. Use browser console and HA developer tools to verify.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `custom_components/smart_suggestions/smart-suggestions-card.js` | **Modify** | All card classes live in this single file. Add singleton, helpers, bug fix, 5 new card classes, version bump. |

---

## How to test during development

1. Copy the file to your HA `/config/www/smart-suggestions-card.js`
2. Hard-refresh the browser (Ctrl+Shift+R / Cmd+Shift+R)
3. Open browser console (F12) to check for errors
4. Each task lists what to verify

---

## Task 1: Bug Fix — Render Guard + CARD_VERSION Bump

**Files:**
- Modify: `custom_components/smart_suggestions/smart-suggestions-card.js`

**Problem:** `_renderInner()` can be called before `this._hass` is set (during view transitions or fast navigation), causing attribute access on undefined and the "Configuration error" banner.

- [ ] **Step 1: Add render guard**

Find `_renderInner()` at the top of the method body. Add as the very first line:

```js
_renderInner() {
  if (!this._config || !this._hass) return;
  // ... rest of existing method unchanged
```

- [ ] **Step 2: Bump version**

Find:
```js
const CARD_VERSION = "1.1.0";
```
Change to:
```js
const CARD_VERSION = "1.2.0";
```

- [ ] **Step 3: Manual verification**

Deploy to HA. Navigate rapidly between dashboard views 5+ times. Open browser console.

Expected: No "Configuration error" flash, no JS exceptions in console.

- [ ] **Step 4: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-ha
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "fix: add render guard to prevent config error on fast navigation, bump card to 1.2.0"
```

---

## Task 2: Module-Level Shared Infrastructure

**Files:**
- Modify: `custom_components/smart_suggestions/smart-suggestions-card.js`

Add the shared singleton and helpers **after** the existing `DOMAIN_COLORS` constant and **before** the `SmartSuggestionsCard` class definition.

- [ ] **Step 1: Add shared helpers**

```js
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
```

- [ ] **Step 2: Add `SmartSuggestionsWS` singleton**

```js
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
          // Forward all other messages (e.g. yaml_result) to all cards
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
      // Note: if connectedCallback fires before setConfig, card._config will be {}.
      // The guard above prevents overwriting a valid config with an empty one.
      // Immediately broadcast cached suggestions to the new card
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
  };
})();
```

- [ ] **Step 3: Update existing `SmartSuggestionsCard` to use singleton**

In `SmartSuggestionsCard`:

Replace the `connectedCallback` (or add one if missing) to register with the singleton:
```js
connectedCallback() {
  SmartSuggestionsWS.register(this);
}

disconnectedCallback() {
  SmartSuggestionsWS.unregister(this);
  if (this._wsRetryTimeout) { clearTimeout(this._wsRetryTimeout); this._wsRetryTimeout = null; }
}
```

Add the WS update callback:
```js
_onWsUpdate(suggestions, isRefreshing) {
  this._wsSuggestions = suggestions;
  this._isRefreshing = isRefreshing;
  this._render();
}

_onWsMessage(msg) {
  this._handleWsMessage(msg);
}
```

Remove the old `_connectWS()`, `_getAddonWsUrl()`, and direct `this._ws` management from `SmartSuggestionsCard` — the singleton handles all of it. Keep `_handleWsMessage` for the `automation_result` handler (modal/toast).

Update `_sendFeedback` and `_saveAutomation` to use `SmartSuggestionsWS.send()` instead of `this._ws.send()`.

Update `_wsConnected` checks — replace `this._wsConnected` with `SmartSuggestionsWS.ws !== null`.

**Verification:** Search the file for `this._ws` and `this._wsRetryTimeout` and `this._wsConnected`. Confirm zero remaining direct property references in `SmartSuggestionsCard`. Any remaining references should use `SmartSuggestionsWS.ws` instead.

- [ ] **Step 4: Manual verification**

Add TWO list cards to a dashboard. Confirm only one WebSocket connection appears in Network tab (browser DevTools → Network → WS). Navigate away and back — confirm connection re-establishes.

- [ ] **Step 5: Commit**

```bash
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: add SmartSuggestionsWS singleton — shared WS connection across all card types"
```

---

## Task 3: Add YAML Drawer to All Suggestions + Outcome Reporting

**Files:**
- Modify: `custom_components/smart_suggestions/smart-suggestions-card.js`

Currently the YAML drawer only opens on `automation_result` failure. We want a "Get YAML" button in the expanded reason panel for any suggestion.

- [ ] **Step 1: Add "Get YAML" button to expanded reason panel**

In `_renderInner()`, find where the reason expansion panel is built (`.reason-inner`). Add after the reason text:

```js
const yamlBtn = `<button class="get-yaml-btn" data-eid="${this._escapeHtml(s.entity_id)}" data-action="${this._escapeHtml(s.action || '')}">Get Automation YAML</button>`;
```

Add CSS for `.get-yaml-btn`:
```css
.get-yaml-btn { margin-top: 8px; background: none; border: 1px solid ${accent}; color: ${accent}; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.get-yaml-btn.loading { opacity: 0.5; pointer-events: none; }
```

- [ ] **Step 2: Wire "Get YAML" button click**

In the event delegation section of `_renderInner()` (where clicks are handled), add:
```js
const yamlBtnEl = e.target.closest(".get-yaml-btn");
if (yamlBtnEl) {
  const eid = yamlBtnEl.dataset.eid;
  const action = yamlBtnEl.dataset.action;
  const suggestion = suggestions.find(s => s.entity_id === eid);
  yamlBtnEl.classList.add("loading");
  yamlBtnEl.textContent = "Building…";
  SmartSuggestionsWS.send({
    type: "build_yaml",
    entity_id: eid,
    action: action,
    name: suggestion?.name || eid,
    reason: suggestion?.reason || "",
  });
}
```

- [ ] **Step 3: Handle `yaml_result` in `_handleWsMessage`**

Add a case to `_handleWsMessage`:
```js
case "yaml_result": {
  // Re-enable any loading Get YAML buttons
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
```

- [ ] **Step 4: Add outcome reporting on Run and Dismiss**

Find where the row main click triggers `_callAction`. After a successful action call, add:
```js
reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "run", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
```

For dismiss (if implemented) or thumbs-down feedback, add:
```js
reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "dismissed", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
```

- [ ] **Step 5: Manual verification**

Expand a suggestion. Verify "Get Automation YAML" button appears. Tap it — verify loading state, then YAML drawer appears (may show error if add-on not updated yet, which is fine).

- [ ] **Step 6: Commit**

```bash
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: add on-demand YAML button to all suggestions + outcome reporting"
```

---

## Task 4: Spotlight Card — `smart-suggestions-spotlight-card`

**Files:**
- Modify: `custom_components/smart_suggestions/smart-suggestions-card.js`

Add a new class at the end of the file (before the `customElements.define` calls).

- [ ] **Step 1: Implement `SmartSuggestionsSpotlightCard`**

```js
class SmartSuggestionsSpotlightCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._suggestions = [];
    this._isRefreshing = false;
    this._currentIndex = 0;
  }

  setConfig(config) {
    this._config = {
      title:         config.title !== undefined ? config.title : "Suggested for You",
      show_title:    config.show_title !== false,
      accent_color:  config.accent_color || "#007AFF",
      max_visible:   parseInt(config.max_visible) || 0,
      empty_message: config.empty_message || "Thinking of suggestions…",
    };
    requestAnimationFrame(() => this._render());
  }

  connectedCallback() { SmartSuggestionsWS.register(this); }
  disconnectedCallback() { SmartSuggestionsWS.unregister(this); }

  set hass(hass) { this._hass = hass; }

  _onWsUpdate(suggestions, isRefreshing) {
    const max = this._config.max_visible;
    this._suggestions = max > 0 ? suggestions.slice(0, max) : suggestions;
    this._isRefreshing = isRefreshing;
    if (this._currentIndex >= this._suggestions.length) this._currentIndex = 0;
    this._render();
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
        <div class="yaml-header"><span>Automation YAML</span><button id="yclose">&times;</button></div>
        ${error ? `<div class="yaml-error">${error}</div>` : ""}
        <pre class="yaml-pre">${yaml.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</pre>
        ${yaml ? `<button id="ycopy">Copy YAML</button>` : ""}
      </div>`;
    this.shadowRoot.appendChild(overlay);
    overlay.querySelector("#yclose").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    if (yaml) {
      overlay.querySelector("#ycopy").addEventListener("click", () => {
        navigator.clipboard.writeText(yaml).then(() => {
          overlay.querySelector("#ycopy").textContent = "Copied!";
        }).catch(() => {});
      });
    }
  }

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color;
    const s = this._suggestions[this._currentIndex];
    const total = this._suggestions.length;

    const icon = s ? (DOMAIN_ICONS[s.entity_id?.split(".")[0]] || "mdi:star-circle") : "mdi:star-circle";
    const iconColor = s ? (DOMAIN_COLORS[s.entity_id?.split(".")[0]] || accent) : accent;

    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
        .card { background: var(--ha-card-background, #1C1C1E); border-radius: 16px; padding: 20px 16px 16px; }
        .title-row { font-size: 13px; font-weight: 600; color: var(--secondary-text-color, #8E8E93); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 16px; }
        .icon-wrap { width: 64px; height: 64px; border-radius: 18px; background: ${iconColor}; display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; }
        .icon-wrap ha-icon { --mdc-icon-size: 36px; color: #fff; }
        .name { font-size: 20px; font-weight: 600; color: var(--primary-text-color, #fff); text-align: center; margin-bottom: 6px; }
        .reason { font-size: 14px; color: var(--secondary-text-color, #8E8E93); text-align: center; line-height: 1.5; margin-bottom: 10px; min-height: 42px; }
        .badge { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; padding: 2px 8px; border-radius: 20px; margin-bottom: 16px; }
        .badge.high { background: rgba(52,199,89,0.15); color: #34C759; }
        .badge.medium { background: rgba(255,159,10,0.15); color: #FF9F0A; }
        .badge.low { background: rgba(142,142,147,0.12); color: #8E8E93; }
        .actions { display: flex; gap: 8px; margin-bottom: 14px; }
        .btn { flex: 1; padding: 10px 4px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: opacity 0.15s; }
        .btn:active { opacity: 0.7; }
        .btn-run { background: ${accent}; color: #fff; }
        .btn-yaml { background: rgba(255,255,255,0.1); color: var(--primary-text-color, #fff); }
        .btn-dismiss { background: rgba(255,255,255,0.07); color: var(--secondary-text-color, #8E8E93); }
        .nav { display: flex; align-items: center; justify-content: center; gap: 12px; }
        .nav-btn { background: none; border: none; color: ${accent}; cursor: pointer; padding: 4px 8px; font-size: 20px; -webkit-tap-highlight-color: transparent; }
        .nav-btn:disabled { opacity: 0.3; cursor: default; }
        .dots { display: flex; gap: 5px; }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.25); }
        .dot.active { background: ${accent}; }
        .empty { text-align: center; padding: 32px 16px; color: var(--secondary-text-color, #8E8E93); font-size: 14px; }
        .thinking { display: flex; justify-content: center; gap: 4px; padding: 32px 0; }
        .thinking span { width: 6px; height: 6px; border-radius: 50%; background: ${accent}; animation: tdot 1.2s ease-in-out infinite; }
        .thinking span:nth-child(2) { animation-delay: 0.2s; }
        .thinking span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes tdot { 0%,80%,100% { transform:translateY(0);opacity:0.35; } 40% { transform:translateY(-3px);opacity:1; } }
        .yaml-overlay { position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:flex-end; }
        .yaml-drawer { background:var(--ha-card-background,#1C1C1E);width:100%;border-radius:16px 16px 0 0;padding:16px;max-height:60vh;overflow-y:auto; }
        .yaml-header { display:flex;justify-content:space-between;align-items:center;margin-bottom:12px; }
        .yaml-pre { font-size:12px;overflow-x:auto;white-space:pre;color:var(--primary-text-color,#fff); }
        #yclose { background:none;border:none;color:var(--primary-text-color,#fff);font-size:22px;cursor:pointer; }
        #ycopy { margin-top:12px;background:${accent};color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;width:100%; }
        .yaml-error { color: #f87171; font-size: 13px; margin-bottom: 8px; }
      </style>
      <ha-card>
        <div class="card">
          ${this._config.show_title ? `<div class="title-row">${this._config.title}</div>` : ""}
          ${this._isRefreshing ? `<div class="thinking"><span></span><span></span><span></span></div>` :
            !s ? `<div class="empty">${this._config.empty_message}</div>` : `
            <div style="text-align:center">
              <div class="icon-wrap"><ha-icon icon="${icon}"></ha-icon></div>
              <div class="name">${s.name || s.entity_id}</div>
              <div class="reason">${s.reason || ""}</div>
              <div class="badge ${s.confidence || "low"}">${s.confidence || "low"}</div>
            </div>
            <div class="actions">
              <button class="btn btn-run" id="btn-run">Run</button>
              <button class="btn btn-yaml" id="btn-yaml">Get YAML</button>
              <button class="btn btn-dismiss" id="btn-dismiss">Dismiss</button>
            </div>
            <div class="nav">
              <button class="nav-btn" id="btn-prev" ${this._currentIndex === 0 ? "disabled" : ""}>‹</button>
              <div class="dots">${this._suggestions.map((_, i) =>
                `<div class="dot ${i === this._currentIndex ? "active" : ""}"></div>`
              ).join("")}</div>
              <button class="nav-btn" id="btn-next" ${this._currentIndex >= total - 1 ? "disabled" : ""}>›</button>
            </div>
          `}
        </div>
      </ha-card>`;

    if (s) {
      this.shadowRoot.querySelector("#btn-run")?.addEventListener("click", async () => {
        if (!this._hass) return;
        const domain = s.entity_id.split(".")[0];
        const svc = s.action || (domain === "scene" ? "turn_on" : "toggle");
        try { await this._hass.callService(domain, svc, { entity_id: s.entity_id }); } catch (_) {}
        reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "run", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
        this._currentIndex = Math.min(this._currentIndex + 1, this._suggestions.length - 1);
        this._render();
      });

      this.shadowRoot.querySelector("#btn-yaml")?.addEventListener("click", () => {
        SmartSuggestionsWS.send({ type: "build_yaml", entity_id: s.entity_id, action: s.action || "", name: s.name || s.entity_id, reason: s.reason || "" });
      });

      this.shadowRoot.querySelector("#btn-dismiss")?.addEventListener("click", () => {
        reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "dismissed", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
        this._currentIndex = Math.min(this._currentIndex + 1, this._suggestions.length - 1);
        this._render();
      });

      this.shadowRoot.querySelector("#btn-prev")?.addEventListener("click", () => {
        if (this._currentIndex > 0) { this._currentIndex--; this._render(); }
      });
      this.shadowRoot.querySelector("#btn-next")?.addEventListener("click", () => {
        if (this._currentIndex < this._suggestions.length - 1) { this._currentIndex++; this._render(); }
      });
    }
  }

  static getConfigElement() { return document.createElement("div"); }
  static getStubConfig() { return {}; }
}
```

- [ ] **Step 2: Register the card**

At the bottom of the file, add alongside existing `customElements.define` call:
```js
customElements.define("smart-suggestions-spotlight-card", SmartSuggestionsSpotlightCard);
```

- [ ] **Step 3: Manual verification**

Add to dashboard YAML:
```yaml
type: custom:smart-suggestions-spotlight-card
```

Expected: Card renders with icon, name, reason, confidence badge, Run/Get YAML/Dismiss buttons, dot pagination. Tapping Next advances to next suggestion. Tapping Dismiss moves forward and removes current from cycle.

- [ ] **Step 4: Commit**

```bash
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: add SmartSuggestionsSpotlightCard — hero single-suggestion card with navigation"
```

---

## Task 5: Chip Bar Card — `smart-suggestions-chip-card`

- [ ] **Step 1: Implement `SmartSuggestionsChipCard`**

Add after the Spotlight class:

```js
class SmartSuggestionsChipCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._suggestions = [];
    this._isRefreshing = false;
    this._dismissed = new Set();
    this._longPressTimer = null;
    this._pressOrigin = null;
  }

  setConfig(config) {
    this._config = {
      title:        config.title !== undefined ? config.title : "",
      show_title:   config.show_title === true,
      accent_color: config.accent_color || "#007AFF",
      max_visible:  parseInt(config.max_visible) || 5,
      empty_message: config.empty_message || "No suggestions right now",
    };
    requestAnimationFrame(() => this._render());
  }

  connectedCallback() { SmartSuggestionsWS.register(this); }
  disconnectedCallback() {
    SmartSuggestionsWS.unregister(this);
    if (this._longPressTimer) clearTimeout(this._longPressTimer);
  }

  set hass(hass) { this._hass = hass; }

  _onWsUpdate(suggestions, isRefreshing) {
    const max = this._config.max_visible;
    this._suggestions = suggestions.slice(0, max).filter(s => !this._dismissed.has(s.entity_id));
    this._isRefreshing = isRefreshing;
    this._render();
  }

  _onWsMessage() {}

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color;

    const chips = this._suggestions.map((s, i) => {
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
      const s = this._suggestions[i];
      if (!s) return;

      chip.addEventListener("click", async () => {
        if (!this._hass) return;
        const domain = s.entity_id.split(".")[0];
        const svc = s.action || (domain === "scene" ? "turn_on" : "toggle");
        try { await this._hass.callService(domain, svc, { entity_id: s.entity_id }); } catch (_) {}
        chip.classList.add("flash");
        setTimeout(() => chip.classList.remove("flash"), 600);
        reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "run", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
      });

      const startLongPress = (clientX, clientY) => {
        this._pressOrigin = { x: clientX, y: clientY };
        this._longPressTimer = setTimeout(() => {
          this._showPopover(chip, s);
          this._longPressTimer = null;
        }, 400);
      };
      const cancelLongPress = () => {
        if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
      };

      chip.addEventListener("pointerdown", e => startLongPress(e.clientX, e.clientY));
      chip.addEventListener("pointerup", cancelLongPress);
      chip.addEventListener("pointercancel", cancelLongPress);
      chip.addEventListener("pointermove", e => {
        if (!this._pressOrigin) return;
        const dx = Math.abs(e.clientX - this._pressOrigin.x);
        const dy = Math.abs(e.clientY - this._pressOrigin.y);
        if (dx > 8 || dy > 8) cancelLongPress();
      });
    });

    // Close popover on outside tap
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
      <div class="pop-reason">${s.reason || "No reason provided."}</div>
      <button class="pop-btn" id="pop-yaml">Save as Automation</button>
      <button class="pop-btn dismiss" id="pop-dismiss">Dismiss</button>`;
    // Position below chip
    const rect = chip.getBoundingClientRect();
    const hostRect = this.getBoundingClientRect();
    pop.style.position = "absolute";
    pop.style.top = (rect.bottom - hostRect.top + 6) + "px";
    pop.style.left = Math.max(0, rect.left - hostRect.left) + "px";
    this.shadowRoot.appendChild(pop);

    pop.querySelector("#pop-yaml").addEventListener("click", () => {
      SmartSuggestionsWS.send({ type: "build_yaml", entity_id: s.entity_id, action: s.action || "", name: s.name || s.entity_id, reason: s.reason || "" });
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "saved", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
      pop.remove();
    });
    pop.querySelector("#pop-dismiss").addEventListener("click", () => {
      this._dismissed.add(s.entity_id);
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "dismissed", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
      pop.remove();
      this._render();
    });
  }
}
```

- [ ] **Step 2: Register**

```js
customElements.define("smart-suggestions-chip-card", SmartSuggestionsChipCard);
```

- [ ] **Step 3: Manual verification**

Add to dashboard:
```yaml
type: custom:smart-suggestions-chip-card
max_visible: 4
```

Expected: Horizontal row of colored chips. Tapping a chip executes the suggestion and flashes green. Long-pressing (hold ~0.4s) shows a popover with reason + Save/Dismiss buttons. Scrolling horizontally works without triggering long-press.

- [ ] **Step 4: Commit**

```bash
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: add SmartSuggestionsChipCard — horizontal scrollable chip strip"
```

---

## Task 6: Tile Grid Card — `smart-suggestions-tile-card`

- [ ] **Step 1: Implement `SmartSuggestionsTileCard`**

```js
class SmartSuggestionsTileCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._suggestions = [];
    this._isRefreshing = false;
  }

  setConfig(config) {
    this._config = {
      title:        config.title !== undefined ? config.title : "Suggestions",
      show_title:   config.show_title !== false,
      accent_color: config.accent_color || "#007AFF",
      columns:      Math.min(3, Math.max(2, parseInt(config.columns) || 2)),
      max_visible:  parseInt(config.max_visible) || 6,
      empty_message: config.empty_message || "Thinking of suggestions…",
    };
    requestAnimationFrame(() => this._render());
  }

  connectedCallback() { SmartSuggestionsWS.register(this); }
  disconnectedCallback() { SmartSuggestionsWS.unregister(this); }
  set hass(hass) { this._hass = hass; }

  _onWsUpdate(suggestions, isRefreshing) {
    const max = this._config.max_visible;
    this._suggestions = suggestions.slice(0, max);
    this._isRefreshing = isRefreshing;
    this._render();
  }
  _onWsMessage() {}

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color;
    const cols = this._config.columns;

    const tiles = this._suggestions.map((s, i) => {
      const domain = s.entity_id?.split(".")[0] || "scene";
      const icon = DOMAIN_ICONS[domain] || "mdi:star-circle";
      const borderColor = confidenceColor(s.confidence);
      return `<div class="tile" data-index="${i}" style="border-color:${borderColor}">
        <ha-icon icon="${icon}" style="--mdc-icon-size:36px;color:${borderColor}"></ha-icon>
        <div class="tile-name">${(s.name || s.entity_id || "").substring(0, 20)}</div>
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
          ${this._isRefreshing || this._suggestions.length === 0
            ? `<div class="empty">${this._isRefreshing ? "Thinking…" : this._config.empty_message}</div>`
            : `<div class="grid">${tiles}</div>`}
        </div>
      </ha-card>`;

    this.shadowRoot.querySelectorAll(".tile").forEach((tile, i) => {
      const s = this._suggestions[i];
      if (!s) return;
      tile.addEventListener("click", () => this._showSheet(s, tile));
    });
  }

  _showSheet(s, tile) {
    const existing = this.shadowRoot.querySelector(".sheet-overlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    const accent = this._config.accent_color;
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-name">${s.name || s.entity_id}</div>
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
      if (!this._hass) return;
      const domain = s.entity_id.split(".")[0];
      const svc = s.action || (domain === "scene" ? "turn_on" : "toggle");
      try { await this._hass.callService(domain, svc, { entity_id: s.entity_id }); } catch (_) {}
      tile.classList.add("flash");
      setTimeout(() => tile.classList.remove("flash"), 600);
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "run", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
    });
    overlay.querySelector("#s-yaml").addEventListener("click", () => {
      overlay.remove();
      SmartSuggestionsWS.send({ type: "build_yaml", entity_id: s.entity_id, action: s.action || "", name: s.name || s.entity_id, reason: s.reason || "" });
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "saved", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
    });
    overlay.querySelector("#s-dismiss").addEventListener("click", () => {
      overlay.remove();
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "dismissed", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
      this._suggestions = this._suggestions.filter(x => x.entity_id !== s.entity_id);
      this._render();
    });
  }
}
```

- [ ] **Step 2: Register**

```js
customElements.define("smart-suggestions-tile-card", SmartSuggestionsTileCard);
```

- [ ] **Step 3: Manual verification**

```yaml
type: custom:smart-suggestions-tile-card
columns: 2
```

Expected: Grid of square tiles with colored borders (green=high, amber=medium, grey=low). Tapping a tile opens a bottom sheet. Tapping Run executes + flashes tile. Tapping Dismiss removes that tile from the grid.

- [ ] **Step 4: Commit**

```bash
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: add SmartSuggestionsTileCard — 2/3 column grid with bottom sheet actions"
```

---

## Task 7: Glance Card — `smart-suggestions-glance-card`

- [ ] **Step 1: Implement `SmartSuggestionsGlanceCard`**

```js
class SmartSuggestionsGlanceCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._suggestions = [];
  }

  setConfig(config) {
    this._config = {
      accent_color:  config.accent_color || "#007AFF",
      show_reason:   config.show_reason === true,
      on_tap:        config.on_tap || "navigate",
      empty_message: config.empty_message || "No suggestions",
    };
    requestAnimationFrame(() => this._render());
  }

  connectedCallback() { SmartSuggestionsWS.register(this); }
  disconnectedCallback() { SmartSuggestionsWS.unregister(this); }
  set hass(hass) { this._hass = hass; }

  _onWsUpdate(suggestions) {
    this._suggestions = suggestions;
    this._render();
  }
  _onWsMessage() {}

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color;
    const s = this._suggestions[0];
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
            ${this._config.show_reason ? `<div class="reason">${s.reason || ""}</div>` : ""}
          </div>
          <button class="run-btn" id="run-btn">Run</button>
        </div>` : `<div class="empty">${this._config.empty_message}</div>`}`;

    if (s) {
      this.shadowRoot.querySelector("#row").addEventListener("click", e => {
        if (e.target.closest("#run-btn")) return;
        const tap = this._config.on_tap;
        if (tap === "more-info") {
          this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: s.entity_id } }));
        } else if (tap === "spotlight") {
          const overlay = document.createElement("smart-suggestions-spotlight-card");
          overlay.style.cssText = "position:fixed;inset:0;z-index:9999;padding:20px;background:rgba(0,0,0,0.7);display:flex;align-items:center;";
          overlay.setConfig(this._config);
          overlay.hass = this._hass;
          // Do NOT call _onWsUpdate manually — connectedCallback registers with singleton and triggers broadcast
          document.body.appendChild(overlay);
          overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
        }
      });
      this.shadowRoot.querySelector("#run-btn").addEventListener("click", async e => {
        e.stopPropagation();
        if (!this._hass) return;
        const domain = s.entity_id.split(".")[0];
        const svc = s.action || (domain === "scene" ? "turn_on" : "toggle");
        try { await this._hass.callService(domain, svc, { entity_id: s.entity_id }); } catch (_) {}
        reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "run", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
      });
    }
  }
}
```

- [ ] **Step 2: Register**

```js
customElements.define("smart-suggestions-glance-card", SmartSuggestionsGlanceCard);
```

- [ ] **Step 3: Manual verification**

```yaml
type: custom:smart-suggestions-glance-card
on_tap: spotlight
show_reason: true
```

Expected: Single compact row with icon, name, optional reason, and Run button. Tapping the row (not Run) should open the Spotlight card overlay.

- [ ] **Step 4: Commit**

```bash
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: add SmartSuggestionsGlanceCard — minimal single-suggestion row"
```

---

## Task 8: Context Banner Card — `smart-suggestions-banner-card`

- [ ] **Step 1: Implement `SmartSuggestionsBannerCard`**

```js
class SmartSuggestionsBannerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._suggestions = [];
    this._dismissed = false;
  }

  setConfig(config) {
    this._config = {
      accent_color: config.accent_color || "#007AFF",
      show_title:   config.show_title === true,
      title:        config.title || "",
    };
    requestAnimationFrame(() => this._render());
  }

  connectedCallback() { SmartSuggestionsWS.register(this); }
  disconnectedCallback() { SmartSuggestionsWS.unregister(this); }
  set hass(hass) { this._hass = hass; }

  _onWsUpdate(suggestions) {
    this._suggestions = suggestions;
    this._dismissed = false;  // reset dismiss on new suggestions
    this._render();
  }
  _onWsMessage() {}

  _render() {
    if (!this._config) return;
    const accent = this._config.accent_color;
    const s = this._suggestions[0];
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
        <div class="reason" id="reason">${s.reason || s.name || s.entity_id}</div>
        <button class="run-btn" id="run-btn">Run</button>
        <button class="dismiss-btn" id="dismiss-btn">&times;</button>
      </div>`;

    this.shadowRoot.querySelector("#reason").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: s.entity_id } }));
    });
    this.shadowRoot.querySelector("#run-btn").addEventListener("click", async () => {
      if (!this._hass) return;
      const domain = s.entity_id.split(".")[0];
      const svc = s.action || (domain === "scene" ? "turn_on" : "toggle");
      try { await this._hass.callService(domain, svc, { entity_id: s.entity_id }); } catch (_) {}
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "run", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
      this._dismissed = true;
      this._render();
    });
    this.shadowRoot.querySelector("#dismiss-btn").addEventListener("click", () => {
      reportOutcome(SmartSuggestionsWS.ws, s.entity_id, s.action || "toggle", "dismissed", ({ high: 1.0, medium: 0.6, low: 0.3 }[s.confidence] ?? 0));
      this._dismissed = true;
      this._render();
    });
  }
}
```

- [ ] **Step 2: Register all cards at bottom of file**

Ensure these are all present at the very bottom:
```js
customElements.define("smart-suggestions-card", SmartSuggestionsCard);
customElements.define("smart-suggestions-spotlight-card", SmartSuggestionsSpotlightCard);
customElements.define("smart-suggestions-chip-card", SmartSuggestionsChipCard);
customElements.define("smart-suggestions-tile-card", SmartSuggestionsTileCard);
customElements.define("smart-suggestions-glance-card", SmartSuggestionsGlanceCard);
customElements.define("smart-suggestions-banner-card", SmartSuggestionsBannerCard);

window.customCards = window.customCards || [];
["smart-suggestions-card", "smart-suggestions-spotlight-card",
 "smart-suggestions-chip-card", "smart-suggestions-tile-card",
 "smart-suggestions-glance-card", "smart-suggestions-banner-card"].forEach(name => {
  if (!window.customCards.find(c => c.type === name)) {
    window.customCards.push({ type: name, name: name.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()), preview: false });
  }
});
```

- [ ] **Step 3: Manual verification**

```yaml
type: custom:smart-suggestions-banner-card
```

Expected: Compact banner appears only when there's a medium/high confidence suggestion. Shows reason text (truncated). Run executes and hides banner. X dismisses until next suggestion refresh.

- [ ] **Step 4: Final full test — add all 6 cards to one dashboard**

Add to a test dashboard:
```yaml
cards:
  - type: custom:smart-suggestions-card
  - type: custom:smart-suggestions-spotlight-card
  - type: custom:smart-suggestions-chip-card
  - type: custom:smart-suggestions-tile-card
  - type: custom:smart-suggestions-glance-card
  - type: custom:smart-suggestions-banner-card
```

Open browser console. Verify:
- Zero JS errors
- Only ONE WebSocket connection in Network tab
- All cards display the same suggestions
- Navigate away and back — all cards recover

- [ ] **Step 5: Final commit**

```bash
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: add SmartSuggestionsBannerCard + register all 6 card types (v1.2.0)"
```
