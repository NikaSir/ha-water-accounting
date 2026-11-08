"""Behavioral tests for durable, versioned water accounting settings."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import date
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "custom_components" / "water_accounting"


class FakeHass:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.data = {}
        self.commands = []

    async def async_add_executor_job(self, function, *args):
        return await asyncio.to_thread(function, *args)


class FakeStore:
    """Exercise actual files while substituting only HA's storage transport."""
    def __init__(self, hass, version, key, *, atomic_writes=False, **kwargs):
        self.path = str(hass.directory / key)
        self.version = version
        self.key = key
        self.atomic_writes = atomic_writes
        self.fail_silently = False

    async def async_save(self, value):
        if self.fail_silently:
            return
        path = Path(self.path)
        wrapper = {"version": self.version, "minor_version": 1,
                   "key": self.key, "data": deepcopy(value)}
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False,
                                         encoding="utf-8") as handle:
            temporary = handle.name
            json.dump(wrapper, handle, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)


class Connection:
    def __init__(self, admin=False, authenticated=True):
        self.user = SimpleNamespace(is_admin=admin) if authenticated else None
        self.results = []
        self.errors = []

    def send_result(self, message_id, result):
        self.results.append((message_id, result))

    def send_error(self, message_id, code, message):
        self.errors.append((message_id, code, message))


