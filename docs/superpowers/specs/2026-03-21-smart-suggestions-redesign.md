# Smart Suggestions Redesign — Design Spec
**Date:** 2026-03-21
**Status:** Approved

---

## Problem Statement

The current system produces suggestions that are not useful. The root causes:
1. Ollama is asked to do hard analytical reasoning (pattern detection, candidate ranking) it is not capable of reliably.
2. Scenes — the original primary intent — are treated as just another suggestion category, not the main focus.
3. Pattern detection is shallow (4h history, 48h background analysis) and doesn't build durable, confident knowledge of user habits.
4. There is no path from "smart suggestion" to "permanent automation" — the loop is never closed.

---

## Vision

A smart home assistant that *earns* trust by surfacing habits the user hasn't consciously noticed. Scenes are the primary output. The system should feel like it knows your home's rhythm — leading with the right scene for right now, and offering device-level suggestions when it spots something contextually off.

---

## Architecture Overview

```
HA WebSocket
     ↓
HAClient           — watches all entities, fetches history (unchanged)
     ↓
StatisticalEngine  — always-on, deterministic, no LLM
     ↓
PatternStore       — persisted learned patterns (JSON → SQLite)
     ↑
AnthropicAnalyzer  — scheduled nightly + on-demand, configurable provider
     ↓
SceneEngine        — scene-first ranking of suggestions
     ↓
OllamaNarrator     — real-time narration only (no ranking)
     ↓
AutomationBuilder  — on-demand: suggestion → HA automation YAML
     ↓
WSServer + Card    — scene-first UI with Save as Automation
```

**Core principle:** The real-time suggestion path is fully deterministic and never waits on an LLM. AI providers are called on a schedule or on-demand for well-defined, bounded jobs.

---

## Components

### 1. StatisticalEngine (`statistical_engine.py`)

Runs on every refresh cycle. No LLM.

**Real-time path (every cycle):**
- **Routine candidates** — reads PatternStore routines, scores each by how well current time/DOW matches `typical_time` ± 30min and `days`. The ±30min window is intentional (narrower than the ±2h history fetch window); it prioritises precision over recall for timing-based suggestions.
- **Scene match score** — compares scene member target states vs current states → match ratio (0–1). Scenes with match ratio ≥ 0.6 are promoted. Uses `analysis_depth_days` history when available.

**Background path (runs every `analysis_interval_hours`, default 6h — NOT on every cycle):**
- **Co-occurrence correlations** — detects entity pairs that change state within `correlation_window_minutes` (default 5) with statistical frequency across `analysis_depth_days` of history. O(n²) scan runs in a background asyncio task, never blocking the real-time path. Results written to PatternStore with `source: "statistical"`. Re-runs every 6h or on manual trigger.

History depth for background analysis: uses `analysis_depth_days` config key (not `history_hours`, which is only for the real-time refresh context window).

Output: ranked list of scene candidates + device candidates with scores and raw reasons.

### 2. PatternStore (`pattern_store.py`)

Persists structured patterns between restarts and across analysis cycles. Implemented as a JSON file at `/data/patterns.json` (existing file migrated on first load — fields not present in new schema are silently dropped; new required fields default to safe values).

**TTL / decay rules:**
- `source: "statistical"` patterns: TTL 24h. Re-evaluated on each background analysis run.
- `source: "anthropic"` patterns: TTL 7 days. Persist until next nightly run overwrites them.
- `anomalies`: TTL set to `expires_at` field. Evaluated at read time in `PatternStore.get_active_anomalies()` — expired anomalies are filtered out before returning to callers. Default anomaly lifetime is 4h from detection time.
- Decay is evaluated at **read time**, not write time — no background cleanup task needed.

Schema:
```json
{
  "routines": [
    {
      "name": "Evening Scene — weekday",
      "entity_id": "scene.evening",
      "typical_time": "18:30",
      "days": ["Mon","Tue","Wed","Thu","Fri"],
      "confidence": 0.87,
      "last_seen": "2026-03-20T18:32:00",
      "source": "anthropic",
      "expires_at": "2026-03-28T03:00:00"
    }
  ],
  "correlations": [
    {
      "entity_a": "media_player.tv",
      "entity_b": "light.living_room",
      "pattern": "living room dims within 5min of TV turning on",
      "confidence": 0.82,
      "window_minutes": 5,
      "source": "statistical",
      "expires_at": "2026-03-22T03:00:00"
    }
  ],
  "anomalies": [
    {
      "entity_id": "light.kitchen",
      "description": "on for 4h longer than usual",
      "severity": "medium",
      "expires_at": "2026-03-21T22:00:00"
    }
  ],
  "updated_at": "2026-03-21T03:00:00"
}
```

