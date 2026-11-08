"""Measured regeneration volumes from a fixed Moscow Recorder window.

Cycle dates come from Water Treatment in the caller; this endpoint never infers
cycles or changes that journal. Counter states are step values at the requested
boundaries, not interpolated samples. Confirmed results survive Recorder purge.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
import json
import logging
import math
from pathlib import Path
import re
from typing import Any
from zoneinfo import ZoneInfo

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.components.recorder import get_instance, history
from homeassistant.components.recorder.db_schema import RecorderRuns
from homeassistant.components.recorder.util import session_scope
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)
_MOSCOW = ZoneInfo("Europe/Moscow")
_WINDOW = {"start": "02:30", "end": "04:30", "timezone": "Europe/Moscow"}
_STORAGE_KEY = "water_accounting.regeneration_windows"
_STORAGE_VERSION = 1
_REGISTERED_KEY = "regeneration_windows_command_registered"
_MANAGER_KEY = "regeneration_windows_manager"
_FIRST_SUPPORTED_DATE = date(2015, 1, 1)
_MAX_DATES = 366
_ENTITY_PATTERN = re.compile(r"sensor\.[a-z0-9_]+\Z")
_FACTORS = {"m³": Decimal(1), "m3": Decimal(1), "L": Decimal("0.001"), "l": Decimal("0.001")}
_RECORD_FIELDS = {
    "date", "status", "water_m3", "start_meter_m3", "end_meter_m3", "start_time",
    "end_time", "source", "boundary_method",
}


def moscow_now() -> datetime:
    """Return the current time in the installation's accounting timezone."""
    return datetime.now(_MOSCOW)


def window_bounds(day: str) -> tuple[datetime, datetime]:
    """Return exact bounds of the user's fixed regeneration accounting window."""
    parsed = date.fromisoformat(day)
    return (datetime.combine(parsed, time(2, 30), _MOSCOW),
            datetime.combine(parsed, time(4, 30), _MOSCOW))


def _validate_request(entity_id: Any, dates: Any) -> list[str]:
    if not isinstance(entity_id, str) or len(entity_id) > 255 or not _ENTITY_PATTERN.fullmatch(entity_id):
        raise ValueError("Укажите entity_id накопительного счётчика воды из домена sensor")
    if not isinstance(dates, list) or len(dates) > _MAX_DATES:
        raise ValueError(f"Передайте список не более {_MAX_DATES} дат циклов")
    today = moscow_now().date()
    for value in dates:
        try:
            parsed = date.fromisoformat(value)
            if parsed.isoformat() != value or not _FIRST_SUPPORTED_DATE <= parsed <= today:
                raise ValueError
        except (TypeError, ValueError) as err:
            raise ValueError("Даты циклов должны быть в формате ГГГГ-ММ-ДД, с 2015-01-01 по сегодня (Москва)") from err
    return list(dict.fromkeys(dates))


def _cache_key(entity_id: str, day: str) -> str:
    return f"{entity_id}|{day}|Europe/Moscow|02:30|04:30"


def _base_measurement(day: str) -> dict[str, Any]:
    start, end = window_bounds(day)
    return {"date": day, "status": "unavailable", "water_m3": None,
            "start_meter_m3": None, "end_meter_m3": None,
            "start_time": start.isoformat(), "end_time": end.isoformat(),
            "source": "recorder_history", "boundary_method": "last_recorded_state"}


def _unavailable(day: str, reason: str) -> dict[str, Any]:
    return {**_base_measurement(day), "reason": reason, "cached": False}


def _as_utc(value: datetime) -> datetime:
    # RecorderRuns datetimes from some SQL backends are naive UTC.
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _run_covers_window(run: Any, start: datetime, end: datetime, recorder: Any) -> bool:
    """Do not extend a synthetic old baseline across a known Recorder outage.

    An incorrectly closed run has a reconstructed end time (next startup), not
    evidence of continuous recording. Such coverage remains unconfirmed. Run
    bounds cannot attest past disable/re-enable operations within a single run.
    """
    if run is None or run.closed_incorrect or _as_utc(run.start) > start:
        return False
    if run.end is not None:
        return _as_utc(run.end) >= end
    manager = recorder.recorder_runs_manager
    return manager.active and run.run_id == manager.current.run_id


def _reading(row: Any) -> tuple[Decimal, Any]:
    attributes = row.attributes
    if attributes.get("state_class") not in ("total", "total_increasing"):
        raise ValueError("unsupported_state_class")
    factor = _FACTORS.get(attributes.get("unit_of_measurement"))
    if factor is None:
        raise ValueError("unsupported_unit")
    try:
        value = Decimal(row.state) * factor
        if not value.is_finite() or value < 0 or not math.isfinite(float(value)):
            raise ValueError("invalid_state")
    except (InvalidOperation, TypeError, OverflowError) as err:
        raise ValueError("invalid_state") from err
    return value, attributes.get("last_reset")


