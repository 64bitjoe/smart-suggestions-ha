"""Smart Suggestions - AI-powered contextual suggestions for Home Assistant."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path

import aiohttp
import voluptuous as vol

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_AVAILABLE_AUTOMATIONS,
    CONF_AVAILABLE_ENTITIES,
    CONF_AVAILABLE_SCRIPTS,
    CONF_MAX_SUGGESTIONS,
    CONF_OLLAMA_MODEL,
    CONF_OLLAMA_URL,
    CONF_REFRESH_INTERVAL,
    CONF_WATCH_ENTITIES,
    DEFAULT_MAX_SUGGESTIONS,
    DEFAULT_MODEL,
    DEFAULT_OLLAMA_URL,
    DEFAULT_REFRESH_INTERVAL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Required(CONF_OLLAMA_URL, default=DEFAULT_OLLAMA_URL): cv.string,
                vol.Required(CONF_OLLAMA_MODEL, default=DEFAULT_MODEL): cv.string,
                vol.Optional(CONF_WATCH_ENTITIES, default=[]): vol.All(
                    cv.ensure_list, [cv.entity_id]
                ),
                vol.Optional(CONF_AVAILABLE_ENTITIES, default=[]): vol.All(
                    cv.ensure_list, [cv.entity_id]
                ),
                vol.Optional(CONF_AVAILABLE_AUTOMATIONS, default=[]): vol.All(
                    cv.ensure_list, [cv.string]
                ),
                vol.Optional(CONF_AVAILABLE_SCRIPTS, default=[]): vol.All(
                    cv.ensure_list, [cv.string]
                ),
                vol.Optional(
                    CONF_REFRESH_INTERVAL, default=DEFAULT_REFRESH_INTERVAL
                ): vol.Coerce(int),
                vol.Optional(
                    CONF_MAX_SUGGESTIONS, default=DEFAULT_MAX_SUGGESTIONS
                ): vol.Coerce(int),
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)

_CARD_JS = Path(__file__).parent / "smart-suggestions-card.js"
_static_path_registered = False


async def _register_static_path(hass: HomeAssistant) -> None:
    global _static_path_registered
    if _static_path_registered:
        return
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            f"/{DOMAIN}/smart-suggestions-card.js",
            str(_CARD_JS),
            cache_headers=True,
        )
    ])
    _static_path_registered = True


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up Smart Suggestions from configuration.yaml."""
    if DOMAIN not in config:
        return True

    conf = config[DOMAIN]
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["yaml_conf"] = conf

    await _register_static_path(hass)
    hass.async_create_task(_async_setup_sensor(hass, conf, entry_id="yaml"))
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Smart Suggestions from a config entry."""
    conf = {**entry.data, **entry.options}
    hass.data.setdefault(DOMAIN, {})

    await _register_static_path(hass)
    await _async_setup_sensor(hass, conf, entry_id=entry.entry_id)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    entry_data = hass.data.get(DOMAIN, {}).pop(entry.entry_id, {})
    sensor: SmartSuggestionsSensor | None = entry_data.get("sensor")
    if sensor:
        if sensor._unsub_state:
            sensor._unsub_state()
        if sensor._unsub_time:
            sensor._unsub_time()
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def _async_setup_sensor(
    hass: HomeAssistant, conf: dict, entry_id: str
) -> None:
    """Shared sensor setup for both YAML and config entry paths."""
    sensor = SmartSuggestionsSensor(hass, conf)
    await sensor.async_added_to_hass_manual()

    hass.data.setdefault(DOMAIN, {})[entry_id] = {"sensor": sensor}

    hass.states.async_set(
        f"{DOMAIN}.suggestions",
        "idle",
        {"suggestions": [], "last_updated": None, "friendly_name": "Smart Suggestions"},
    )

    if not hass.services.has_service(DOMAIN, "refresh"):
        async def handle_refresh(call):
            for data in hass.data.get(DOMAIN, {}).values():
                s = data.get("sensor") if isinstance(data, dict) else None
                if s:
                    await s.async_update_suggestions()

        hass.services.async_register(DOMAIN, "refresh", handle_refresh)

    await sensor.async_update_suggestions()


class SmartSuggestionsSensor:
    """Sensor that holds AI-generated suggestions."""

    def __init__(self, hass: HomeAssistant, conf: dict) -> None:
        self.hass = hass
        self._ollama_url = conf.get(CONF_OLLAMA_URL, DEFAULT_OLLAMA_URL)
        self._model = conf.get(CONF_OLLAMA_MODEL, DEFAULT_MODEL)
        self._watch_entities = conf.get(CONF_WATCH_ENTITIES, [])
        self._available_entities = conf.get(CONF_AVAILABLE_ENTITIES, [])
        self._available_automations = conf.get(CONF_AVAILABLE_AUTOMATIONS, [])
        self._available_scripts = conf.get(CONF_AVAILABLE_SCRIPTS, [])
        self._refresh_interval = int(conf.get(CONF_REFRESH_INTERVAL, DEFAULT_REFRESH_INTERVAL))
        self._max_suggestions = int(conf.get(CONF_MAX_SUGGESTIONS, DEFAULT_MAX_SUGGESTIONS))
        self._suggestions = []
        self._unsub_state = None
        self._unsub_time = None

    async def async_added_to_hass_manual(self) -> None:
        if self._watch_entities:
            self._unsub_state = async_track_state_change_event(
                self.hass,
                self._watch_entities,
                self._handle_state_change,
            )

        self._unsub_time = async_track_time_interval(
            self.hass,
            self._handle_time_interval,
            timedelta(minutes=self._refresh_interval),
        )

    @callback
    def _handle_state_change(self, event) -> None:
        self.hass.async_create_task(self.async_update_suggestions())

    @callback
    def _handle_time_interval(self, now) -> None:
        self.hass.async_create_task(self.async_update_suggestions())

    def _build_context(self) -> dict:
        now = datetime.now()
        hour = now.hour
        if 5 <= hour < 9:
            time_period = "early morning"
        elif 9 <= hour < 12:
            time_period = "morning"
        elif 12 <= hour < 14:
            time_period = "midday"
        elif 14 <= hour < 18:
            time_period = "afternoon"
        elif 18 <= hour < 21:
            time_period = "evening"
        elif 21 <= hour < 23:
            time_period = "late evening"
        else:
            time_period = "night"

        context = {
            "current_time": now.strftime("%H:%M"),
            "current_date": now.strftime("%A, %B %d %Y"),
            "time_period": time_period,
            "entity_states": {},
            "available_actions": [],
        }

        all_entity_ids = list(set(self._watch_entities + self._available_entities))
        for entity_id in all_entity_ids:
            state = self.hass.states.get(entity_id)
            if state:
                context["entity_states"][entity_id] = {
                    "state": state.state,
                    "friendly_name": state.attributes.get("friendly_name", entity_id),
                    "attributes": {
                        k: v
                        for k, v in state.attributes.items()
                        if k not in ("entity_picture", "icon", "supported_features")
                        and not isinstance(v, (list, dict))
                    },
                }

        for entity_id in self._available_entities:
            state = self.hass.states.get(entity_id)
            if state:
                context["available_actions"].append(
                    {
                        "type": "entity",
                        "entity_id": entity_id,
                        "name": state.attributes.get("friendly_name", entity_id),
                        "current_state": state.state,
                        "domain": entity_id.split(".")[0],
                    }
                )

        for automation_id in self._available_automations:
            state = self.hass.states.get(automation_id)
            name = state.attributes.get("friendly_name", automation_id) if state else automation_id
            context["available_actions"].append(
                {"type": "automation", "entity_id": automation_id, "name": name}
            )

        for script_id in self._available_scripts:
            state = self.hass.states.get(script_id)
            name = state.attributes.get("friendly_name", script_id) if state else script_id
            context["available_actions"].append(
                {"type": "script", "entity_id": script_id, "name": name}
            )

        return context

    def _build_prompt(self, context: dict) -> str:
        return f"""You are a smart home assistant. Based on the current context, suggest the most relevant actions a user might want to take RIGHT NOW.

