"""Validated, revisioned settings for the Water Accounting panel.

The durable read/write checks follow Water Treatment's journal-storage pattern:
read the public Store path directly, and confirm a Store write by reading it back.
This module has no runtime dependency on Water Treatment.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import date, datetime
import json
import math
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_STORAGE_VERSION = 1
_STORAGE_KEY = "water_accounting.settings"
_REGISTERED_KEY = "settings_command_registered"
_MANAGER_KEY = "settings_manager"
_FIRST_SUPPORTED_DATE = date(2015, 1, 1)
_MOSCOW = ZoneInfo("Europe/Moscow")
_SETTINGS_KEYS = {
    "statistics_start_date", "low_day_threshold_l",
    "regeneration_verified_from", "regeneration_verified_through", "irrigation",
}
_IRRIGATION_KEYS = {"enabled", "reason", "since"}


def moscow_today() -> date:
    """Return the date at the installation's accounting timezone."""
    return datetime.now(_MOSCOW).date()


def _defaults() -> dict[str, Any]:
    return {
        "revision": 0,
        "settings": {
            "statistics_start_date": "2026-10-27",
            "low_day_threshold_l": 100,
            "regeneration_verified_from": None,
            "regeneration_verified_through": None,
            "irrigation": {"enabled": True, "reason": "", "since": None},
        },
    }


def _validate_date(value: Any, field: str, today: date) -> date:
    if not isinstance(value, str):
        raise ValueError(f"{field}: укажите дату в формате ГГГГ-ММ-ДД")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as err:
        raise ValueError(f"{field}: укажите дату в формате ГГГГ-ММ-ДД") from err
    if parsed.isoformat() != value:
        raise ValueError(f"{field}: укажите дату в формате ГГГГ-ММ-ДД")
    if not _FIRST_SUPPORTED_DATE <= parsed <= today:
        raise ValueError(f"{field}: допустимы даты с 2015-01-01 по {today.isoformat()} включительно (московское время)")
    return parsed


def _validate_revision(revision: Any) -> None:
    if type(revision) is not int or revision < 0:
        raise ValueError("Версия настроек должна быть целым неотрицательным числом")


def validate_settings(value: Any) -> dict[str, Any]:
    """Validate a complete settings object without coercing submitted values."""
    if not isinstance(value, dict) or set(value) != _SETTINGS_KEYS:
        raise ValueError("Передайте полный набор поддерживаемых настроек без лишних полей")
    today = moscow_today()
    _validate_date(value["statistics_start_date"], "Дата начала статистики", today)
    threshold = value["low_day_threshold_l"]
    if (
        type(threshold) not in (int, float)
        or not 0 <= threshold <= 10000
        or not math.isfinite(threshold)
    ):
        raise ValueError("Порог низкого расхода должен быть конечным числом от 0 до 10000 литров")
    first = value["regeneration_verified_from"]
    last = value["regeneration_verified_through"]
    if (first is None) != (last is None):
        raise ValueError("Укажите обе границы подтверждённого периода регенераций или оставьте обе пустыми")
    if first is not None:
        start = _validate_date(first, "Начало подтверждённого периода регенераций", today)
        end = _validate_date(last, "Конец подтверждённого периода регенераций", today)
        if start > end:
            raise ValueError("Конец подтверждённого периода регенераций не может быть раньше начала")
    irrigation = value["irrigation"]
    if not isinstance(irrigation, dict) or set(irrigation) != _IRRIGATION_KEYS:
        raise ValueError("Настройки полива должны содержать состояние линии, причину и дату без лишних полей")
    if type(irrigation["enabled"]) is not bool:
        raise ValueError("Состояние линии полива должно быть логическим значением: включена или отключена")
    reason = irrigation["reason"]
    if not isinstance(reason, str) or len(reason) > 500:
        raise ValueError("Причина отключения линии полива должна быть текстом длиной не более 500 символов")
    since = irrigation["since"]
    if since is not None:
        _validate_date(since, "Дата отключения линии полива", today)
    if not irrigation["enabled"] and (not reason.strip() or since is None):
        raise ValueError("Для отключённой линии полива укажите причину и дату отключения")
    return deepcopy(value)


def _validate_snapshot(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"revision", "settings"}:
        raise ValueError("Сохранённые настройки имеют неверную структуру")
    _validate_revision(value["revision"])
    return {"revision": value["revision"], "settings": validate_settings(value["settings"])}


