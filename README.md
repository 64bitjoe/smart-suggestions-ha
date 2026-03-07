# Smart Suggestions for Home Assistant

AI-powered contextual suggestions on your dashboard — like Siri suggestions but for your home. Powered by a local Ollama LLM, it surfaces ranked, tappable actions based on time of day, entity states, and context.

![Smart Suggestions Card](https://raw.githubusercontent.com/64bitjoe/smart-suggestions-ha/main/docs/screenshot.png)

## Features

- Ranked suggestions with one-tap actions
- "Why suggested?" reason panel per suggestion
- Skeleton loading state + live status dot
- Fully local — no cloud, no API keys (uses Ollama)
- Auto-refreshes on a timer or when watched entities change
- Manual refresh button on the card

## Requirements

- [Ollama](https://ollama.ai) running and accessible from Home Assistant (local or on your network)
- A pulled model — `llama3.2` recommended for speed, `mistral` for better reasoning

## Installation via HACS

1. In HACS, go to **Integrations** → three-dot menu → **Custom repositories**
2. Add `https://github.com/64bitjoe/smart-suggestions-ha` as an **Integration**
3. Find "Smart Suggestions" in HACS and install
4. Restart Home Assistant
5. Add the Lovelace resource (one-time):
   - Go to **Settings → Dashboards → Resources**
   - Add `/smart_suggestions/smart-suggestions-card.js` as a **JavaScript Module**
6. Configure via `configuration.yaml` (see below)
7. Restart Home Assistant again

## Manual Installation

1. Copy `custom_components/smart_suggestions/` into your HA `config/custom_components/` folder
2. Add the Lovelace resource:
   - **Settings → Dashboards → Resources → Add resource**
   - URL: `/smart_suggestions/smart-suggestions-card.js`
   - Type: JavaScript Module
3. Configure and restart

## Configuration

Add to your `configuration.yaml`:

```yaml
smart_suggestions:
  ollama_url: "http://192.168.1.100:11434"   # Your Ollama host
  ollama_model: "llama3.2"
  refresh_interval: 10                        # Minutes between auto-refreshes
  max_suggestions: 7

  # Entities whose state changes trigger a refresh
  watch_entities:
    - binary_sensor.someone_home
    - input_boolean.guest_mode

  # Entities the LLM can suggest actions for
  available_entities:
    - light.living_room
    - light.bedroom
    - switch.fan
    - climate.thermostat
    - media_player.tv

  # Automations the LLM can trigger
  available_automations:
    - automation.evening_scene
    - automation.good_morning

  # Scripts the LLM can run
  available_scripts:
    - script.movie_time
    - script.good_night
```

## Lovelace Card

Add the card to your dashboard:

```yaml
type: custom:smart-suggestions-card
title: Suggested for You
```

### Card options

| Option | Default | Description |
|---|---|---|
| `entity` | `smart_suggestions.suggestions` | The sensor entity |
| `title` | `Suggested for You` | Card header title |
| `show_title` | `true` | Show/hide the header |
| `show_refresh` | `true` | Show manual refresh button |
| `show_last_updated` | `true` | Show relative time since last update |
| `accent_color` | HA primary colour | Hex colour for accents |
| `empty_message` | `Thinking of suggestions…` | Message when no suggestions yet |

The card also has a visual editor — click the pencil icon in the dashboard editor.

## Services

| Service | Description |
|---|---|
| `smart_suggestions.refresh` | Manually trigger a suggestions refresh |

Call from **Developer Tools → Services** or from an automation.

## Troubleshooting

- Check **Settings → System → Logs** and filter for `smart_suggestions`
- Verify Ollama is reachable: `curl http://YOUR_OLLAMA_IP:11434/api/tags`
- The entity `smart_suggestions.suggestions` should appear in **Developer Tools → States**
- State transitions: `idle` → `updating` → `ready`

## License

MIT