def _measure_states(entity_id: str, day: str, rows: list[Any]) -> dict[str, Any]:
    start, end = window_bounds(day)
    if not rows:
        return _unavailable(day, "history_missing")
    samples: list[tuple[datetime, Any]] = []
    try:
        for row in rows:
            stamp = row.last_updated
            if row.entity_id != entity_id or not isinstance(stamp, datetime) or stamp.tzinfo is None:
                raise ValueError("invalid_state")
            if stamp <= end:
                samples.append((stamp, row))
        samples.sort(key=lambda item: item[0])
        baseline = next((item for item in reversed(samples) if item[0] <= start), None)
        if baseline is None:
            return _unavailable(day, "boundary_missing")
        # State changes exactly at 02:30 are part of the start reading. States
        # strictly before it must not add consumption to this window.
        relevant = [item for item in samples if item[0] >= start]
        if baseline[0] < start:
            relevant.insert(0, baseline)
        # Retain all exact-boundary updates: conflicting values at the same
        # timestamp have no reliable order and must not choose a start reading.
        first, last_reset = _reading(relevant[0][1])
        previous = first
        previous_time = baseline[0]
        for stamp, row in relevant[1:]:
            current, reset = _reading(row)
            if reset != last_reset or current < previous:
                return _unavailable(day, "meter_reset")
            if stamp == previous_time and current != previous:
                return _unavailable(day, "invalid_state")
            previous, previous_time = current, stamp
        value = _base_measurement(day)
        value.update(status="measured", water_m3=float(previous - first),
                     start_meter_m3=float(first), end_meter_m3=float(previous))
        return value
    except (AttributeError, TypeError, ValueError) as err:
        reason = str(err) if str(err) in {"invalid_state", "unsupported_state_class", "unsupported_unit"} else "invalid_state"
        return _unavailable(day, reason)


def _query_window(hass: HomeAssistant, entity_id: str, day: str) -> dict[str, Any]:
    """Run all Recorder work in its database executor, with no disk mutations."""
    start, end = (value.astimezone(timezone.utc) for value in window_bounds(day))
    recorder = get_instance(hass)
    # Recorder.disable does not close its run. Also honour the entity filter;
    # neither condition may turn an old retained baseline into a cached zero.
    if not recorder.enabled:
        return _unavailable(day, "recording_disabled")
    if recorder.entity_filter is not None and not recorder.entity_filter(entity_id):
        return _unavailable(day, "entity_not_recorded")
    with session_scope(hass=hass, read_only=True) as session:
        run = (session.query(RecorderRuns).filter(RecorderRuns.start <= start)
               .order_by(RecorderRuns.start.desc()).first())
        if not _run_covers_window(run, start, end, recorder):
            return _unavailable(day, "history_coverage_unconfirmed")
    # The core query uses strict > start and < end; include both exact bounds.
    raw = history.get_significant_states(
        hass, start - timedelta(microseconds=1), end + timedelta(microseconds=1),
        [entity_id], include_start_time_state=True, significant_changes_only=False,
        minimal_response=False, no_attributes=False,
    )
    return _measure_states(entity_id, day, raw.get(entity_id, []))


def _finite_nonnegative(value: Any) -> bool:
    try:
        return type(value) in (int, float) and value >= 0 and math.isfinite(value)
    except OverflowError:
        return False


def _validate_cache(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"measurements"} or not isinstance(value["measurements"], dict):
        raise ValueError("Неверная структура измерений")
    for key, record in value["measurements"].items():
        parts = key.split("|")
        if len(parts) != 5:
            raise ValueError("Неверный ключ измерения")
        entity_id, day = parts[:2]
        if not _ENTITY_PATTERN.fullmatch(entity_id) or key != _cache_key(entity_id, day):
            raise ValueError("Неверный ключ измерения")
        if not isinstance(record, dict) or set(record) != _RECORD_FIELDS:
            raise ValueError("Неверная структура измерения")
        expected = _base_measurement(day)
        if date.fromisoformat(day).isoformat() != day or record["status"] != "measured":
            raise ValueError("Неподтверждённое измерение")
        for field in ("date", "start_time", "end_time", "source", "boundary_method"):
            if record[field] != expected[field]:
                raise ValueError("Измерение относится к другому окну")
        if not all(_finite_nonnegative(record[field]) for field in ("water_m3", "start_meter_m3", "end_meter_m3")):
            raise ValueError("Неверные показания")
        difference = record["end_meter_m3"] - record["start_meter_m3"]
        if difference < 0 or not math.isclose(difference, record["water_m3"], abs_tol=1e-9, rel_tol=1e-9):
            raise ValueError("Объём не совпадает с показаниями")
    return value


def _read_cache_file(filename: str) -> dict[str, Any] | None:
    path = Path(filename)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        if any(path.parent.glob(path.name + ".corrupt.*")):
            raise OSError("Обнаружена повреждённая копия измерений; требуется восстановление")
        return None
    try:
        envelope = json.loads(text)
        if (not isinstance(envelope, dict) or type(envelope.get("version")) is not int
                or envelope["version"] != _STORAGE_VERSION
                or type(envelope.get("minor_version")) is not int or envelope["minor_version"] != 1
                or envelope.get("key") != _STORAGE_KEY):
            raise ValueError("Неподдерживаемый формат измерений")
        return _validate_cache(envelope.get("data"))
    except (AttributeError, TypeError, ValueError) as err:
        raise OSError("Хранилище измерений повреждено; требуется восстановление") from err


