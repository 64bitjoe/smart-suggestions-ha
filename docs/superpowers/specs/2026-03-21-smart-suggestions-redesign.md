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

Runs on every refresh cycle. No LLM. Produces:

- **Routine candidates** — scans history by time-of-day and day-of-week. For each entity, computes frequency of activation at the current time window (±30min) on the same weekday over configurable history depth. Produces confidence score (0–1).
- **Scene match score** — for each scene, compares member target states vs current states → match ratio (0–1). Scenes with match ratio ≥ 0.6 are promoted.
- **Co-occurrence correlations** — detects entity pairs that change state within a configurable time window (default 5min) with statistical frequency. Produces correlation candidates stored in PatternStore.

Output: ranked list of scene candidates + device candidates with scores and reasons.

### 2. PatternStore (`pattern_store.py`)

Persists structured patterns between restarts and across Anthropic analysis cycles.

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
      "source": "anthropic"
    }
  ],
  "correlations": [
    {
      "entity_a": "media_player.tv",
      "entity_b": "light.living_room",
      "pattern": "living room dims within 5min of TV turning on",
      "confidence": 0.82,
      "window_minutes": 5,
      "source": "statistical"
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

Patterns decay over time (configurable TTL per source). Statistical patterns refresh every cycle; Anthropic patterns persist until next nightly run.

### 3. AnthropicAnalyzer (`anthropic_analyzer.py`)

Runs nightly (configurable schedule) and on manual trigger. Configurable provider — defaults to Anthropic, can be swapped to any OpenAI-compatible endpoint.

Responsibilities:
- Fetches compact history summary over configurable depth (default 14 days, configurable 7–90 days, adapts based on output quality)
- Sends to Anthropic claude-opus-4-6 (or configured model)
- Receives structured patterns: routines, correlation chains, anomalies
- Merges into PatternStore (Anthropic patterns tagged `source: "anthropic"`, higher confidence weight)

Prompt is tightly structured — returns JSON only. Includes current time context so `right_now` insights are useful.

### 4. SceneEngine (`scene_engine.py`)

Scene-first ranking. Single responsibility: produce a ranked list of suggestions where scenes come first.

Priority order:
1. Scenes with high match ratio AND pattern match (user typically activates this scene at this time)
2. Scenes with high match ratio only (home is already in the right state)
3. Scenes with strong pattern match only (typical time, not yet in state)
4. Device suggestions from active correlations ("TV on → dim lights")
5. Device anomalies ("kitchen light on longer than usual")

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
    "can_save_as_automation": true
  }
]
```

### 5. OllamaNarrator (`ollama_narrator.py`)

Constrained, real-time only. Given pre-ranked candidates with scores from SceneEngine, Ollama's only job is:
- Improve/rewrite the `reason` to be more natural
- Optionally flag if a suggestion seems contextually wrong

Prompt is tiny — candidates list + current time, return reasons only. No ranking. No candidate selection.

### 6. AutomationBuilder (`automation_builder.py`)

On-demand, triggered by user clicking "Save as Automation" in the card.

Given a suggestion (scene + time + days pattern), calls Anthropic to generate valid HA automation YAML:
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

Posts to HA REST API (`/api/config/automation/config/<uuid>`). Returns success/failure to card.

### 7. WSServer + Card

**Card redesign (post v1.0.20):**
- **Primary zone:** single dominant scene card — name, reason, confidence label, one-tap activate, "Save as Automation" button
- **Secondary zone:** 2–3 device-level suggestions (correlations/anomalies)
- Scaling/confidence border removed — replaced with text label
- Card revisit deferred to implementation phase

---

## Data Flow

```
Every refresh cycle (real-time path):
  HAClient.get_states()
    → StatisticalEngine.score(states, history, PatternStore)
    → SceneEngine.rank(candidates)
    → OllamaNarrator.narrate(top_candidates)  [optional, async]
    → WSServer.broadcast(suggestions)
    → HAClient.write_state(suggestions)

Nightly (analysis path):
  HAClient.fetch_history(days=14)
    → AnthropicAnalyzer.analyze(history, states)
    → PatternStore.merge(patterns)

On-demand (automation path):
  User clicks "Save as Automation"
    → AutomationBuilder.build(suggestion)
    → HAClient.create_automation(yaml)
    → Card shows confirmation
```

---

## Configuration (options.json)

```json
{
  "refresh_interval": 10,
  "max_suggestions": 7,
  "history_hours": 4,
  "analysis_depth_days": 14,
  "analysis_schedule": "03:00",
  "ai_provider": "anthropic",
  "ai_api_key": "",
  "ai_model": "claude-opus-4-6",
  "ollama_url": "http://localhost:11434",
  "ollama_model": "llama3.2",
  "correlation_window_minutes": 5,
  "pattern_confidence_threshold": 0.6
}
```

---

## Error Handling

- **Anthropic unavailable:** PatternStore serves stale patterns; StatisticalEngine continues unaffected. Log warning, no user-visible error.
- **Ollama unavailable:** Suggestions shown without narrated reasons (raw reason from SceneEngine used as fallback).
- **AutomationBuilder failure:** Card shows error message with the raw YAML so user can copy-paste manually.
- **No patterns yet (first run):** StatisticalEngine works from history alone; AnthropicAnalyzer triggered on first startup after 24h of data exists.

---

## Files Changed

### Add-on (`smart-suggestions-addon`)
- **New:** `src/statistical_engine.py`
- **New:** `src/pattern_store.py`
- **New:** `src/anthropic_analyzer.py`
- **New:** `src/scene_engine.py`
- **New:** `src/ollama_narrator.py`
- **New:** `src/automation_builder.py`
- **Replace:** `src/context_builder.py` → removed (logic split into StatisticalEngine + SceneEngine)
- **Replace:** `src/pattern_analyzer.py` → removed (replaced by AnthropicAnalyzer)
- **Replace:** `src/ollama_client.py` → becomes `ollama_narrator.py` (constrained role)
- **Update:** `src/main.py` — wire new components
- **Update:** `config.yaml` — new config options

### Integration (`smart-suggestions-ha`)
- **Update:** `smart-suggestions-card.js` — scene-first layout, Save as Automation button
- **Update:** `custom_components/smart_suggestions/config_flow.py` — new config fields

---

## Success Criteria

1. Scene suggestions appear at the top of the card and match the user's actual usage patterns within 1–2 weeks of use.
2. "Save as Automation" produces valid HA YAML and creates the automation without manual editing.
3. Correlation-based device suggestions feel contextually relevant ("TV on → dim lights") not random.
4. System is useful on first run (StatisticalEngine works from raw history) and gets better over time (AnthropicAnalyzer enriches patterns).
5. Ollama failure does not break suggestions — only narration degrades.
