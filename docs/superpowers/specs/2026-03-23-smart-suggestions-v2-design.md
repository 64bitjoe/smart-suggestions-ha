# Smart Suggestions v2 — Design Spec
Date: 2026-03-23

## Problem Statement

The current card shows a list of scenes with minimal reasoning. It doesn't feel like AI — it feels like a scene picker. Suggestions are not contextually relevant to what is happening in the home right now, and there is no learning from past behavior. The card also has intermittent render/config errors. The goal of v2 is to make suggestions feel genuinely intelligent and to give users multiple card styles to fit different dashboard contexts.

---

## Scope

- **Backend (add-on):** Prompt/narrator enhancement, domain filtering, existing automation analysis, randomized entity sampling, YAML block per suggestion, SQLite usage log (replacing `/data/feedback.json`)
- **Card (integration):** Fix render/config bug, add 5 new card types alongside the improved existing list card
- **Out of scope:** Multi-LLM provider support, public HACS release optimizations

---

## Current Architecture (baseline)

The add-on uses a two-phase pipeline:

1. **`statistical_engine.py`** — scores entity candidates statistically from pattern history
2. **`scene_engine.py`** — ranks/filters candidates, applies feedback multipliers, assigns confidence labels (high/medium/low using score thresholds: high ≥ 70, medium ≥ 40, low < 40)
3. **`ollama_narrator.py`** — rewrites only the `reason` field text; does not generate or rerank suggestions
4. **`automation_builder.py`** — builds automation YAML for a given suggestion (already exists, invoked separately on user request)
5. **`pattern_store.py`** — persists usage patterns to `/data/patterns.json`
6. **`ha_client.py`** — HA WebSocket + REST (history, state write)
7. **`ws_server.py`** — aiohttp WebSocket server; existing `/feedback` HTTP endpoint handles thumbs up/down votes; `_FEEDBACK_FILE = "/data/feedback.json"` is the current persistence store
8. **`main.py`** — orchestrates the pipeline; `_load_feedback()` / `_save_feedback()` read/write `/data/feedback.json`

**Root cause of "not smart enough":** Suggestions are statistically scored from historical patterns — the LLM only rewrites reason text after the fact. There is no contextual reasoning about what's happening *right now* (time of day, current entity states, motion, who's home).

---

## Backend Changes (smart-suggestions-addon)

### 1. Enhance `ollama_narrator.py` — Contextual Reranking + Enriched Reasons

**Current behaviour:** Narrator receives a flat list of candidates and rewrites only their `reason` fields. It already injects current time.

**New behaviour:** Narrator receives the candidate list plus a rich context block and is responsible for:
1. **Reranking candidates** — returning them in a new order based on contextual relevance
2. **Rewriting reason fields** — as before, but now context-aware

**`automation_yaml` is generated on-demand, not pre-generated.** Do NOT call `AutomationBuilder` during the suggestion cycle. Instead, when the user opens the YAML drawer in the card, the card sends a WS request and the add-on generates YAML for that single suggestion at that moment (see §On-Demand YAML in ws_server.py).

**Context block injected into the narrator prompt:**
```json
{
  "current_time": "22:14 on Wednesday",
  "recent_changes": [
    {"entity_id": "light.study", "state": "on", "changed_ago_minutes": 180}
  ],
  "motion_sensors": [
    {"entity_id": "binary_sensor.study_motion", "state": "off", "minutes_since_triggered": 45}
  ],
  "presence": ["person.john"],
  "weather": {"temperature": 18, "condition": "cloudy"},
  "avoided_pairs": [
    {"entity_id": "light.living_room", "action": "turn_off"}
  ]
}
```

**Narrator prompt instruction (addition):** Reorder the suggestions array so the most contextually relevant items are first. Do not add or remove items. Avoid suggestions matching any `avoided_pairs`. Return the same JSON structure as before, reordered.

**Context assembly:** Add a `_build_narrator_context(states, history, options, avoided_pairs)` helper in `main.py` that collects:
- Current time string
- Entities that changed state in the last 60 minutes (from recent HA state snapshot)
- Motion/occupancy sensor states + minutes since last trigger
- `person.*` entity states (home/away)
- Optional weather: if `sensor.outdoor_temperature` exists, use its `state` as temperature. For `weather.*` entities, use `state` as the condition string and `attributes.temperature` as the numeric temperature value. Do not use `weather.*.state` as temperature.
- Top 10 avoided pairs from the usage log (see §5)

