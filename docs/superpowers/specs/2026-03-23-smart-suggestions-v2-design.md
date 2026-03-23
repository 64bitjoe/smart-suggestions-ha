# Smart Suggestions v2 — Design Spec
Date: 2026-03-23

## Problem Statement

The current card shows a list of scenes with minimal reasoning. It doesn't feel like AI — it feels like a scene picker. Suggestions are not contextually relevant to what is happening in the home right now, and there is no learning from past behavior. The card also has intermittent render/config errors. The goal of v2 is to make suggestions feel genuinely intelligent and to give users multiple card styles to fit different dashboard contexts.

---

## Scope

- **Backend (add-on):** Prompt rewrite, domain filtering, existing automation analysis, randomized entity sampling, YAML block output, SQLite usage log
- **Card (integration):** Fix render/config bug, add 5 new card types alongside the improved existing list card
- **Out of scope:** Multi-LLM provider support, public HACS release optimizations

---

## Backend Changes (smart-suggestions-addon)

### 1. Prompt Rewrite (`context_builder.py`, `main.py`)

Replace the current prompt with a rich-context prompt that includes:

- **Current time + day of week** — enables time-aware suggestions (e.g. "it's 11pm")
- **Recently changed entities** — entities that changed state in the last 60 minutes
- **Motion sensor states** — which areas have/haven't had motion recently
- **Device tracker states** — who is home
- **Current weather** (if available via HA sensor) — temperature, condition
- **Existing automations** — fed as YAML context so the LLM doesn't suggest things already automated
- **Usage history summary** — top dismissed suggestions (from SQLite) so the LLM avoids repeating them

**Anti-scene instruction:** The prompt explicitly instructs the LLM to avoid suggesting scenes unless a scene is the best fit for the specific current moment. Suggestions should be entity-level actions with clear contextual reasoning.

**YAML block output:** Each suggestion must include a `automation_yaml` field — a ready-to-paste HA automation YAML block. The LLM is instructed to output this inline with each suggestion.

**Output format (JSON per suggestion):**
```json
{
  "title": "Turn off study light",
  "reason": "No motion in study for 45 minutes, light has been on since 8am",
  "entity_id": "light.study",
  "action": "turn_off",
  "confidence": 0.87,
  "icon": "mdi:lightbulb-off",
  "automation_yaml": "alias: Turn off study...\n..."
}
```

### 2. Domain Filtering (`context_builder.py`)

Add a configurable `domains` list (default: `light, switch, climate, lock, media_player, cover`). Only entities in these domains are included in the prompt. Scenes are excluded from entity sampling by default.

### 3. Existing Automation Analysis (`context_builder.py`)

Read current automations from HA via REST (`/api/states` or `/api/config/automation/config`) and include them as context in the prompt. This prevents the LLM from suggesting things that are already automated.

### 4. Randomized Entity Sampling (`context_builder.py`)

When the number of entities exceeds the configured limit (default: 150), randomly sample rather than always taking the first N. Ensures different entities surface across runs, keeping suggestions fresh.

### 5. SQLite Usage Log (`usage_log.py` — new file)

A lightweight SQLite database at `/data/usage.db` with schema:

```sql
CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY,
  timestamp TEXT,
  entity_id TEXT,
  title TEXT,
  action TEXT,
  outcome TEXT,  -- 'run' | 'saved' | 'dismissed' | 'shown'
  confidence REAL
);
```

The card sends an outcome event to the add-on WebSocket when the user taps Run, Save, or Dismiss. The add-on logs it. On each prompt build, the top 10 most-dismissed `entity_id + action` pairs are injected as "avoid suggesting" context.

---

## Card Changes (smart-suggestions-ha)

### Bug Fix: Render / Config Error

**Root cause to investigate:** The card intermittently fails to render or shows "Configuration error". Likely caused by:
- `setConfig` being called before `_hass` is set, with `_render()` accessing `this._hass` without null checks
- Shadow DOM mutation during HA view transitions
- Missing default values causing attribute access on undefined

**Fix:** Audit all `_render()` / `_renderInner()` paths for null-safety, ensure `setConfig` never throws (already partially done), and add a guard that defers render until both `_config` and `_hass` are non-null for the first paint.

### Card Types

All five new types are registered in the same `smart-suggestions-card.js` file alongside the existing list card. Each is a separate `customElements.define` class.

---

#### 1. Existing List Card (improved) — `smart-suggestions-card`

No major UX change. Gets:
- YAML drawer now shown for all suggestions (not just automation_result failures)
- Outcome logging (Run/Save/Dismiss reported to add-on)
- Bug fixes

---

#### 2. Spotlight Card — `smart-suggestions-spotlight-card`

