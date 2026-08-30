"""Register the integration-owned NikaS water panel."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import (
    DOMAIN,
    ENTITY_MAP,
    PRESSURE_POLICY,
    UI_STANDARD_VERSION,
    UI_VERSION,
)

PANEL_ID = "water-accounting"
PANEL_TITLE = "Учёт воды"
PANEL_URL_PATH = "dashboard-water"
PANEL_PARENT_ROUTE = "/dashboard-house-v11/home"
PANEL_ICON = "mdi:water"
PANEL_WEB_COMPONENT = "nikas-water-accounting-panel"
PANEL_STATIC_URL = "/water_accounting_panel"
PANEL_STATIC_REGISTERED = "panel_static_registered"
PANEL_DIRECTORY = Path(__file__).parent / "frontend"
PANEL_BUNDLE = "water-accounting-panel.js"

PANEL_METADATA = {
    "id": PANEL_ID,
    "title": PANEL_TITLE,
    "path": f"/{PANEL_URL_PATH}",
    "entry_route": f"/{PANEL_URL_PATH}",
    "parent_route": PANEL_PARENT_ROUTE,
    "safe_return_route": PANEL_PARENT_ROUTE,
    "icon": PANEL_ICON,
    "owner": DOMAIN,
    "preferred_view": "overview",
    "ui_version": UI_VERSION,
    "template_version": UI_STANDARD_VERSION,
    "frontend_bundle": PANEL_BUNDLE,
    "read_only": True,
    "entities": ENTITY_MAP,
    "pressure_policy": PRESSURE_POLICY,
    "tabs": [
        ["overview", "mdi:water-outline", "Обзор"],
        ["consumption", "mdi:chart-bar", "Расход"],
        ["meters", "mdi:gauge", "Счётчики"],
        ["diagnostics", "mdi:stethoscope", "Диагн."],
    ],
}


async def async_register_panel(hass: HomeAssistant) -> None:
    """Register static frontend files and the custom panel."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if not domain_data.get(PANEL_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_STATIC_URL, str(PANEL_DIRECTORY), cache_headers=False)]
        )
        domain_data[PANEL_STATIC_REGISTERED] = True

    if frontend.async_panel_exists(hass, PANEL_URL_PATH):
        return

    await panel_custom.async_register_panel(
        hass=hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_WEB_COMPONENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{PANEL_STATIC_URL}/{PANEL_BUNDLE}?v={UI_VERSION}",
        embed_iframe=False,
        require_admin=False,
        handle_safe_area=True,
        config=PANEL_METADATA,
    )


def async_unregister_panel(hass: HomeAssistant) -> None:
    """Unregister the custom panel."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