class RegenerationWindowStore(Store):
    """Keep immutable confirmed window results, with durable write verification."""

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(hass, _STORAGE_VERSION, _STORAGE_KEY, atomic_writes=True)
        self._windows_hass = hass

    async def async_load(self) -> dict[str, Any] | None:
        try:
            return await self._windows_hass.async_add_executor_job(_read_cache_file, self.path)
        except UnicodeError as err:
            raise OSError("Хранилище измерений имеет неверную кодировку") from err

    async def async_save(self, value: dict[str, Any]) -> None:
        _validate_cache(value)
        await super().async_save(value)
        if await self.async_load() != value:
            raise OSError("Не удалось подтвердить сохранение измерений на диске")


class RegenerationWindowManager:
    """Serialize measurement/cache requests across panel refreshes and reloads."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store = RegenerationWindowStore(hass)
        self._lock = asyncio.Lock()
        self._seen_saved = False

    async def _read(self) -> dict[str, Any]:
        snapshot = await self.store.async_load()
        if snapshot is None:
            if self._seen_saved:
                raise OSError("Хранилище ранее сохранённых измерений отсутствует")
            return {"measurements": {}}
        self._seen_saved = True
        return snapshot

    async def async_get(self, entity_id: str, dates: list[str]) -> dict[str, Any]:
        dates = _validate_request(entity_id, dates)
        async with self._lock:
            snapshot = await self._read()
            cached = snapshot["measurements"]
            measurements: dict[str, dict[str, Any]] = {}
            pending: list[str] = []
            for day in dates:
                if moscow_now() < window_bounds(day)[1]:
                    measurements[day] = _unavailable(day, "window_incomplete")
                elif (record := cached.get(_cache_key(entity_id, day))) is not None:
                    measurements[day] = {**deepcopy(record), "cached": True}
                else:
                    pending.append(day)
            recorder = None
            if pending:
                try:
                    recorder = get_instance(self.hass)
                    await asyncio.wait_for(recorder.async_block_till_done(), timeout=10)
                except Exception as err:
                    # Availability errors must not become an invented zero.
                    _LOGGER.warning("Regeneration Recorder is unavailable (%s)", type(err).__name__)
                    recorder = None
            changed = False
            for day in pending:
                record = _unavailable(day, "recorder_unavailable")
                if recorder is not None:
                    try:
                        record = await recorder.async_add_executor_job(_query_window, self.hass, entity_id, day)
                    except Exception as err:
                        _LOGGER.warning("Cannot read regeneration window %s (%s)", day, type(err).__name__)
                measurements[day] = {**record, "cached": False}
                if record["status"] == "measured":
                    cached[_cache_key(entity_id, day)] = record
                    changed = True
            if changed:
                await self.store.async_save(snapshot)
                self._seen_saved = True
            return {"entity_id": entity_id, "window": dict(_WINDOW), "measurements": measurements}


@websocket_api.websocket_command({
    vol.Required("type"): "water_accounting/regeneration_windows",
    vol.Required("entity_id"): str,
    vol.Required("dates"): list,
})
@websocket_api.async_response
async def regeneration_windows_command(hass: HomeAssistant, connection: Any, msg: dict[str, Any]) -> None:
    """Read only the water meter history the authenticated caller may access."""
    request_id = msg["id"]
    user = connection.user
    if user is None:
        connection.send_error(request_id, "unauthorized", "Требуется вход в Home Assistant")
        return
    try:
        dates = _validate_request(msg.get("entity_id"), msg.get("dates"))
    except ValueError as err:
        connection.send_error(request_id, "invalid_request", str(err))
        return
    entity_id = msg["entity_id"]
    if not user.is_admin and not user.permissions.check_entity(entity_id, POLICY_READ):
        connection.send_error(request_id, "unauthorized", "Нет доступа к истории этого счётчика")
        return
    manager = hass.data.get(DOMAIN, {}).get("regeneration_windows")
    if manager is None:
        connection.send_error(request_id, "not_loaded", "Измерения регенераций недоступны")
        return
    try:
        result = await manager.async_get(entity_id, dates)
    except OSError:
        connection.send_error(request_id, "storage_error", "Не удалось прочитать или сохранить измерения регенераций. Проверьте хранилище интеграции")
    except ValueError as err:
        connection.send_error(request_id, "invalid_request", str(err))
    else:
        connection.send_result(request_id, result)


async def async_setup_regeneration_windows(hass: HomeAssistant) -> None:
    """Register once and retain one manager/lock for the lifetime of HA."""
    data = hass.data.setdefault(DOMAIN, {})
    if not data.get(_REGISTERED_KEY):
        websocket_api.async_register_command(hass, regeneration_windows_command)
        data[_REGISTERED_KEY] = True
    manager = data.get(_MANAGER_KEY)
    if manager is None:
        manager = RegenerationWindowManager(hass)
        data[_MANAGER_KEY] = manager
    data["regeneration_windows"] = manager
    async with manager._lock:
        await manager._read()
