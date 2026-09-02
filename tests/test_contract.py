from __future__ import annotations

import ast
import json
import re
import runpy
import struct
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "custom_components" / "water_accounting"


class RepositoryContractTests(unittest.TestCase):
    def test_all_json_is_valid(self) -> None:
        for path in ROOT.rglob("*.json"):
            with self.subTest(path=path.relative_to(ROOT)):
                json.loads(path.read_text(encoding="utf-8"))

    def test_all_python_is_syntactically_valid(self) -> None:
        for path in (ROOT / "custom_components").rglob("*.py"):
            with self.subTest(path=path.relative_to(ROOT)):
                ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    def test_approved_pressure_policy(self) -> None:
        constants = runpy.run_path(str(COMPONENT / "const.py"))
        drinking = constants["PRESSURE_POLICY"]["drinking"]
        irrigation = constants["PRESSURE_POLICY"]["irrigation"]
        self.assertEqual(drinking["normal_min"], 2.4)
        self.assertEqual(drinking["normal_max"], 3.1)
        self.assertTrue(drinking["zero_is_no_pressure"])
        self.assertEqual(irrigation["critical_low_below"], 0.3)
        self.assertEqual(irrigation["normal_min"], 2.5)
        self.assertEqual(irrigation["normal_max"], 3.5)
        self.assertEqual(irrigation["warning_high_max"], 4.0)

    def test_version_and_route_parity(self) -> None:
        constants = runpy.run_path(str(COMPONENT / "const.py"))
        manifest = json.loads((COMPONENT / "manifest.json").read_text(encoding="utf-8"))
        panel_manifest = json.loads((COMPONENT / "panel_manifest.json").read_text(encoding="utf-8"))
        contract = json.loads((ROOT / "panel_contract.json").read_text(encoding="utf-8"))
        standard = json.loads((ROOT / ".nikas-ui-standard.json").read_text(encoding="utf-8"))
        versions = {
            constants["INTEGRATION_VERSION"],
            constants["UI_VERSION"],
            manifest["version"],
            panel_manifest["ui_version"],
            contract["ui_version"],
            standard["ui_version"],
        }
        self.assertEqual(versions, {"0.1.2"})
        self.assertEqual(manifest["dependencies"], ["http", "panel_custom"])
        self.assertEqual(panel_manifest["panel_root"], "/dashboard-water")
        self.assertEqual(contract["entry_route"], "/dashboard-water")
        self.assertEqual(contract["safe_return_route"], "/dashboard-house-v11/home")

    def test_entity_contract_is_present_in_runtime(self) -> None:
        constants = runpy.run_path(str(COMPONENT / "const.py"))
        bundle = (COMPONENT / "frontend" / "water-accounting-panel.js").read_text(encoding="utf-8")
        self.assertEqual(len(constants["ENTITY_MAP"]), 13)
        for role, entity_id in constants["ENTITY_MAP"].items():
            with self.subTest(role=role):
                self.assertIn(entity_id, bundle)

    def test_single_autonomous_runtime(self) -> None:
        panel_manifest = json.loads((COMPONENT / "panel_manifest.json").read_text(encoding="utf-8"))
        standard = json.loads((ROOT / ".nikas-ui-standard.json").read_text(encoding="utf-8"))
        self.assertEqual(panel_manifest["runtime_files"], ["frontend/water-accounting-panel.js"])
        self.assertEqual(standard["runtime_files"], [standard["production_entrypoint"]])
        bundle = (ROOT / standard["production_entrypoint"]).read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"^\s*(?:import|export)\b", bundle, re.MULTILINE))
        self.assertNotIn("__WATER_ACCOUNTING_CSS__", bundle)

    def test_brand_icon_is_valid_png(self) -> None:
        data = (COMPONENT / "brand" / "icon.png").read_bytes()
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
        width, height = struct.unpack(">II", data[16:24])
        self.assertEqual((width, height), (256, 256))

    def test_locales_have_config_flow(self) -> None:
        for name in ("strings.json", "translations/ru.json", "translations/en.json"):
            data = json.loads((COMPONENT / name).read_text(encoding="utf-8"))
            self.assertIn("config", data)
            self.assertIn("user", data["config"]["step"])

    def test_mobile_layout_and_threshold_placement(self) -> None:
        core = (COMPONENT / "frontend" / "src" / "water-accounting-panel-core.js").read_text(
            encoding="utf-8"
        )
        styles = (COMPONENT / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")
        overview = core[
            core.index("\n  _overviewMarkup() {") : core.index("\n  _thresholdsMarkup() {")
        ]
        meters = core[
            core.index("\n  _metersMarkup() {") : core.index("\n  _meterCardMarkup(")
        ]
        self.assertNotIn("Пороговые значения давления", overview)
        self.assertIn("this._thresholdsMarkup()", meters)
        self.assertIn(".header-title:active", styles)
        self.assertIn("grid-template-columns: repeat(var(--bucket-count), minmax(0, 1fr))", styles)
        self.assertNotIn("calc(var(--bucket-count) * 21px)", styles)


if __name__ == "__main__":
    unittest.main()
