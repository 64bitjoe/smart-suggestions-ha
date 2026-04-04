"""Smart Suggestions - registers the Lovelace card served by the add-on."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

_CARD_JS = Path(__file__).parent / "smart-suggestions-card.js"
_static_path_registered = False


async def _register_card(hass: HomeAssistant) -> None:
    global _static_path_registered
    if _static_path_registered:
        return
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            f"/{DOMAIN}/smart-suggestions-card.js",
            str(_CARD_JS),
            cache_headers=False,
        )
    ])
    frontend.add_extra_js_url(hass, f"/{DOMAIN}/smart-suggestions-card.js?v=2.2.0")
    _static_path_registered = True
    _LOGGER.info("Smart Suggestions card registered")


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    await _register_card(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await _register_card(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return True