**Migration from existing `/data/patterns.json`:** On first load, if the file exists but lacks `expires_at` or `source` fields, they are added with safe defaults (`source: "statistical"`, `expires_at`: now + 24h). Old `right_now` key is ignored and dropped.

### 3. AnthropicAnalyzer (`anthropic_analyzer.py`)

**Schedule:** Runs nightly at a configurable wall-clock time (`analysis_schedule`, default `"03:00"`). Implemented using asyncio sleep-until-next-occurrence logic: on startup, compute seconds until the next occurrence of `analysis_schedule` in local system time, sleep until then, run, then sleep 24h. No external scheduler dependency.

**First-run trigger:** On startup, if `PatternStore.updated_at` is absent (new install or migrated install) or older than `analysis_depth_days` ago (stale), trigger immediately rather than waiting for the nightly window. This applies to migrated installs too — migration does NOT write `updated_at`, so the analyzer fires on first boot after upgrade (intentional: force a fresh analysis with the new schema). The analyzer runs against whatever history is available; no minimum data precondition.

**Provider:** Configurable via `ai_provider` (`"anthropic"` or `"openai_compatible"`) + `ai_api_key` + `ai_model`. Anthropic provider uses the `anthropic` Python SDK; openai_compatible uses the `openai` SDK with a custom `base_url`. Default model: `claude-opus-4-5` (implementer: verify current Opus model identifier against Anthropic API before coding).

Responsibilities:
- Fetches compact history summary over `analysis_depth_days` (default 14, configurable 7–90)
- Sends structured prompt, receives JSON: routines, correlation chains, anomalies
- Merges into PatternStore with `source: "anthropic"` and `expires_at: now + 7 days`

Prompt is tightly structured — returns JSON only.

### 4. SceneEngine (`scene_engine.py`)

Scene-first ranking. Single responsibility: produce a ranked list of suggestions where scenes come first.

Priority order:
1. Scenes with high match ratio AND pattern match (user typically activates at this time)
2. Scenes with high match ratio only (home already in the right state)
3. Scenes with strong pattern match only (typical time, not yet in state)
4. Device suggestions from active correlations ("TV on → dim lights")
5. Device anomalies ("kitchen light on longer than usual")

**`can_save_as_automation` eligibility:** set to `true` only when the suggestion has a confirmed routine pattern in PatternStore (i.e., `entity_id` matches a routine entry with `typical_time` + `days` both present and `confidence ≥ pattern_confidence_threshold`). Device-level correlation suggestions do NOT receive this flag in v1 (deferred to future iteration).

Output shape:
```json
[
  {
    "entity_id": "scene.evening",
    "name": "Evening Scene",
    "action": "activate",
    "reason": "You usually activate this around 6:30pm on weekdays",
    "confidence": "high",
    "match_ratio": 0.8,
    "type": "scene",
    "can_save_as_automation": true,
    "automation_context": {
      "typical_time": "18:30",
      "days": ["Mon","Tue","Wed","Thu","Fri"]
    }
  }
]
```

### 5. OllamaNarrator (`ollama_narrator.py`)

Constrained, real-time only. Given pre-ranked candidates with scores from SceneEngine, Ollama rewrites the `reason` field only. No ranking, no candidate selection, no suppression.

Input to Ollama: list of `{entity_id, name, reason, type, confidence}` + current time.

Output contract — Ollama must return a JSON array of `{entity_id, reason}` pairs, one per input candidate. If Ollama returns malformed JSON or fewer items than input, the original SceneEngine reasons are used as-is (fallback). Ollama **cannot remove or reorder candidates** — any output that tries to is ignored.

```json
[
  {"entity_id": "scene.evening", "reason": "Your living room lights are almost ready for Evening — now's your usual time to activate it."}
]
```

