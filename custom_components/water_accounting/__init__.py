"""NikaS Water Accounting panel integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .panel import async_register_panel, async_unregister_panel

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the integration-owned panel."""
    try:
        await async_register_panel(hass)
    except (OSError, RuntimeError, ValueError) as err:
        _LOGGER.error("Cannot register Water Accounting panel: %s", err)
        return False
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the integration-owned panel."""
    async_unregister_panel(hass)
    return True