CONTEXT:
- Time: {context['current_time']} ({context['time_period']} on {context['current_date']})
- Entity States: {json.dumps(context['entity_states'], indent=2)}

AVAILABLE ACTIONS:
{json.dumps(context['available_actions'], indent=2)}

Return ONLY a valid JSON array (no markdown, no explanation) with {self._max_suggestions} suggestions ranked by relevance. Each suggestion must have:
- "entity_id": the entity_id to act on
- "name": friendly display name
- "action": one of "toggle", "turn_on", "turn_off", "trigger", "navigate"
- "action_data": optional dict of service call data (e.g. {{"brightness_pct": 50}})
- "reason": a SHORT 1-sentence explanation of WHY this is suggested right now (be specific to the context)
- "icon": a Material Design icon name (e.g. "mdi:lightbulb", "mdi:thermostat")
- "type": one of "entity", "automation", "script"

Only suggest actions that make contextual sense RIGHT NOW. Do not suggest turning something off that is already off."""

    async def async_update_suggestions(self) -> None:
        _LOGGER.debug("Fetching smart suggestions from Ollama")

        self.hass.states.async_set(
            f"{DOMAIN}.suggestions",
            "updating",
            {
                "suggestions": self._suggestions,
                "last_updated": datetime.now().isoformat(),
                "friendly_name": "Smart Suggestions",
            },
        )

        try:
            context = self._build_context()
            prompt = self._build_prompt(context)
            session = async_get_clientsession(self.hass)

            payload = {
                "model": self._model,
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.3, "num_predict": 2048},
            }

            async with session.post(
                f"{self._ollama_url}/api/generate",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status != 200:
                    _LOGGER.error("Ollama returned status %s", resp.status)
                    return
                data = await resp.json()
                raw_response = data.get("response", "")

            clean = raw_response.strip()
            if clean.startswith("```"):
                clean = clean.split("```")[1]
                if clean.startswith("json"):
                    clean = clean[4:]
            clean = clean.strip()

            suggestions = json.loads(clean)
            if not isinstance(suggestions, list):
                suggestions = suggestions.get("suggestions", [])

            self._suggestions = suggestions[: self._max_suggestions]
            _LOGGER.info("Smart Suggestions updated: %d suggestions", len(self._suggestions))

        except json.JSONDecodeError as e:
            _LOGGER.error("Failed to parse Ollama response as JSON: %s", e)
        except aiohttp.ClientError as e:
            _LOGGER.error("Failed to connect to Ollama: %s", e)
        except Exception as e:  # noqa: BLE001
            _LOGGER.error("Unexpected error updating suggestions: %s", e)
        finally:
            self.hass.states.async_set(
                f"{DOMAIN}.suggestions",
                "ready",
                {
                    "suggestions": self._suggestions,
                    "last_updated": datetime.now().isoformat(),
                    "friendly_name": "Smart Suggestions",
                    "count": len(self._suggestions),
                },
            )