### 2. Domain Filtering — `statistical_engine.py` + `options.json`

Add a `domains` key to `options.json` (configured via HA add-on options UI in `config.yaml`). Default: `["light", "switch", "climate", "lock", "media_player", "cover", "fan"]`. Scenes excluded from domain-filtered entity sampling by default.

In `statistical_engine.py`, filter entity candidates to only those whose entity_id domain is in the configured `domains` list before scoring.

Config location: `options.json` at `/data/options.json`, already loaded by `_load_options()` in `main.py`. No card-side config needed.

### 3. Existing Automation Analysis — `ha_client.py` + `main.py`

Fetch existing automations via `GET /api/states` filtered to `automation.*` entities. Extract `friendly_name` and `state` (on/off) from each automation's attributes. Format as a compact list of names.

Inject into the narrator prompt as an additional field:
```json
"existing_automations": ["Motion-activated hallway light", "Goodnight routine", ...]
```

Narrator prompt instruction (addition): Do not suggest anything that is substantively equivalent to an item in `existing_automations`.

Implementation: Add `async def get_automations(self) -> list[str]` to `ha_client.py`, called once per suggestion cycle in `main.py`, passed to the context builder helper.

### 4. Randomized Entity Sampling — `statistical_engine.py`

When entity candidates exceed the configured limit (default: 150, existing `options.json` key `max_entities`), select a random sample using `random.sample()` **seeded once per suggestion cycle** with the current Unix timestamp rounded to the nearest hour (`int(time.time() // 3600)`). This means sampling is stable within a given hour but changes each hour, balancing freshness with consistency within a session.

### 5. On-Demand YAML — `ws_server.py` + `automation_builder.py`

Add a new WS message type the card can send to request YAML for a specific suggestion:
```json
{ "type": "build_yaml", "entity_id": "light.study", "action": "turn_off", "name": "Turn off study light", "reason": "No motion for 45 min" }
```

The add-on calls `AutomationBuilder` for that single suggestion and responds:
```json
{ "type": "yaml_result", "entity_id": "light.study", "action": "turn_off", "yaml": "alias: ..." }
```
On failure: `{ "type": "yaml_result", "entity_id": "...", "action": "...", "yaml": null, "error": "..." }`.

This replaces any notion of pre-generating YAML per suggestion per cycle. The card opens the YAML drawer optimistically (showing a spinner) and populates it when the response arrives.

### 6. SQLite Usage Log — new `usage_log.py`

Replace `/data/feedback.json` with a SQLite database at `/data/usage.db`.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,          -- ISO-8601 UTC
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,            -- 'shown' | 'run' | 'saved' | 'dismissed'
  confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_entity_action ON outcomes (entity_id, action);
CREATE INDEX IF NOT EXISTS idx_timestamp ON outcomes (timestamp);
```

**Migration:** On startup, if `/data/feedback.json` exists, read it and insert existing thumbs-up/down votes as `outcome = 'run'` (upvote) or `outcome = 'dismissed'` (downvote) records with `timestamp = now()`. Then rename the old file to `/data/feedback.json.bak`.

**Avoided pairs query:** For context building, query the last 24 hours of outcomes:
```sql
SELECT entity_id, action, COUNT(*) as n
FROM outcomes
WHERE outcome = 'dismissed'
  AND timestamp > datetime('now', '-1 day')
