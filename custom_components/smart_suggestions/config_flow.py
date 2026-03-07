"""Config flow for Smart Suggestions."""
from __future__ import annotations

from homeassistant import config_entries
from homeassistant.core import callback

from .const import DOMAIN


class SmartSuggestionsConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """One-step setup — just creates the entry to register the card."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title="Smart Suggestions", data={})