If Ollama is unavailable or times out, raw SceneEngine reasons are used. No error surfaced to the user.

### 6. AutomationBuilder (`automation_builder.py`)

On-demand, triggered by user clicking "Save as Automation" on a suggestion with `can_save_as_automation: true`.

Given `automation_context` from the suggestion (scene entity_id, typical_time, days), calls Anthropic to generate valid HA automation YAML. Example output:

```yaml
alias: Evening Scene — Weekdays
trigger:
  - platform: time
    at: "18:30:00"
condition:
  - condition: time
    weekday: [mon, tue, wed, thu, fri]
action:
  - service: scene.turn_on
    target:
      entity_id: scene.evening
mode: single
```

**HA automation creation:** Uses the existing REST path in `HAClient` (no WebSocket connection exists or is needed). `AutomationBuilder` calls a new `create_automation(config_dict)` method on `HAClient`, which POSTs to `http://supervisor/core/api/config/automation/config` with the automation config dict as JSON body and the existing Supervisor token auth. The `homeassistant_api: true` add-on permission is required in `config.yaml` (already present). On success, HA returns the new automation `id`. Implementer: verify the exact request body schema against HA source or API docs before coding — the top-level key is `config` wrapping the automation dict.

Returns `{success: true, automation_id: "..."}` or `{success: false, error: "...", yaml: "<raw yaml>"}` to the card. On failure, card displays the raw YAML so the user can copy-paste it manually into HA.

### 7. WSServer + Card

**New WSServer message types:**
- Inbound: `{"type": "save_automation", "suggestion": {...}}` — triggers AutomationBuilder
- Outbound: `{"type": "automation_result", "success": true/false, "automation_id": "...", "yaml": "..."}` — result back to card

**Streaming:** The `{"type": "streaming", "token": "..."}` WS message is removed. `OllamaNarrator` runs after ranking and fills in `reason` fields before the final `suggestions` broadcast. The card no longer receives or renders streaming tokens. The card's existing streaming handler is removed as dead code.

**New WSServer HTTP endpoint:**
- `POST /save_automation` — alternative HTTP path for the same action (for non-WS clients)

**Card redesign (post v1.0.20):**
- **Primary zone:** single dominant scene card — name, reason, confidence label, one-tap activate, "Save as Automation" button (only visible when `can_save_as_automation: true`)
- **Secondary zone:** 2–3 device-level suggestions (correlations/anomalies)
- Scaling/confidence border removed — replaced with text label ("High confidence", "Pattern match", "Contextual")
- Card layout details deferred to implementation phase

---

## Data Flow

```
Every refresh cycle (real-time path, ~10s):
  HAClient.get_states()
    → StatisticalEngine.score_realtime(states, history_4h, PatternStore)
    → SceneEngine.rank(candidates)
    → OllamaNarrator.narrate(top_candidates)  [optional, async, non-blocking]
    → WSServer.broadcast(suggestions)
    → HAClient.write_state(suggestions)

Background analysis (every 6h):
  StatisticalEngine.analyze_correlations(history_Ndays)
    → PatternStore.merge(correlations)

Nightly (analysis path, wall-clock time):
  HAClient.fetch_history(days=analysis_depth_days)
    → AnthropicAnalyzer.analyze(history, states)
    → PatternStore.merge(patterns)

On-demand (automation path):
  User clicks "Save as Automation"
    → WSServer receives save_automation message
    → AutomationBuilder.build(suggestion.automation_context)
    → HAClient.create_automation(config_dict)  [REST — Supervisor API]
    → WSServer.send(automation_result)
    → Card shows confirmation or raw YAML fallback
```

---

## Configuration (`options.json` + `config.yaml` schema)

```json
{
  "refresh_interval": 10,
  "max_suggestions": 7,
  "history_hours": 4,
  "analysis_depth_days": 14,
  "analysis_schedule": "03:00",
  "analysis_interval_hours": 6,
  "ai_provider": "anthropic",
  "ai_api_key": "",
  "ai_model": "claude-opus-4-5",
  "ollama_url": "http://localhost:11434",
  "ollama_model": "llama3.2",
  "correlation_window_minutes": 5,
  "pattern_confidence_threshold": 0.6
}
```