**Purpose:** Hero card for the main dashboard. One suggestion at a time, full attention.

**Layout:**
- Large domain icon (centered, colored circle)
- Title (entity friendly name)
- Reason text (AI explanation, 1-2 sentences)
- Confidence badge
- Three action buttons: **Run** | **Save as Automation** | **Dismiss**
- Dot pagination indicator + Previous/Next arrows
- "Thinking…" state with animated dots while add-on is processing

**Behavior:**
- Tapping Run calls the HA service and logs `outcome: run`
- Tapping Save shows the YAML drawer and logs `outcome: saved`
- Tapping Dismiss moves to next suggestion and logs `outcome: dismissed`
- Next/prev cycle through all current suggestions

**Config options:** `max_visible`, `accent_color`, `show_title`, `title`

---

#### 3. Chip Bar — `smart-suggestions-chip-card`

**Purpose:** Horizontal quick-action strip for top of dashboard.

**Layout:**
- Horizontally scrollable row of pill chips
- Each chip: domain icon + short truncated label (max ~20 chars)
- Confidence-colored left border or subtle background tint
- No card border — renders flush or as a minimal strip

**Behavior:**
- Tap chip → execute action immediately, chip flashes green
- Long-press chip → small popover with reason text + Save as Automation button
- Dismissing a chip logs `outcome: dismissed`

**Config options:** `max_visible` (default 5), `accent_color`, `show_title`

---

#### 4. Tile Grid — `smart-suggestions-tile-card`

**Purpose:** Visual grid for tablet/large dashboards.

**Layout:**
- 2-column CSS grid of square tiles
- Each tile: large centered icon (40px), entity name below, subtle confidence border color
- Card title above grid

**Behavior:**
- Tap tile → action sheet slides up with: Run / Save as Automation / Dismiss / Cancel
- Confidence border: green (high) / amber (medium) / grey (low)

**Config options:** `columns` (default 2, max 3), `max_visible`, `accent_color`, `show_title`

---

#### 5. Glance Card — `smart-suggestions-glance-card`

**Purpose:** Ultra-minimal single-line card for sidebars or cramped spaces.

**Layout:**
- Single row: domain icon | title text | action button (chevron or "Run")
- Optionally shows subtitle with short reason
- No expand/collapse

**Behavior:**
- Shows only the #1 (highest confidence) suggestion
- Tapping the row opens the Spotlight card as a modal overlay (or navigates to a dashboard view if configured)
- Run button executes directly

**Config options:** `accent_color`, `show_reason` (default false), `on_tap` (`run` | `more-info` | `navigate`)

---

#### 6. Context Banner — `smart-suggestions-banner-card`

**Purpose:** Ambient alert-style card that surfaces what the AI is observing, with one action.

**Layout:**
- Icon (observation-related, e.g. `mdi:motion-sensor`) + observation text ("No motion in living room for 45 min, 3 lights on") + single action button
- Subtle colored background (amber/blue depending on urgency)
- Dismiss X in top-right corner

**Behavior:**
- Shows only when there is at least one high-confidence suggestion
- Dismissing hides the card until next suggestion refresh
- Action button runs the top suggestion

**Config options:** `accent_color`, `show_title`

---

## Data Flow

```
Add-on (main.py)
  → context_builder.py (entity states + history + existing automations + usage summary)
  → ollama_client.py (rich prompt → YAML-bearing suggestions)
  → ws_server.py (push suggestions to card via WebSocket)
  → usage_log.py (receive outcome events, write to SQLite)

Card (JS)
  → Receives suggestions over WebSocket
  → Renders chosen card type
  → Sends outcome events (run/save/dismiss) back over WebSocket
```

---

## File Changes Summary

### Add-on (`smart-suggestions-addon`)
| File | Change |
|------|--------|
| `src/context_builder.py` | Rich context injection, domain filtering, randomized sampling, existing automation analysis |
| `src/main.py` | Wire usage log, pass context to prompt builder |
| `src/usage_log.py` | **New** — SQLite wrapper for suggestion outcomes |
| `src/ws_server.py` | Add outcome event handler (`/feedback` or new `outcome` WS message type) |

### Integration (`smart-suggestions-ha`)
| File | Change |
|------|--------|
| `custom_components/smart_suggestions/smart-suggestions-card.js` | Bug fix, outcome logging, YAML drawer on all cards, 5 new card classes |

---

## Success Criteria

- Suggestions reference current home state (time, motion, who's home) — not just scene names
- Card renders reliably with no config errors
- At least 3 card types usable in a real dashboard simultaneously
- YAML block present on every suggestion
- Dismissed suggestions don't recur within the same day
