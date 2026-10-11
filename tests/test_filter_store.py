"""Exercise real persistence adapter with small HA boundary fakes."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'custom_components/water_accounting'


def load_adapter():
    modules = {}
    def module(name, **attrs):
        item = ModuleType(name)
        item.__dict__.update(attrs)
        modules[name] = item
        return item
    class Store:
        saved = None
        fail = False
        def __init__(self, *args): pass
        async def async_load(self): return deepcopy(self.saved)
        async def async_save(self, value):
            if self.fail: raise OSError('disk full')
            type(self).saved = deepcopy(value)
    class Field:
        def __init__(self, *args, **kwargs): pass
    websocket = SimpleNamespace(websocket_command=lambda schema: lambda fn: fn,
        async_response=lambda fn: fn, async_register_command=lambda *args: None)
    module('voluptuous', Required=Field, Optional=Field, In=lambda x: x)
    module('homeassistant')
    module('homeassistant.components', websocket_api=websocket)
    module('homeassistant.exceptions', HomeAssistantError=RuntimeError)
    module('homeassistant.helpers')
    module('homeassistant.helpers.storage', Store=Store)
    module('homeassistant.util', dt=SimpleNamespace(now=lambda: datetime(2026,10,12,tzinfo=timezone.utc)))
    pkg = module('_filter_test_package');pkg.__path__=[str(ROOT)]
    with patch.dict(sys.modules, modules):
        spec=importlib.util.spec_from_file_location('_filter_test_package.filters',ROOT/'filters.py')
        adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
    return adapter, Store


class FilterStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.adapter, self.store = load_adapter()
        self.state = SimpleNamespace(state='353.456',attributes={'unit_of_measurement':'m³'})
        self.hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity: self.state),data={})
        self.manager = self.adapter.FilterStore(self.hass)

    async def test_replacement_reload_and_settings_never_reset_baseline(self):
        await self.manager.load()
        await self.manager.mutate('replace',{'filter':'main'},0)
        self.assertEqual(self.manager.data['main']['baseline'],353.456)
        self.state.state='363.456'
        self.assertEqual(self.manager.snapshot()['status']['main']['used'],10)
        await self.manager.mutate('settings',{'main':{'profile':'wound','volume':200}},1)
        reloaded=self.adapter.FilterStore(self.hass);await reloaded.load()
        self.assertEqual(reloaded.data['main']['baseline'],353.456)
        self.assertEqual(reloaded.revision,2)

    async def test_conflict_and_failed_save_leave_state_untouched(self):
        await self.manager.load()
        with self.assertRaises(ValueError):
            await self.manager.mutate('replace',{'filter':'main'},9)
        self.store.fail=True
        with self.assertRaises(OSError):
            await self.manager.mutate('replace',{'filter':'main'},0)
        self.assertIsNone(self.manager.data['main']['date'])
        self.assertEqual(self.manager.revision,0)

    async def test_invalid_future_date_and_missing_meter_rejected(self):
        await self.manager.load()
        with self.assertRaises(ValueError):
            await self.manager.mutate('record',{'filter':'ferrostop','date':'2027-01-01'},0)
        self.state.state='unavailable'
        with self.assertRaises(ValueError):
            await self.manager.mutate('replace',{'filter':'main'},0)
        self.state.state='1000';self.state.attributes['unit_of_measurement']='L'
        self.assertEqual(self.manager.meter(),1)
        self.state.attributes['unit_of_measurement']='unexpected'
        self.assertIsNone(self.manager.meter())

    async def test_non_admin_can_read_but_cannot_mutate(self):
        await self.manager.load()
        self.hass.data={'water_accounting':{'filters':self.manager}}
        results=[]
        errors=[]
        connection=SimpleNamespace(send_result=lambda *args: results.append(args), user=SimpleNamespace(is_admin=False), send_error=lambda *args: errors.append(args))
        await self.adapter.filters_command(self.hass,connection,{'id':1,'action':'get'})
        self.assertEqual(len(results),1)
        await self.adapter.filters_command(self.hass,connection,{'id':2,'action':'settings'})
        self.assertEqual(errors[0][1], 'unauthorized')
        self.assertEqual(self.manager.revision,0)

    async def test_salt_migration_and_reload_preserve_filter_dates(self):
        await self.manager.load()
        await self.manager.mutate('replace',{'filter':'ferrostop'},0)
        await self.manager.mutate('salt_topup',{'kg':25},1)
        await self.manager.mutate('salt_check',{'level':'low'},2)
        reloaded=self.adapter.FilterStore(self.hass)
        await reloaded.load()
        self.assertEqual(reloaded.data['cartridges']['ferrostop']['date'],'2026-10-12')
        self.assertEqual(reloaded.data['salt']['last_added_kg'],25)
        self.assertEqual(reloaded.snapshot()['salt_status']['state'],'low')
        del self.store.saved['settings']['salt']
        migrated=self.adapter.FilterStore(self.hass)
        await migrated.load()
        self.assertEqual(migrated.data['cartridges']['ferrostop']['date'],'2026-10-12')
        self.assertIsNone(migrated.data['salt']['last_checked'])