`config.yaml` `options` and `schema` blocks must include all keys above. Types: `refresh_interval` (int), `max_suggestions` (int), `history_hours` (int), `analysis_depth_days` (int, 7–90), `analysis_schedule` (str), `analysis_interval_hours` (int), `ai_provider` (str, enum: anthropic/openai_compatible), `ai_api_key` (str, optional/password), `ai_model` (str), `ollama_url` (str), `ollama_model` (str), `correlation_window_minutes` (int), `pattern_confidence_threshold` (float). All keys must have defaults matching the values above so the add-on starts without any user configuration.

---

## Error Handling

- **Anthropic unavailable:** PatternStore serves stale patterns (TTL-gated); StatisticalEngine continues unaffected. Log warning, no user-visible error.
- **Ollama unavailable:** Suggestions shown with raw SceneEngine reasons (no narration). No error surfaced to user.
- **AutomationBuilder failure:** Card shows error message with raw YAML so user can copy-paste manually into HA.
- **No patterns yet (new install):** StatisticalEngine scores from raw history alone; AnthropicAnalyzer fires on startup (not gated on 24h wait — runs against whatever history is available).
- **PatternStore corrupt/missing:** Treated as empty store, no crash. AnthropicAnalyzer triggers on next cycle.

---

## Files Changed

### Add-on (`smart-suggestions-addon`)
- **New:** `src/statistical_engine.py` — real-time scoring + background correlation scan
- **New:** `src/pattern_store.py` — persistent pattern store with TTL/decay
- **New:** `src/anthropic_analyzer.py` — nightly deep analysis, configurable provider
- **New:** `src/scene_engine.py` — scene-first ranking + `can_save_as_automation` logic
- **New:** `src/ollama_narrator.py` — narration-only Ollama wrapper
- **New:** `src/automation_builder.py` — YAML generation + HA REST create
- **New:** `src/const.py` — shared constants (`_ACTION_DOMAINS`, `_SKIP_DOMAINS`, `_CONTEXT_ONLY_DOMAINS`, `_INACTIVE_STATES`) currently in `context_builder.py`; all new modules import from here
- **Remove:** `src/context_builder.py` — logic absorbed by StatisticalEngine + SceneEngine
- **Remove:** `src/pattern_analyzer.py` — replaced by AnthropicAnalyzer
- **Remove:** `src/ollama_client.py` — replaced by OllamaNarrator
- **Update:** `src/ha_client.py` — add `create_automation(config_dict)` REST method (POST to Supervisor API); remove `fetch_dow_history` (superseded by `fetch_history(days=N)`); update import of `_ACTION_DOMAINS` to come from `const.py`
- **Update:** `src/main.py` — **full rewrite**. Keep from existing: `_WSLogHandler`, feedback system (`_on_feedback`, `_save_feedback`, `_load_feedback`, `_feedback` dict), `_remove_noops`. Remove: `_run_refresh_cycle`, `_run_analysis`, `_analysis_loop`, impression tracking (absorbed by SceneEngine). Wire all new components. Add background correlation scan task and nightly analysis scheduler.
- **Update:** `src/ws_server.py` — add `save_automation` inbound handler, `automation_result` outbound message, `POST /save_automation` endpoint; remove `broadcast_token` (streaming removed)
- **Update:** `config.yaml` — add all new config keys to `options` and `schema` blocks with defaults; confirm `homeassistant_api: true` present

### Integration (`smart-suggestions-ha`)
- **Update:** `smart-suggestions-card.js` — scene-first layout, Save as Automation button, automation_result handler; remove streaming token handler
- **No change:** `custom_components/smart_suggestions/config_flow.py` — all new config keys live in the add-on's `options.json`, not the integration config entry

---

## Success Criteria

1. Scene suggestions appear at the top of the card and match the user's actual usage patterns within 1–2 weeks of use.
2. "Save as Automation" produces valid HA YAML and creates the automation without manual editing.
3. Correlation-based device suggestions feel contextually relevant ("TV on → dim lights") not random.
4. System is useful on first run (StatisticalEngine works from raw history alone) and gets better over time (AnthropicAnalyzer enriches patterns nightly).
5. Ollama failure does not break suggestions — only narration degrades gracefully.
6. Real-time refresh path completes without waiting on any LLM call.
