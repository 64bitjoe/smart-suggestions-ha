# Smart Suggestions for Home Assistant — Claude Code Handover

## What This Is

A custom Home Assistant integration + Lovelace card that provides Siri-style contextual suggestions on a dashboard. Ollama (local LLM) reasons about current home state and surfaces 5–10 ranked, tappable actions. Each suggestion has an ⓘ button that reveals why it was surfaced.

---

## Project Structure

```
smart-suggestions-ha/
├── custom_components/
│   └── smart_suggestions/
│       ├── __init__.py          # Core integration: context builder, Ollama caller, HA state writer
│       └── manifest.json        # HA integration manifest
├── www/
│   └── smart-suggestions-card.js  # Custom Lovelace web component
├── configuration_additions.yaml    # Drop-in config.yaml snippets + card YAML
└── HANDOVER.md                     # This file
```

---

## How It Works

1. `__init__.py` registers a `SmartSuggestionsSensor` class that:
   - Watches `watch_entities` for state changes → triggers refresh
   - Runs on a timer (`refresh_interval` minutes) → triggers refresh
   - Exposes a `smart_suggestions.refresh` service for manual/automation triggers
   - Builds a JSON context payload (time of day, entity states, available actions)
   - POSTs to Ollama `/api/generate` with a structured prompt requesting a ranked JSON array
   - Writes the result back to HA state as `smart_suggestions.suggestions` with attributes: `suggestions[]`, `last_updated`, `count`

2. `smart-suggestions-card.js` is a vanilla custom element (no framework) that:
   - Reads `smart_suggestions.suggestions` state + attributes
   - Renders a numbered list with icon, name, action label + current state, and ⓘ button
   - Tapping a row calls the appropriate HA service (domain.toggle/turn_on/turn_off, automation.trigger, script.turn_on, or navigate)
   - Tapping ⓘ reveals the LLM's reason in a slide-down panel
   - Has skeleton loading state, pulse status dot, and green flash on action

---

## Key Design Decisions

- **No external dependencies** — pure Python using HA's built-in aiohttp session
- **State stored directly in HA** via `hass.states.async_set()` (not a real SensorEntity subclass) — simpler but means it won't persist across restarts; first refresh fires on startup
- **Ollama called with `format: "json"`** to enforce structured output; response is stripped of markdown fences defensively
- **LLM prompt temperature = 0.3** — low enough for consistency, not zero so it varies slightly
- **Card is pure shadow DOM** — no external CSS, all styles inlined in `_render()`

---

## Known Limitations / TODO

1. **No persistence** — suggestions clear on HA restart; first Ollama call fires async on startup (takes ~5–30s depending on model)
2. **Entity validator is strict** — `cv.entity_id` in CONFIG_SCHEMA will reject non-standard IDs; may need loosening for some automation IDs
3. **No config flow UI** — config is YAML-only; a config_entries flow would be a nice upgrade for HACS submission
4. **Card editor** — `getConfigElement()` returns a stub; a proper visual editor in the card would be needed for HACS
5. **Suggestion deduplication** — if the same entity appears multiple times in the LLM response, the card shows duplicates; could dedupe by entity_id
6. **`_toggleExpand` calls `_render()` then `_attachListeners()`** — `_render()` already calls `_attachListeners()` at the end, so there's a double-attach; harmless but should be cleaned up
7. **Error state** — if Ollama fails, the card stays on whatever suggestions were last loaded (or empty). No explicit error UI yet.

---

## Environment Context (Joe's Setup)

- **Proxmox cluster**: PVE1 (Ryzen 9 5950X), PVE2 (MacBook), PVE3 (Plex + RTX 4060 Ti)
- **Ollama**: Running on Ubuntu VM on PVE1 with RTX 4060 Ti GPU passthrough (migrated from LXC due to GPU passthrough complexity). Already used for doorbell AI notifications via llmvision.
- **Home Assistant**: Running as HAOS. Mosquitto MQTT broker is internal to HAOS. Zigbee2MQTT managed via Portainer.
- **Existing LLM integrations**: llmvision for camera AI, LM Studio as OpenAI-compatible local service, Ollama integration already configured in HA
- **Dashboard stack**: Mushroom cards, card-mod, auto-entities, custom button-card. Bubble Card avoided due to rendering issues.
- **Network**: UniFi Dream Machine Pro Max, recently overhauled. HA accessible via Tailscale for remote, Cloudflare tunnels for services.

**Ollama IP to use**: Check Joe's Proxmox/Ubuntu VM IP — likely something like `192.168.x.x:11434`. The Ubuntu VM for Ollama was set up specifically for GPU passthrough and vision tasks.

---

## Suggested Next Steps for Claude Code

### Immediate / Setup
- [ ] Replace placeholder entity IDs in `configuration_additions.yaml` with Joe's actual entity IDs (pull from HA states or ask)
- [ ] Set correct `ollama_url` pointing to the Ubuntu VM
- [ ] Choose model — `llama3.2` for speed, `llama3.1` or `mistral` for better reasoning
- [ ] Copy files to HA config volume and restart

### Short-term improvements
- [ ] Add debounce to state-change triggers (currently fires on every watched entity change, could rapid-fire)
- [ ] Add `input_number` or `input_select` for runtime config (model swap, max suggestions) without restarting HA
- [ ] Implement proper error state in the card (show last updated time + "couldn't refresh" message)
- [ ] Add `strings.json` and `services.yaml` for proper HA service documentation
- [ ] Deduplicate suggestions by `entity_id` before rendering

### Longer-term
- [ ] Config entries flow (GUI setup) for HACS compatibility
- [ ] Card visual editor (`getConfigElement()`)
- [ ] Feedback loop: track which suggestions were actually tapped and use that to bias future prompts
- [ ] Per-user suggestions (if Joe's wife has a different profile/presence entity)
- [ ] AppDaemon version as alternative backend for more complex context (calendar, history stats, etc.)

---

## Testing

After setup, check:
1. `smart_suggestions.suggestions` entity appears in HA Developer Tools → States
2. State transitions: `idle` → `updating` → `ready`
3. `attributes.suggestions` is a non-empty array of objects
4. Card renders in dashboard
5. Tapping a row calls the service (watch HA logs)
6. `smart_suggestions.refresh` service call works from Developer Tools → Services

Log filtering: `grep "smart_suggestions" home-assistant.log`
