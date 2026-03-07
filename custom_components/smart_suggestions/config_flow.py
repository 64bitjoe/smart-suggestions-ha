"""Config flow for Smart Suggestions."""
from __future__ import annotations

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

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

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_OLLAMA_URL, default=DEFAULT_OLLAMA_URL): str,
        vol.Required(CONF_OLLAMA_MODEL, default=DEFAULT_MODEL): str,
        vol.Optional(CONF_REFRESH_INTERVAL, default=DEFAULT_REFRESH_INTERVAL): int,
        vol.Optional(CONF_MAX_SUGGESTIONS, default=DEFAULT_MAX_SUGGESTIONS): int,
    }
)


class SmartSuggestionsConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the initial setup config flow."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}

        if user_input is not None:
            try:
                session = async_get_clientsession(self.hass)
                async with session.get(
                    f"{user_input[CONF_OLLAMA_URL]}/api/tags",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status != 200:
                        errors["base"] = "cannot_connect"
            except Exception:
                errors["base"] = "cannot_connect"

            if not errors:
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title="Smart Suggestions", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_SCHEMA,
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return SmartSuggestionsOptionsFlow(config_entry)


class SmartSuggestionsOptionsFlow(config_entries.OptionsFlow):
    """Handle options (entity lists + tuning) after initial setup."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        merged = {**self._entry.data, **self._entry.options}

        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_OLLAMA_URL,
                    default=merged.get(CONF_OLLAMA_URL, DEFAULT_OLLAMA_URL),
                ): selector.TextSelector(),
                vol.Optional(
                    CONF_OLLAMA_MODEL,
                    default=merged.get(CONF_OLLAMA_MODEL, DEFAULT_MODEL),
                ): selector.TextSelector(),
                vol.Optional(
                    CONF_REFRESH_INTERVAL,
                    default=merged.get(CONF_REFRESH_INTERVAL, DEFAULT_REFRESH_INTERVAL),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(min=1, max=60, step=1, mode=selector.NumberSelectorMode.BOX)
                ),
                vol.Optional(
                    CONF_MAX_SUGGESTIONS,
                    default=merged.get(CONF_MAX_SUGGESTIONS, DEFAULT_MAX_SUGGESTIONS),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(min=1, max=20, step=1, mode=selector.NumberSelectorMode.BOX)
                ),
                vol.Optional(
                    CONF_WATCH_ENTITIES,
                    default=merged.get(CONF_WATCH_ENTITIES, []),
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(multiple=True)
                ),
                vol.Optional(
                    CONF_AVAILABLE_ENTITIES,
                    default=merged.get(CONF_AVAILABLE_ENTITIES, []),
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(multiple=True)
                ),
                vol.Optional(
                    CONF_AVAILABLE_AUTOMATIONS,
                    default=merged.get(CONF_AVAILABLE_AUTOMATIONS, []),
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="automation", multiple=True)
                ),
                vol.Optional(
                    CONF_AVAILABLE_SCRIPTS,
                    default=merged.get(CONF_AVAILABLE_SCRIPTS, []),
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="script", multiple=True)
                ),
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema)