GROUP BY entity_id, action
ORDER BY n DESC
LIMIT 10
```

**Outcome event over WebSocket:** The card sends a WebSocket message when the user acts on a suggestion:
```json
{ "type": "outcome", "entity_id": "light.study", "action": "turn_off", "outcome": "run", "confidence": 0.87 }
```
Valid `outcome` values: `run`, `saved`, `dismissed`. The add-on also logs `shown` for every suggestion in the payload pushed to the card.

In `ws_server.py`, add handling for `type: "outcome"` messages alongside the existing feedback handler. The existing HTTP `/feedback` endpoint can remain for backwards compatibility but the card will use the WS outcome message going forward.

**Migration from `feedback.json`:** On startup, if `/data/feedback.json` exists, for each `entity_id` with `{"up": N, "down": N}`, insert N rows with `outcome='run'` and N rows with `outcome='dismissed'`, each with `timestamp = current UTC`. Then rename the file to `/data/feedback.json.bak`. If N > 100 for any entity/vote pair, cap at 100 rows (prevents runaway inserts for corrupted feedback files).

**`usage_log.py` API:**
```python
class UsageLog:
    def __init__(self, db_path: str = "/data/usage.db") -> None: ...
    async def log(self, entity_id: str, action: str, outcome: str, confidence: float) -> None: ...
    async def get_avoided_pairs(self, hours: int = 24, limit: int = 10) -> list[dict]: ...
    async def get_feedback_scores(self, entity_ids: list[str]) -> dict[str, dict]:
        """Returns {entity_id: {"up": N, "down": N}} counts from all-time outcomes.
        'run' outcomes count as up; 'dismissed' outcomes count as down.
        Used by SceneEngine.rank() in place of the old feedback.json dict."""
    async def migrate_from_json(self, json_path: str) -> None: ...
```

**SceneEngine integration after migration:** In `main.py`, after building candidates, call `await usage_log.get_feedback_scores([c["entity_id"] for c in candidates])` and pass the result to `SceneEngine.rank(candidates, states, feedback_scores)`. The shape `{entity_id: {"up": N, "down": N}}` is identical to the old `feedback.json` structure, so `scene_engine.py` requires no changes.

---

## Card Changes (smart-suggestions-ha)

### Bug Fix: Render / Config Error

Add the following guard at the top of `_renderInner()`:
```js
if (!this._config || !this._hass) return;
```
This is in addition to the existing try/catch in `_render()`. Also audit that `setConfig` never calls `_render()` synchronously before `hass` is set — the existing `requestAnimationFrame` wrapper already helps, but the guard above makes it unconditional.

### Shared WebSocket Module

All new card types delegate to a single `SmartSuggestionsWS` singleton (module-level object in the JS file) rather than each managing their own WebSocket. The singleton tracks connected cards, broadcasts incoming suggestions to all registered listeners, and manages reconnection. Each card class calls `SmartSuggestionsWS.register(cardInstance)` in `connectedCallback` and `SmartSuggestionsWS.unregister(cardInstance)` in `disconnectedCallback`.

**Lifecycle when last listener unregisters:** When `unregister()` brings the listener count to zero, the singleton closes the WebSocket and resets its connection state (clears the `_ws` reference and any retry timeout). The next `register()` call triggers a fresh `connect()`. This mirrors the existing single-card behavior and ensures no dangling connections when the user navigates away from the dashboard view.

### Confidence Labels (shared helper)

The add-on sends `confidence` as a string label: `"high"`, `"medium"`, or `"low"` (assigned by `scene_engine.py`). The card uses these string labels directly — no numeric threshold comparison needed.

```js
function confidenceColor(label) {
  return { high: "#34C759", medium: "#FF9F0A", low: "#8E8E93" }[label] ?? "#8E8E93";
}
function confidenceVisible(label) {
  // Context Banner only shows for medium or high confidence
  return label === "high" || label === "medium";
}
```

Used consistently across all card types.

### Outcome Reporting (shared helper)

```js
function reportOutcome(ws, entityId, action, outcome, confidence) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "outcome", entity_id: entityId, action, outcome, confidence }));
  }
}
```

Called by all card types on Run, Save, and Dismiss.

### Loading / Empty States

All card types display a minimal loading state (animated dots or spinner) while `isRefreshing` is true, and an `empty_message` config string (default: `"Thinking of suggestions…"`) when suggestions array is empty.

---

### Card Type 1: Existing List Card (improved) — `smart-suggestions-card`

No UX changes. Gets:
- YAML drawer accessible on all suggestions (not just automation_result failures) — tap a new "YAML" button in the expanded reason panel to open the drawer
- Outcome reporting on Run and Dismiss
- Bug fix (shared guard)
- Delegates WS to shared singleton

---

### Card Type 2: Spotlight Card — `smart-suggestions-spotlight-card`

**Purpose:** Hero card for the main dashboard. One suggestion at a time, full attention.

**Layout:**
- Large domain icon (56px centered colored circle, top third of card)
- Title (entity friendly name, 20px bold)
- Reason text (AI explanation, 2-3 sentences, secondary color)
- Confidence badge (High / Medium / Low, colored pill)
- Three action buttons: **Run** | **Save as Automation** | **Dismiss**
- Dot pagination indicator (one dot per suggestion, filled = current) + Previous/Next arrows below buttons
- "Thinking…" state: animated three-dot indicator replaces content while `isRefreshing`

**Behavior:**
- Run: calls HA service, flashes green, reports `outcome: run`, advances to next suggestion
- Save: opens YAML drawer, reports `outcome: saved`
- Dismiss: advances to next suggestion, reports `outcome: dismissed`
- Prev/Next arrows cycle through all current suggestions without logging outcomes

**Config:** `max_visible`, `accent_color`, `show_title`, `title`, `empty_message`

---

### Card Type 3: Chip Bar — `smart-suggestions-chip-card`

**Purpose:** Horizontal quick-action strip for top of dashboard.

**Layout:**
- Horizontally scrollable `<div>` with `overflow-x: auto; white-space: nowrap`
- Each chip: colored domain icon (20px) + truncated label (max 22 chars, ellipsis) — pill shape, 32px tall
- Confidence indicated by chip background opacity (high: 100%, medium: 70%, low: 45%)
- Optional card title above the chip row

**Behavior:**
- Tap chip → executes action, chip flashes green, reports `outcome: run`
- Long-press chip (>400ms): start a 400ms timer on `pointerdown`. Cancel the timer on `pointerup`, `pointercancel`, or `pointermove` (if movement exceeds 8px from origin). If the timer fires, show a small inline popover below the chip with: reason text + "Save as Automation" button + "Dismiss" button. Popover closes on outside tap.
- Dismiss from popover: removes chip from row, reports `outcome: dismissed`
- Save from popover: opens YAML drawer, reports `outcome: saved`

**Loading state:** Single animated pulse chip placeholder

**Config:** `max_visible` (default 5), `accent_color`, `show_title`, `title`

---

### Card Type 4: Tile Grid — `smart-suggestions-tile-card`

**Purpose:** Visual grid for tablet/large dashboards.

**Layout:**
- CSS grid, `columns` config (default 2, max 3), `grid-gap: 8px`
- Each tile: 1:1 aspect ratio, rounded corners (12px), `background: rgba(255,255,255,0.07)`
- Confidence border: 2px solid — green (`#34C759`) for high, amber (`#FF9F0A`) for medium, grey (`#8E8E93`) for low (using `CONFIDENCE_HIGH` / `CONFIDENCE_MEDIUM` thresholds)
- Tile content: large icon centered (40px), entity friendly name below (13px), confidence label pill at bottom

