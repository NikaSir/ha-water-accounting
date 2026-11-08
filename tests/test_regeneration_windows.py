"""Behavioral regression tests for measured Moscow regeneration windows."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from test_settings import COMPONENT, FakeHass as SettingsHass, FakeStore, load_integration, load_settings

ENTITY = "sensor.test_water"
DAY = "2026-11-04"
NOW = datetime.fromisoformat("2026-11-08T16:00:00+03:00")


def stamp(value):
    return datetime.fromisoformat(value)


def state(value, clock="02:30:00", *, unit="m³", state_class="total", day=DAY, **attributes):
    return SimpleNamespace(
        entity_id=ENTITY, state=str(value), last_updated=stamp(f"{day}T{clock}+03:00"),
        attributes={"unit_of_measurement": unit, "state_class": state_class, **attributes},
    )


def run(*, start="2026-11-01T00:00:00+03:00", end=None, broken=False, run_id=7):
    return SimpleNamespace(run_id=run_id, start=stamp(start), end=stamp(end) if end else None,
                           closed_incorrect=broken)


class Column:
    def __le__(self, value):
        return lambda row: row.start <= value

    def desc(self):
        return self


class FakeRuns:
    start = Column()


class FakeQuery:
    def __init__(self, values):
        self.values = values

    def filter(self, predicate):
        self.values = [row for row in self.values if predicate(row)]
        return self

    def order_by(self, _column):
        self.values = sorted(self.values, key=lambda row: row.start, reverse=True)
        return self

    def first(self):
        return self.values[0] if self.values else None


class FakeRecorder:
    def __init__(self, hass):
        self.hass = hass
        self.recorder_runs_manager = SimpleNamespace(current=run(), active=True)
        self.enabled = True
        self.entity_filter = None
        self.flushes = 0

    async def async_block_till_done(self):
        self.flushes += 1

    async def async_add_executor_job(self, function, *args):
        return await asyncio.to_thread(function, *args)


class FakeHass(SettingsHass):
    def __init__(self, directory):
        super().__init__(directory)
        self.recorder = FakeRecorder(self)
        self.runs = [run()]
        self.history = {DAY: [state(40), state(40.4, "04:20:00")]}
        self.history_calls = []


class Connection:
    def __init__(self, *, authenticated=True, allowed=True, admin=False):
        self.user = SimpleNamespace(is_admin=admin, permissions=SimpleNamespace(
            check_entity=lambda entity_id, policy: allowed)) if authenticated else None
        self.results, self.errors = [], []

    def send_result(self, message_id, result):
        self.results.append((message_id, result))

    def send_error(self, message_id, code, message):
        self.errors.append((message_id, code, message))


def load_windows():
    names = (
        "homeassistant", "homeassistant.components", "homeassistant.core",
        "homeassistant.helpers", "homeassistant.helpers.storage",
        "homeassistant.components.websocket_api", "homeassistant.auth",
        "homeassistant.auth.permissions", "homeassistant.auth.permissions.const",
        "homeassistant.components.recorder", "homeassistant.components.recorder.history",
        "homeassistant.components.recorder.db_schema", "homeassistant.components.recorder.util",
        "voluptuous", "custom_components", "custom_components.water_accounting",
    )
    modules = {name: ModuleType(name) for name in names}
    modules["custom_components.water_accounting"].__path__ = [str(COMPONENT)]
    modules["homeassistant.helpers.storage"].Store = FakeStore
    modules["homeassistant.core"].HomeAssistant = FakeHass
    modules["homeassistant.auth.permissions.const"].POLICY_READ = "read"
    ws = modules["homeassistant.components.websocket_api"]
    ws.websocket_command = lambda schema: lambda function: function
    ws.async_response = lambda function: function
    ws.async_register_command = lambda hass, function: hass.commands.append(function)
    modules["homeassistant.components"].websocket_api = ws
    modules["voluptuous"].Required = lambda value: value
    recorder = modules["homeassistant.components.recorder"]
    recorder.get_instance = lambda hass: hass.recorder
    recorder.history = modules["homeassistant.components.recorder.history"]

    def get_history(hass, start_time, end_time, entity_ids, **options):
        hass.history_calls.append((start_time, end_time, entity_ids, options))
        requested_day = (start_time + timedelta(microseconds=1)).astimezone(
            NOW.tzinfo).date().isoformat()
        return {entity_ids[0]: deepcopy(hass.history.get(requested_day, []))}

    @contextmanager
    def session_scope(*, hass, read_only):
        assert read_only
        yield SimpleNamespace(query=lambda model: FakeQuery(hass.runs))

    recorder.history.get_significant_states = get_history
    modules["homeassistant.components.recorder.db_schema"].RecorderRuns = FakeRuns
    modules["homeassistant.components.recorder.util"].session_scope = session_scope
    spec = importlib.util.spec_from_file_location(
        "custom_components.water_accounting.regeneration_windows", COMPONENT / "regeneration_windows.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


class WindowTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_windows()

    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.hass = FakeHass(self.temporary.name)
        self.clock = patch.object(self.module, "moscow_now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        await self.module.async_setup_regeneration_windows(self.hass)
        self.manager = self.hass.data["water_accounting"]["regeneration_windows"]

    async def measurement(self, day=DAY, entity_id=ENTITY):
        return (await self.manager.async_get(entity_id, [day]))["measurements"][day]

    async def test_exact_moscow_window_uses_all_raw_states_and_stores_difference(self):
        result = await self.manager.async_get(ENTITY, [DAY])
        self.assertEqual(result["entity_id"], ENTITY)
        self.assertEqual(result["window"], {
            "start": "02:30", "end": "04:30", "timezone": "Europe/Moscow"})
        value = result["measurements"][DAY]
        self.assertEqual(value["status"], "measured")
        self.assertEqual(value["water_m3"], 0.4)
        self.assertEqual(value["start_meter_m3"], 40)
        self.assertEqual(value["end_meter_m3"], 40.4)
        self.assertEqual(value["start_time"], f"{DAY}T02:30:00+03:00")
        self.assertEqual(value["end_time"], f"{DAY}T04:30:00+03:00")
        self.assertEqual(value["source"], "recorder_history")
        query_start, query_end, entities, options = self.hass.history_calls[0]
        self.assertEqual(query_start, stamp(value["start_time"]) - timedelta(microseconds=1))
        self.assertEqual(query_end, stamp(value["end_time"]) + timedelta(microseconds=1))
        self.assertEqual(entities, [ENTITY])
        self.assertEqual(options, {"include_start_time_state": True,
                                  "significant_changes_only": False,
                                  "minimal_response": False, "no_attributes": False})
        self.assertEqual(self.hass.recorder.flushes, 1)
        self.assertTrue(self.manager.store.atomic_writes)

    async def test_boundary_updates_are_inclusive_and_outside_consumption_is_excluded(self):
        self.hass.history[DAY] = [state(30, "02:29:59.999999"), state(31),
                                 state(31.1, "03:00:00"), state(31.4, "04:30:00"),
                                 state(32, "04:30:00.000001")]
        value = await self.measurement()
        self.assertEqual(value["water_m3"], 0.4)
        self.assertEqual(value["start_meter_m3"], 31)
        self.assertEqual(value["end_meter_m3"], 31.4)

    async def test_litres_are_converted_and_large_real_volume_is_not_capped(self):
        self.hass.history[DAY] = [state(100000, unit="L"), state(112500, "04:15:00", unit="L")]
        self.assertEqual((await self.measurement())["water_m3"], 12.5)

    async def test_missing_start_or_history_is_unknown(self):
        for rows in ([], [state(40, "02:31:00"), state(40.4, "04:20:00")]):
            self.hass.history[DAY] = rows
            value = await self.measurement()
            self.assertEqual(value["status"], "unavailable")
            self.assertIsNone(value["water_m3"])
        self.assertFalse(Path(self.manager.store.path).exists())

    async def test_conflicting_equal_timestamp_boundary_states_are_not_arbitrarily_chosen(self):
        self.hass.history[DAY] = [state(40), state(40.1), state(40.4, "04:20:00")]
        self.assertEqual((await self.measurement())["status"], "unavailable")
        self.hass.history[DAY] = [state(40), state(40), state(40.4, "04:20:00")]
        self.assertEqual((await self.measurement())["water_m3"], 0.4)

    async def test_recorder_error_does_not_cache_or_invent_a_zero(self):
        with patch.object(self.hass.recorder, "async_block_till_done", side_effect=RuntimeError("unavailable")):
            with self.assertLogs(self.module.__name__, level="WARNING"):
                value = await self.measurement()
        self.assertEqual(value["reason"], "recorder_unavailable")
        self.assertIsNone(value["water_m3"])
        self.assertFalse(Path(self.manager.store.path).exists())
        self.assertEqual((await self.measurement())["status"], "measured")

    async def test_unknown_reset_bad_unit_and_noncumulative_sensor_never_measure(self):
        cases = [
            [state(40), state("unavailable", "03:00:00"), state(40.4, "04:20:00")],
            [state(40), state("unknown", "04:30:00")],
            [state(40), state(0.1, "03:00:00"), state(40.4, "04:20:00")],
            [state(40), state(40.4, "04:20:00", last_reset="2026-11-04T03:00:00+03:00")],
            [state(40, unit="L/min"), state(40.4, "04:20:00", unit="L/min")],
            [state(40, state_class="measurement"), state(40.4, "04:20:00")],
            [state("NaN"), state(40.4, "04:20:00")],
            [state(-1), state(40.4, "04:20:00")],
        ]
        for rows in cases:
            with self.subTest(rows=rows):
                self.hass.history[DAY] = rows
                value = await self.measurement()
                self.assertEqual(value["status"], "unavailable")
                self.assertIsNone(value["water_m3"])

    async def test_unfinished_window_is_retryable_without_recorder_query(self):
        with patch.object(self.module, "moscow_now", return_value=stamp(f"{DAY}T04:29:59+03:00")):
            value = await self.measurement()
        self.assertEqual(value["reason"], "window_incomplete")
        self.assertEqual(self.hass.history_calls, [])
        self.assertEqual((await self.measurement())["status"], "measured")

    async def test_recording_gaps_and_unclean_runs_cannot_turn_old_baseline_into_zero(self):
        self.hass.history[DAY] = [state(40, "02:29:59.999999")]
        for runs in ([], [run(end=f"{DAY}T02:20:00+03:00")],
                     [run(start=f"{DAY}T03:00:00+03:00")],
                     [run(end=f"{DAY}T03:00:00+03:00"), run(start=f"{DAY}T03:01:00+03:00")],
                     [run(broken=True, end="2026-11-07T00:00:00+03:00")],
                     [run(run_id=99)]):
            with self.subTest(runs=runs):
                self.hass.runs = runs
                value = await self.measurement()
                self.assertEqual(value["reason"], "history_coverage_unconfirmed")
                self.assertIsNone(value["water_m3"])
        self.assertEqual(self.hass.history_calls, [])

    async def test_valid_zero_in_covered_window_and_clean_historical_run(self):
        self.hass.history[DAY] = [state(40, "02:29:59.999999")]
        self.hass.runs = [run(end="2026-11-05T00:00:00+03:00", run_id=3)]
        value = await self.measurement()
        self.assertEqual(value["status"], "measured")
        self.assertEqual(value["water_m3"], 0)

    async def test_disabled_recording_or_excluded_meter_never_cache_a_stale_zero(self):
        self.hass.history[DAY] = [state(40, "02:29:59.999999")]
        self.hass.recorder.enabled = False
        value = await self.measurement()
        self.assertEqual(value["reason"], "recording_disabled")
        self.assertIsNone(value["water_m3"])
        self.hass.recorder.enabled = True
        self.hass.recorder.entity_filter = lambda entity_id: entity_id != ENTITY
        value = await self.measurement()
        self.assertEqual(value["reason"], "entity_not_recorded")
        self.assertIsNone(value["water_m3"])
        self.assertEqual(self.hass.history_calls, [])
        self.assertFalse(Path(self.manager.store.path).exists())

    async def test_durable_cache_survives_purge_restart_and_is_entity_scoped(self):
        first = await self.measurement()
        self.hass.history.clear()
        self.hass.runs.clear()
        restarted = FakeHass(self.temporary.name)
        restarted.history.clear()
        restarted.runs.clear()
        await self.module.async_setup_regeneration_windows(restarted)
        manager = restarted.data["water_accounting"]["regeneration_windows"]
        cached = (await manager.async_get(ENTITY, [DAY]))["measurements"][DAY]
        self.assertEqual(cached["water_m3"], first["water_m3"])
        self.assertTrue(cached["cached"])
        self.assertEqual(restarted.history_calls, [])
        different = (await manager.async_get("sensor.other_water", [DAY]))["measurements"][DAY]
        self.assertEqual(different["status"], "unavailable")

    async def test_missing_measurement_retries_and_duplicate_dates_count_once(self):
        self.hass.history.clear()
        self.assertEqual((await self.measurement())["status"], "unavailable")
        self.hass.history[DAY] = [state(40), state(40.4, "04:20:00")]
        result = await self.manager.async_get(ENTITY, [DAY, DAY])
        self.assertEqual(list(result["measurements"]), [DAY])
        self.assertEqual(result["measurements"][DAY]["water_m3"], 0.4)
        self.assertEqual(len(self.hass.history_calls), 2)

    async def test_invalid_requests_reject_before_database_or_storage_mutation(self):
        for entity, dates in (("light.test", [DAY]), ("sensor.bad|key", [DAY]),
                              (ENTITY, ["20261104"]), (ENTITY, ["2014-12-31"]),
                              (ENTITY, ["2026-11-09"]), (ENTITY, [DAY] * 367),
                              (ENTITY, DAY), (ENTITY, [None])):
            with self.subTest(entity=entity, dates=dates):
                with self.assertRaises(ValueError):
                    await self.manager.async_get(entity, dates)
        self.assertEqual(self.hass.history_calls, [])
        self.assertFalse(Path(self.manager.store.path).exists())

    async def test_authentication_and_entity_read_permission_also_protect_cached_values(self):
        await self.measurement()
        request = {"id": 1, "entity_id": ENTITY, "dates": [DAY]}
        for connection in (Connection(authenticated=False), Connection(allowed=False)):
            await self.module.regeneration_windows_command(self.hass, connection, request)
            self.assertEqual(connection.errors[-1][1], "unauthorized")
            self.assertEqual(connection.results, [])
        reader = Connection()
        await self.module.regeneration_windows_command(self.hass, reader, request)
        self.assertEqual(reader.results[0][1]["measurements"][DAY]["status"], "measured")

    async def test_storage_failure_corruption_and_missing_saved_file_do_not_claim_success(self):
        self.manager.store.fail_silently = True
        with self.assertRaises(OSError):
            await self.measurement()
        self.manager.store.fail_silently = False
        await self.measurement()
        path = Path(self.manager.store.path)
        data = path.read_text()
        for bad in ("broken", data.replace('"water_m3": 0.4', '"water_m3": 9')):
            path.write_text(bad)
            with self.assertRaises(OSError):
                await self.measurement()
        path.unlink()
        with self.assertRaises(OSError):
            await self.measurement()

    async def test_reload_and_concurrent_reads_keep_single_manager_and_cached_measurement(self):
        manager = self.manager
        values = await asyncio.gather(self.measurement(), self.measurement())
        await self.module.async_setup_regeneration_windows(self.hass)
        self.assertIs(self.hass.data["water_accounting"]["regeneration_windows"], manager)
        self.assertEqual(len(self.hass.commands), 1)
        self.assertEqual(len(self.hass.history_calls), 1)
        self.assertTrue(values[1]["cached"])

    async def test_endpoint_reports_not_loaded_and_storage_error(self):
        connection = Connection()
        message = {"id": 1, "entity_id": ENTITY, "dates": [DAY]}
        Path(self.manager.store.path).write_text("bad")
        await self.module.regeneration_windows_command(self.hass, connection, message)
        self.assertEqual(connection.errors[-1][1], "storage_error")
        self.hass.data["water_accounting"].pop("regeneration_windows")
        await self.module.regeneration_windows_command(self.hass, connection, message)
        self.assertEqual(connection.errors[-1][1], "not_loaded")

    async def test_actual_unload_reload_keeps_cache_lock_and_storage_error_endpoint(self):
        settings = load_settings()
        integration = load_integration(settings, self.module)
        with patch.object(settings, "moscow_today", return_value=NOW.date()):
            self.assertTrue(await integration.async_setup_entry(self.hass, None))
            await self.measurement()
            self.assertTrue(await integration.async_unload_entry(self.hass, None))
            connection = Connection()
            message = {"id": 1, "entity_id": ENTITY, "dates": [DAY]}
            await self.module.regeneration_windows_command(self.hass, connection, message)
            self.assertEqual(connection.errors[-1][1], "not_loaded")
            self.assertTrue(await integration.async_setup_entry(self.hass, None))
            self.assertIs(self.hass.data["water_accounting"]["regeneration_windows"], self.manager)
            self.assertTrue((await self.measurement())["cached"])
            self.assertEqual(len(self.hass.commands), 2)
            self.assertTrue(await integration.async_unload_entry(self.hass, None))
            Path(self.manager.store.path).write_text("bad")
            with self.assertLogs("custom_components.water_accounting", level="ERROR"):
                self.assertTrue(await integration.async_setup_entry(self.hass, None))
            self.assertTrue(self.hass.panel_registered)
            await self.module.regeneration_windows_command(self.hass, connection, message)
            self.assertEqual(connection.errors[-1][1], "storage_error")


if __name__ == "__main__":
    unittest.main()
