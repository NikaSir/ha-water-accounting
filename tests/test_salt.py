import runpy
import unittest
from datetime import date
from pathlib import Path

class SaltTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m=runpy.run_path(str(Path(__file__).resolve().parents[1]/'custom_components/water_accounting/salt_model.py'))
    def test_unknown_not_inferred_from_topup(self):
        cfg=self.m['salt_defaults']()
        updated=self.m['salt_action'](cfg,'topup',{'kg':25},date(2026,10,12))
        self.assertEqual(updated['last_added_kg'],25)
        self.assertEqual(self.m['salt_status'](updated,date(2026,10,12))['state'],'unknown')
    def test_checked_and_overdue(self):
        cfg=self.m['salt_action'](self.m['salt_defaults'](),'check',{'level':'enough'},date(2026,10,12))
        self.assertEqual(self.m['salt_status'](cfg,date(2026,10,13))['state'],'ok')
        self.assertEqual(self.m['salt_status'](cfg,date(2026,10,18))['state'],'check')
        cfg=self.m['salt_action'](cfg,'check',{'level':'low'},date(2026,10,18))
        self.assertEqual(self.m['salt_status'](cfg,date(2026,10,18))['state'],'low')
    def test_settings_preserve_history_and_validate(self):
        cfg=self.m['salt_action'](self.m['salt_defaults'](),'topup',{'kg':25},date(2026,10,12))
        updated=self.m['salt_action'](cfg,'settings',{'dose':1.6,'check_days':7},date(2026,10,12))
        self.assertEqual(updated['last_added_kg'],25)
        with self.assertRaises(ValueError):self.m['salt_action'](cfg,'topup',{'kg':-1},date(2026,10,12))