**Behavior:**
- Tap tile → bottom sheet slides up (CSS transform animation) with: reason text, Run button, Save as Automation button, Dismiss button, Cancel button
- Bottom sheet uses a semi-transparent overlay behind it; tap overlay to cancel
- Run: closes sheet, executes action, tile flashes green, reports `outcome: run`
- Save: opens YAML drawer over the bottom sheet, reports `outcome: saved`
- Dismiss: closes sheet, removes tile, reports `outcome: dismissed`

**Loading state:** 4 skeleton tile placeholders with pulse animation

**Config:** `columns` (2 or 3), `max_visible`, `accent_color`, `show_title`, `title`

---

### Card Type 5: Glance Card — `smart-suggestions-glance-card`

**Purpose:** Ultra-minimal single-line card for sidebars or cramped spaces.

**Layout:**
- Single row: 28px domain icon | entity name (15px) | action label chip | Run button (small, right-aligned)
- Optional second line (if `show_reason: true`): truncated reason text in secondary color
- Shows only the #1 (first/highest confidence) suggestion

**Behavior:**
- Run button: executes action, reports `outcome: run`
- Tapping anywhere else on the row: behavior controlled by `on_tap` config:
  - `navigate` (default): pushes `action_data.path` if present, else no-op
  - `more-info`: dispatches `hass-more-info` for the suggestion's `entity_id`
  - `spotlight`: appends a `smart-suggestions-spotlight-card` instance to `document.body` as a fixed-position overlay (z-index: 9999). After `appendChild`, immediately set `.hass = this._hass` and `.suggestions = this._suggestions` properties on the overlay instance. Overlay dismissed by close button or backdrop click. **Known limitation:** HA themes or parent elements with CSS `transform`/`filter` create new stacking contexts that can cap z-index; in those configurations the overlay may render behind HA's sidebar. This is acceptable for personal use.