def load_settings():
    modules = {}
    for name in ("homeassistant", "homeassistant.components", "homeassistant.helpers",
                 "homeassistant.core", "homeassistant.helpers.storage",
                 "homeassistant.components.websocket_api", "voluptuous",
                 "custom_components", "custom_components.water_accounting"):
        modules[name] = ModuleType(name)
    modules["custom_components.water_accounting"].__path__ = [str(COMPONENT)]
    modules["homeassistant.helpers.storage"].Store = FakeStore
    modules["homeassistant.core"].HomeAssistant = FakeHass
    ws = modules["homeassistant.components.websocket_api"]
    ws.websocket_command = lambda schema: lambda function: function
    ws.async_response = lambda function: function
    ws.async_register_command = lambda hass, function: hass.commands.append(function)
    modules["homeassistant.components"].websocket_api = ws
    vol = modules["voluptuous"]
    vol.Required = lambda value, **kwargs: value
    vol.Optional = lambda value, **kwargs: value
    vol.In = lambda value: value
    spec = importlib.util.spec_from_file_location(
        "custom_components.water_accounting.settings", COMPONENT / "settings.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


def load_integration(settings):
    """Load real entry points while substituting only HA and panel plumbing."""
    modules = {
        name: ModuleType(name)
        for name in ("homeassistant", "homeassistant.core", "homeassistant.config_entries",
                     "custom_components", "custom_components.water_accounting.panel")
    }
    modules["homeassistant.core"].HomeAssistant = FakeHass
    modules["homeassistant.config_entries"].ConfigEntry = SimpleNamespace
    modules["custom_components.water_accounting.settings"] = settings
    panel = modules["custom_components.water_accounting.panel"]

    async def register(hass):
        hass.panel_registered = True

    def unregister(hass):
        hass.panel_registered = False

    panel.async_register_panel = register
    panel.async_unregister_panel = unregister
    spec = importlib.util.spec_from_file_location(
        "custom_components.water_accounting", COMPONENT / "__init__.py",
        submodule_search_locations=[str(COMPONENT)])
    module = importlib.util.module_from_spec(spec)
    modules[spec.name] = module
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


class SettingsTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_settings()

    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.hass = FakeHass(self.temporary.name)
        self.clock = patch.object(self.module, "moscow_today", return_value=date(2026, 11, 8))
        self.clock.start()
        self.addCleanup(self.clock.stop)
        await self.module.async_setup_settings(self.hass)
        self.manager = self.hass.data["water_accounting"]["settings"]
        self.initial = await self.manager.async_get()

    async def test_initial_contract_and_copy_isolation(self):
        self.assertEqual(self.initial, {
            "revision": 0,
            "settings": {
                "statistics_start_date": "2026-10-27",
                "low_day_threshold_l": 100,
                "regeneration_verified_from": None,
                "regeneration_verified_through": None,
                "irrigation": {"enabled": True, "reason": "", "since": None},
            },
        })
        self.initial["settings"]["irrigation"]["enabled"] = False
        self.assertTrue((await self.manager.async_get())["settings"]["irrigation"]["enabled"])
        self.assertTrue(self.manager.store.atomic_writes)

    async def test_save_reload_and_revision(self):
        settings = deepcopy(self.initial["settings"])
        settings["irrigation"] = {"enabled": False, "reason": "На зиму", "since": "2026-11-01"}
        settings["regeneration_verified_from"] = "2026-10-27"
        settings["regeneration_verified_through"] = "2026-11-07"
        saved = await self.manager.async_update(settings, 0)
        self.assertEqual(saved, {"revision": 1, "settings": settings})
        await self.module.async_setup_settings(self.hass)
        manager = self.hass.data["water_accounting"]["settings"]
        self.assertEqual(await manager.async_get(), saved)
        self.assertEqual(len(self.hass.commands), 1)

    async def test_stale_revision_reads_latest_disk(self):
        settings = deepcopy(self.initial["settings"])
        settings["low_day_threshold_l"] = 250
        external = {"revision": 4, "settings": settings}
        await self.manager.store.async_save(external)
        with self.assertRaises(self.module.RevisionConflict):
            await self.manager.async_update(self.initial["settings"], 0)
        self.assertEqual(await self.manager.async_get(), external)

    async def test_concurrent_updates_only_one_succeeds(self):
        outcomes = await asyncio.gather(
            self.manager.async_update(self.initial["settings"], 0),
            self.manager.async_update(self.initial["settings"], 0),
            return_exceptions=True,
        )
        self.assertEqual(sum(isinstance(value, dict) for value in outcomes), 1)
        self.assertEqual(sum(isinstance(value, self.module.RevisionConflict) for value in outcomes), 1)
        self.assertEqual((await self.manager.async_get())["revision"], 1)

    async def test_reload_during_update_does_not_lose_another_write(self):
        integration = load_integration(self.module)
        first = deepcopy(self.initial["settings"])
        first["low_day_threshold_l"] = 111
        second = deepcopy(self.initial["settings"])
        second["low_day_threshold_l"] = 222
        first_connection, second_connection = Connection(admin=True), Connection(admin=True)
        saving, release, reloading, second_entered = (
            asyncio.Event() for _ in range(4)
        )
        original_save = self.manager.store.async_save
        original_get = self.module.SettingsManager.async_get

        async def paused_save(snapshot):
            saving.set()
            await release.wait()
            await original_save(snapshot)

        async def observed_get(manager):
            reloading.set()
            return await original_get(manager)

        async def inline_executor(function, *args):
            # Actual files, deterministic ordering: only the manager lock and
            # paused save may yield, never background executor scheduling.
            return function(*args)

        async def second_request():
            second_entered.set()
            await self.module.settings_command(self.hass, second_connection, {
                "id": 2, "action": "update", "payload": second, "revision": 0})

        tasks = []
        with patch.object(self.hass, "async_add_executor_job", inline_executor), \
                patch.object(self.manager.store, "async_save", paused_save), \
                patch.object(self.module.SettingsManager, "async_get", observed_get):
            try:
                tasks.append(asyncio.create_task(self.module.settings_command(
                    self.hass, first_connection, {
                        "id": 1, "action": "update", "payload": first, "revision": 0})))
                await asyncio.wait_for(saving.wait(), 1)
                self.assertTrue(await integration.async_unload_entry(self.hass, None))
                unloaded = Connection(admin=True)
                await self.module.settings_command(self.hass, unloaded, {"id": 3, "action": "get"})
                self.assertEqual(unloaded.errors[-1][1], "not_loaded")
                tasks.append(asyncio.create_task(integration.async_setup_entry(self.hass, None)))
                await asyncio.wait_for(reloading.wait(), 1)
                tasks.append(asyncio.create_task(second_request()))
                await asyncio.wait_for(second_entered.wait(), 1)
            finally:
                release.set()
                await asyncio.wait_for(asyncio.gather(*tasks), 1)

        self.assertEqual(first_connection.results, [(1, {"revision": 1, "settings": first})])
        self.assertEqual(first_connection.errors, [])
        self.assertEqual(second_connection.results, [])
        self.assertEqual(second_connection.errors[-1][1], "revision_conflict")
        current = self.hass.data["water_accounting"]["settings"]
        self.assertEqual(await current.async_get(), {"revision": 1, "settings": first})
        self.assertTrue(self.hass.panel_registered)
        self.assertEqual(len(self.hass.commands), 1)

    async def test_reload_with_corrupt_storage_keeps_panel_and_error_endpoint(self):
        integration = load_integration(self.module)
        Path(self.manager.store.path).write_text("broken", encoding="utf-8")
        self.assertTrue(await integration.async_unload_entry(self.hass, None))
        with self.assertLogs("custom_components.water_accounting", level="ERROR"):
            self.assertTrue(await integration.async_setup_entry(self.hass, None))
        self.assertTrue(self.hass.panel_registered)
        reader = Connection()
        await self.module.settings_command(self.hass, reader, {"id": 1, "action": "get"})
        self.assertEqual(reader.results, [])
        self.assertEqual(reader.errors[-1][1], "storage_error")

    async def test_invalid_settings_never_write(self):
        invalid = []
        for value in (True, False, -1, 10001, 10**1000, float("nan"), float("inf"), "100", None):
            item = deepcopy(self.initial["settings"])
            item["low_day_threshold_l"] = value
            invalid.append(item)
        for value in ("2014-12-31", "2026-11-09", "2026-02-30", "20261108", None, True):
            item = deepcopy(self.initial["settings"])
            item["statistics_start_date"] = value
            invalid.append(item)
        for field in self.initial["settings"]:
            item = deepcopy(self.initial["settings"])
            del item[field]
            invalid.append(item)
        item = deepcopy(self.initial["settings"])
        item["surprise"] = 1
        invalid.append(item)
        for irrigation in (
            {}, {"enabled": 1, "reason": "", "since": None},
            {"enabled": False, "reason": "  ", "since": "2026-11-08"},
            {"enabled": False, "reason": "Зима", "since": None},
            {"enabled": True, "reason": "x" * 501, "since": None},
            {"enabled": True, "reason": None, "since": None},
            {"enabled": True, "reason": "", "since": "2014-12-31"},
            {"enabled": True, "reason": "", "since": "2026-11-09"},
            {"enabled": True, "reason": "", "since": None, "unexpected": 1},
        ):
            item = deepcopy(self.initial["settings"])
            item["irrigation"] = irrigation
            invalid.append(item)
        for begin, end in ((None, "2026-11-08"), ("2026-10-27", None),
                           ("2026-11-08", "2026-11-07"),
                           ("2014-12-31", "2026-11-08"),
                           ("2026-11-08", "2026-11-09")):
            item = deepcopy(self.initial["settings"])
            item["regeneration_verified_from"] = begin
            item["regeneration_verified_through"] = end
            invalid.append(item)
        for settings in invalid:
            with self.subTest(settings=settings):
                with self.assertRaises(ValueError):
                    await self.manager.async_update(settings, 0)
        self.assertFalse(Path(self.manager.store.path).exists())
        self.assertEqual(await self.manager.async_get(), self.initial)

    async def test_revision_is_strict_nonnegative_integer(self):
        for revision in (None, True, False, -1, 0.0, "0"):
            with self.subTest(revision=revision):
                with self.assertRaises(ValueError):
                    await self.manager.async_update(self.initial["settings"], revision)
        self.assertFalse(Path(self.manager.store.path).exists())

    async def test_supported_boundaries_are_inclusive(self):
        for threshold in (0, 10000, 100.5):
            current = await self.manager.async_get()
            settings = current["settings"]
            settings["low_day_threshold_l"] = threshold
            settings["statistics_start_date"] = "2015-01-01"
            settings["regeneration_verified_from"] = "2015-01-01"
            settings["regeneration_verified_through"] = "2026-11-08"
            settings["irrigation"] = {"enabled": False, "reason": "Maintenance", "since": "2026-11-08"}
            saved = await self.manager.async_update(settings, current["revision"])
            self.assertEqual(saved["settings"], settings)

    async def test_silent_storage_failure_is_not_success(self):
        self.manager.store.fail_silently = True
        with self.assertRaises(OSError):
            await self.manager.async_update(self.initial["settings"], 0)
        self.assertEqual(await self.manager.async_get(), self.initial)

    async def test_failed_write_preserves_existing_version(self):
        saved = await self.manager.async_update(self.initial["settings"], 0)
        self.manager.store.fail_silently = True
        settings = deepcopy(saved["settings"])
        settings["low_day_threshold_l"] = 450
        with self.assertRaises(OSError):
            await self.manager.async_update(settings, 1)
        self.assertEqual(await self.manager.async_get(), saved)

    async def test_corrupt_storage_never_recovers_as_default(self):
        path = Path(self.manager.store.path)
        path.write_text("{invalid", encoding="utf-8")
        with self.assertRaises(OSError):
            await self.manager.async_get()
        with self.assertRaises(OSError):
            await self.manager.async_update(self.initial["settings"], 0)
        self.assertEqual(path.read_text(), "{invalid")

    async def test_invalid_storage_envelopes_fail_closed(self):
        valid = {"version": 1, "minor_version": 1, "key": self.manager.store.key,
                 "data": deepcopy(self.initial)}
        variants = [None, {}, {**valid, "version": True}, {**valid, "version": 2},
                    {**valid, "minor_version": 2}, {**valid, "key": "different"},
                    {**valid, "data": {"revision": True, "settings": self.initial["settings"]}}]
        for wrapper in variants:
            with self.subTest(wrapper=wrapper):
                Path(self.manager.store.path).write_text(json.dumps(wrapper), encoding="utf-8")
                with self.assertRaises(OSError):
                    await self.manager.async_get()

    async def test_missing_previously_saved_file_fails_closed(self):
        await self.manager.async_update(self.initial["settings"], 0)
        Path(self.manager.store.path).unlink()
        with self.assertRaises(OSError):
            await self.manager.async_get()

    async def test_corrupt_backup_blocks_default_reset_after_restart(self):
        Path(self.manager.store.path + ".corrupt.2026-11-08").write_text("bad")
        with self.assertRaises(OSError):
            await self.module.async_setup_settings(self.hass)

    async def test_websocket_authenticated_get_and_admin_only_update(self):
        reader = Connection()
        await self.module.settings_command(self.hass, reader, {"id": 1, "action": "get"})
        self.assertEqual(reader.results, [(1, self.initial)])
        await self.module.settings_command(self.hass, reader, {
            "id": 2, "action": "update", "payload": self.initial["settings"], "revision": 0})
        self.assertEqual(reader.errors[-1][1], "unauthorized")
        self.assertFalse(Path(self.manager.store.path).exists())
        admin = Connection(admin=True)
        await self.module.settings_command(self.hass, admin, {
            "id": 3, "action": "update", "payload": self.initial["settings"], "revision": 0})
        self.assertEqual(admin.results[0][1]["revision"], 1)
        await self.module.settings_command(self.hass, admin, {
            "id": 4, "action": "update", "payload": self.initial["settings"], "revision": 0})
        self.assertEqual(admin.errors[-1][1], "revision_conflict")

    async def test_websocket_unauthenticated_unloaded_and_storage_errors(self):
        anonymous = Connection(authenticated=False)
        await self.module.settings_command(self.hass, anonymous, {"id": 1, "action": "get"})
        self.assertEqual(anonymous.errors[-1][1], "unauthorized")
        admin = Connection(admin=True)
        Path(self.manager.store.path).write_text("broken")
        await self.module.settings_command(self.hass, admin, {"id": 2, "action": "get"})
        self.assertEqual(admin.errors[-1][1], "storage_error")
        self.hass.data["water_accounting"].pop("settings")
        await self.module.settings_command(self.hass, admin, {"id": 3, "action": "get"})
        self.assertEqual(admin.errors[-1][1], "not_loaded")

    def test_moscow_today_uses_named_zone(self):
        self.clock.stop()
        actual_datetime = self.module.datetime
        class Clock:
            @staticmethod
            def now(zone):
                self.assertEqual(str(zone), "Europe/Moscow")
                return actual_datetime(2026, 11, 9, 0, 30, tzinfo=zone)
        with patch.object(self.module, "datetime", Clock):
            self.assertEqual(self.module.moscow_today(), date(2026, 11, 9))


if __name__ == "__main__":
    unittest.main()