def _read_settings_file(filename: str, key: str) -> dict[str, Any] | None:
    path = Path(filename)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        if any(path.parent.glob(path.name + ".corrupt.*")):
            raise OSError("Обнаружена резервная копия повреждённых настроек; требуется восстановление хранилища")
        return None
    try:
        envelope = json.loads(text)
        if (
            not isinstance(envelope, dict)
            or type(envelope.get("version")) is not int
            or envelope["version"] != _STORAGE_VERSION
            or type(envelope.get("minor_version")) is not int
            or envelope["minor_version"] != 1
            or envelope.get("key") != key
        ):
            raise ValueError("Формат файла настроек не поддерживается")
        return _validate_snapshot(envelope.get("data"))
    except (ValueError, TypeError) as err:
        raise OSError("Файл настроек повреждён; требуется восстановление хранилища") from err


class SettingsStore(Store):
    """Use HA atomic storage without its silent corrupt-file recovery behavior."""

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(hass, _STORAGE_VERSION, _STORAGE_KEY, atomic_writes=True)
        self._settings_hass = hass

    async def async_load(self) -> dict[str, Any] | None:
        """Read durable content, bypassing Store's delayed data cache."""
        try:
            return await self._settings_hass.async_add_executor_job(
                _read_settings_file, self.path, _STORAGE_KEY
            )
        except UnicodeError as err:
            raise OSError("Файл настроек имеет неверную кодировку UTF-8") from err

    async def async_save(self, value: dict[str, Any]) -> None:
        """Return success only after the exact snapshot is durable."""
        await super().async_save(value)
        if await self.async_load() != value:
            raise OSError("Не удалось подтвердить сохранение настроек на диске")


class RevisionConflict(ValueError):
    """The caller's displayed snapshot is no longer current."""


class SettingsManager:
    """Serialize settings updates and reject stale displayed revisions."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.store = SettingsStore(hass)
        self._lock = asyncio.Lock()
        self._seen_saved = False

    async def _read(self) -> dict[str, Any]:
        snapshot = await self.store.async_load()
        if snapshot is None:
            if self._seen_saved:
                raise OSError("Файл ранее сохранённых настроек отсутствует")
            return _defaults()
        self._seen_saved = True
        return snapshot

    async def async_get(self) -> dict[str, Any]:
        async with self._lock:
            return deepcopy(await self._read())

    async def async_update(self, payload: Any, revision: Any) -> dict[str, Any]:
        _validate_revision(revision)
        settings = validate_settings(payload)
        async with self._lock:
            current = await self._read()
            if revision != current["revision"]:
                raise RevisionConflict("Настройки уже изменены. Загрузите актуальную версию и подтвердите изменения заново")
            updated = {"revision": revision + 1, "settings": settings}
            await self.store.async_save(updated)
            self._seen_saved = True
            return deepcopy(updated)


@websocket_api.websocket_command({
    vol.Required("type"): "water_accounting/settings",
    vol.Required("action"): vol.In(["get", "update"]),
    vol.Optional("payload"): dict,
    vol.Optional("revision"): int,
})
@websocket_api.async_response
async def settings_command(hass: HomeAssistant, connection: Any, msg: dict[str, Any]) -> None:
    """Read settings for authenticated users, and allow only admin updates."""
    request_id = msg["id"]
    user = connection.user
    if user is None or (msg["action"] == "update" and not user.is_admin):
        connection.send_error(request_id, "unauthorized", "Для изменения настроек нужны права администратора")
        return
    manager = hass.data.get(DOMAIN, {}).get("settings")
    if manager is None:
        connection.send_error(request_id, "not_loaded", "Настройки учёта воды недоступны")
        return
    try:
        if msg["action"] == "get":
            snapshot = await manager.async_get()
        else:
            snapshot = await manager.async_update(msg.get("payload"), msg.get("revision"))
    except RevisionConflict as err:
        connection.send_error(request_id, "revision_conflict", str(err))
    except ValueError as err:
        connection.send_error(request_id, "invalid_settings", str(err))
    except OSError:
        connection.send_error(request_id, "storage_error", "Не удалось прочитать или сохранить настройки. Проверьте хранилище интеграции")
    else:
        connection.send_result(request_id, snapshot)


async def async_setup_settings(hass: HomeAssistant) -> None:
    """Register the endpoint even when settings need an explicit disk repair."""
    data = hass.data.setdefault(DOMAIN, {})
    if not data.get(_REGISTERED_KEY):
        websocket_api.async_register_command(hass, settings_command)
        data[_REGISTERED_KEY] = True
    # A websocket save may still be running when an entry is unloaded. Keep
    # one manager (and its lock) for the HA lifetime, including entry reloads.
    manager = data.get(_MANAGER_KEY)
    if manager is None:
        manager = SettingsManager(hass)
        data[_MANAGER_KEY] = manager
    data["settings"] = manager
    await manager.async_get()
