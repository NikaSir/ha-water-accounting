"""NikaS Water Accounting panel integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .panel import async_register_panel, async_unregister_panel
from .settings import async_setup_settings

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the integration-owned panel."""
    try:
        await async_setup_settings(hass)
    except OSError as err:
        # Keep monitoring available; settings requests report the storage error.
        _LOGGER.error("Water Accounting settings are unavailable: %s", err)
    try:
        await async_register_panel(hass)
    except (OSError, RuntimeError, ValueError) as err:
        _LOGGER.error("Cannot register Water Accounting panel: %s", err)
        return False
    hass.data.setdefault(DOMAIN, {})['treatment_split_ready'] = True
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the integration-owned panel."""
    hass.data.get(DOMAIN, {}).pop('treatment_split_ready', None)
    # Detach the endpoint but retain settings_manager and its in-flight lock.
    hass.data.get(DOMAIN, {}).pop('settings', None)
    async_unregister_panel(hass)
    return True

