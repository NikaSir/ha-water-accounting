from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT/'custom_components/water_accounting'


class SplitTests(unittest.TestCase):
    def test_accounting_releases_treatment_without_touching_legacy_storage(self):
        setup = (COMPONENT/'__init__.py').read_text()
        self.assertNotIn('async_setup_filters', setup)
        self.assertIn('treatment_split_ready', setup)
        self.assertFalse((COMPONENT/'filters.py').exists())
        bundle = (COMPONENT/'frontend/water-accounting-panel.js').read_text()
        self.assertNotIn('water_accounting/filters', bundle)
        self.assertNotIn('salt_topup', bundle)
        self.assertNotIn('treatment_gh', bundle)
        self.assertIn('recorder/statistics_during_period', bundle)