**Loading state:** Single grey placeholder row

**Config:** `accent_color`, `show_reason` (default false), `on_tap` (`navigate` | `more-info` | `spotlight`), `empty_message`

---

### Card Type 6: Context Banner — `smart-suggestions-banner-card`

**Purpose:** Ambient alert-style card that surfaces what the AI is *observing*, with one action. Only shows when suggestions are present.

**Layout:**
- Left: observation icon (derived from the top suggestion's domain, 24px)
- Center: `reason` text of the top suggestion (single line, truncated)
- Right: "Run" button (text only, accent color) + dismiss X
- Subtle colored background: `rgba(accent, 0.12)` — defaults to blue tint
- 48px tall, full width

**Behavior:**
- Run: executes top suggestion action, hides banner until next suggestion push, reports `outcome: run`
- X (dismiss): hides banner until next suggestion push (session-level, not persisted), reports `outcome: dismissed`
- Tapping reason text: dispatches `hass-more-info` for top suggestion entity_id

**Shows only when:** suggestions array is non-empty AND top suggestion confidence ≥ `CONFIDENCE_MEDIUM`

**Loading state:** Hidden (banner only appears when there is something to say)

**Config:** `accent_color`, `show_title` (default false)

---

## Data Flow

```
Add-on pipeline (per cycle):
  ha_client.py        → fetch entity states, history, automations
  statistical_engine  → score entity candidates (domain-filtered, randomized sample)
  scene_engine        → rank, filter noops, apply feedback multipliers, assign confidence
  usage_log.py        → get_avoided_pairs() for context
  main.py             → build narrator context block
  ollama_narrator     → rerank + rewrite reasons with context
  (automation_builder invoked on-demand only, not during suggestion cycle)
  ws_server           → broadcast { type: "suggestions", data: [...] } to all card clients
  usage_log.py        → log outcome: shown for each suggestion in payload

Card (JS):
  SmartSuggestionsWS  → single shared WS connection, broadcasts to registered cards
  Card instance       → renders chosen card type from shared suggestions array
  User action         → reportOutcome() sends { type: "outcome", ... } to add-on
  ws_server           → receives outcome, calls usage_log.log()
```

---

## File Changes Summary

### Add-on (`smart-suggestions-addon`)
| File | Change |
|------|--------|
| `src/ollama_narrator.py` | Add context block to prompt; add reranking instruction |
| `src/statistical_engine.py` | Add domain filtering; randomized sampling seeded by hourly timestamp |
| `src/ha_client.py` | Add `get_automations()` method |
| `src/main.py` | Add `_build_narrator_context()` helper; wire `UsageLog`; replace `_load_feedback` / `_save_feedback` with `UsageLog`; pass context to narrator |
| `src/usage_log.py` | **New** — SQLite wrapper (`UsageLog` class) |
| `src/ws_server.py` | Add `type: "outcome"` WS message handler; add `type: "build_yaml"` WS request → `type: "yaml_result"` response |
| `config.yaml` | Add `domains` option with default list |

### Integration (`smart-suggestions-ha`)
| File | Change |
|------|--------|
| `custom_components/smart_suggestions/smart-suggestions-card.js` | Bug fix guard; `SmartSuggestionsWS` singleton; `reportOutcome` helper; YAML drawer on all suggestions; 5 new card classes registered via `customElements.define` |

---

## Version Bumps

- Add-on `config.yaml`: increment version to `1.1.0`
- Card `CARD_VERSION`: increment to `1.2.0`

---

## Success Criteria

1. Suggestions reference current home state in their reason text (time, motion, presence) — verified by reading reason text after a refresh
2. Card renders reliably: no "Configuration error" and no JS exceptions in browser console across page reload and HA view navigation
3. Spotlight, Chip Bar, and Tile Grid all render correct suggestions simultaneously on the same dashboard with no console errors in Chrome
4. YAML drawer populates within 30 seconds when opened (on-demand via `build_yaml` WS request)
5. Dismissed suggestions do not reappear in the next suggestion cycle (within 24 hours)
6. Outcome events appear in `/data/usage.db` after Run, Save, or Dismiss actions
