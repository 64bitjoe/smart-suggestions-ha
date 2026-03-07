"""Smart Suggestions - AI-powered contextual suggestions for Home Assistant."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.typing import ConfigType

_LOGGER = logging.getLogger(__name__)

DOMAIN = "smart_suggestions"
PLATFORMS = [Platform.SENSOR]

CONF_OLLAMA_URL = "ollama_url"
CONF_OLLAMA_MODEL = "ollama_model"
CONF_WATCH_ENTITIES = "watch_entities"
CONF_AVAILABLE_ENTITIES = "available_entities"
CONF_AVAILABLE_AUTOMATIONS = "available_automations"
CONF_AVAILABLE_SCRIPTS = "available_scripts"
CONF_REFRESH_INTERVAL = "refresh_interval"
CONF_MAX_SUGGESTIONS = "max_suggestions"

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "llama3.2"
DEFAULT_REFRESH_INTERVAL = 10  # minutes
DEFAULT_MAX_SUGGESTIONS = 7

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


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up Smart Suggestions from configuration.yaml."""
    if DOMAIN not in config:
        return True

    conf = config[DOMAIN]
    hass.data[DOMAIN] = conf

    await hass.http.async_register_static_paths([
        StaticPathConfig(
            f"/{DOMAIN}/smart-suggestions-card.js",
            str(Path(__file__).parent / "smart-suggestions-card.js"),
            cache_headers=True,
        )
    ])

    hass.async_create_task(
        _async_setup_sensor(hass, conf)
    )

    return True


async def _async_setup_sensor(hass: HomeAssistant, conf: dict) -> None:
    """Set up the suggestions sensor."""
    sensor = SmartSuggestionsSensor(hass, conf)
    await sensor.async_added_to_hass_manual()

    # Register as a persistent entity
    hass.states.async_set(
        f"{DOMAIN}.suggestions",
        "idle",
        {"suggestions": [], "last_updated": None, "friendly_name": "Smart Suggestions"},
    )

    # Store sensor reference
    hass.data[f"{DOMAIN}_sensor"] = sensor

    # Register service to manually trigger refresh
    async def handle_refresh(call):
        await sensor.async_update_suggestions()

    hass.services.async_register(DOMAIN, "refresh", handle_refresh)

    # Initial fetch
    await sensor.async_update_suggestions()


class SmartSuggestionsSensor:
    """Sensor that holds AI-generated suggestions."""

    def __init__(self, hass: HomeAssistant, conf: dict) -> None:
        """Initialize the sensor."""
        self.hass = hass
        self._conf = conf
        self._ollama_url = conf.get(CONF_OLLAMA_URL, DEFAULT_OLLAMA_URL)
        self._model = conf.get(CONF_OLLAMA_MODEL, DEFAULT_MODEL)
        self._watch_entities = conf.get(CONF_WATCH_ENTITIES, [])
        self._available_entities = conf.get(CONF_AVAILABLE_ENTITIES, [])
        self._available_automations = conf.get(CONF_AVAILABLE_AUTOMATIONS, [])
        self._available_scripts = conf.get(CONF_AVAILABLE_SCRIPTS, [])
        self._refresh_interval = conf.get(CONF_REFRESH_INTERVAL, DEFAULT_REFRESH_INTERVAL)
        self._max_suggestions = conf.get(CONF_MAX_SUGGESTIONS, DEFAULT_MAX_SUGGESTIONS)
        self._suggestions = []
        self._unsub_state = None
        self._unsub_time = None

    async def async_added_to_hass_manual(self) -> None:
        """Set up listeners."""
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
        """Handle watched entity state changes."""
        self.hass.async_create_task(self.async_update_suggestions())

    @callback
    def _handle_time_interval(self, now) -> None:
        """Handle scheduled refresh."""
        self.hass.async_create_task(self.async_update_suggestions())

    def _build_context(self) -> dict:
        """Build context payload from current HA state."""
        now = datetime.now()

        # Time context
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

        # Collect states of all relevant entities
        all_entity_ids = list(
            set(self._watch_entities + self._available_entities)
        )

        for entity_id in all_entity_ids:
            state = self.hass.states.get(entity_id)
            if state:
                context["entity_states"][entity_id] = {
                    "state": state.state,
                    "friendly_name": state.attributes.get("friendly_name", entity_id),
                    "attributes": {
                        k: v
                        for k, v in state.attributes.items()
                        if k
                        not in ("entity_picture", "icon", "supported_features")
                        and not isinstance(v, (list, dict))
                    },
                }

        # Available actions
        for entity_id in self._available_entities:
            state = self.hass.states.get(entity_id)
            if state:
                domain = entity_id.split(".")[0]
                name = state.attributes.get("friendly_name", entity_id)
                context["available_actions"].append(
                    {
                        "type": "entity",
                        "entity_id": entity_id,
                        "name": name,
                        "current_state": state.state,
                        "domain": domain,
                    }
                )

        for automation_id in self._available_automations:
            state = self.hass.states.get(automation_id)
            name = (
                state.attributes.get("friendly_name", automation_id)
                if state
                else automation_id
            )
            context["available_actions"].append(
                {
                    "type": "automation",
                    "entity_id": automation_id,
                    "name": name,
                }
            )

        for script_id in self._available_scripts:
            state = self.hass.states.get(script_id)
            name = (
                state.attributes.get("friendly_name", script_id)
                if state
                else script_id
            )
            context["available_actions"].append(
                {
                    "type": "script",
                    "entity_id": script_id,
                    "name": name,
                }
            )

        return context

    def _build_prompt(self, context: dict) -> str:
        """Build the LLM prompt."""
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
        """Fetch new suggestions from Ollama."""
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
                "options": {
                    "temperature": 0.3,
                    "num_predict": 2048,
                },
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

            # Parse JSON response - strip markdown fences if present
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

            _LOGGER.info(
                "Smart Suggestions updated: %d suggestions", len(self._suggestions)
            )

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
