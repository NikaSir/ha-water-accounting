"""Constants for NikaS Water Accounting."""

from __future__ import annotations

DOMAIN = "water_accounting"
INTEGRATION_VERSION = "0.1.5"
UI_VERSION = "0.1.5"
UI_STANDARD_VERSION = "2.2"

ENTITY_MAP: dict[str, str] = {
    "pressure_drinking": "sensor.nikas_h2000_pro_pitevaia_voda",
    "pressure_irrigation": "sensor.nikas_h2000_pro_voda_na_poliv_2",
    "zont_online": "binary_sensor.nikas_h2000_pro_online",
    "drinking_total": "sensor.schetchik_vody_svd_20_0020989_pokazaniia",
    "drinking_temperature": "sensor.schetchik_vody_svd_20_0020989_temperatura",
    "drinking_battery": "sensor.schetchik_vody_svd_20_0020989_batareia",
    "drinking_signal": "sensor.schetchik_vody_svd_20_0020989_signal",
    "drinking_updated": "sensor.schetchik_vody_svd_20_0020989_obnovleno",
    "irrigation_total": "sensor.schetchik_vody_svd_20_0020988_pokazaniia",
    "irrigation_temperature": "sensor.schetchik_vody_svd_20_0020988_temperatura",
    "irrigation_battery": "sensor.schetchik_vody_svd_20_0020988_batareia",
    "irrigation_signal": "sensor.schetchik_vody_svd_20_0020988_signal",
    "irrigation_updated": "sensor.schetchik_vody_svd_20_0020988_obnovleno",
}

PRESSURE_POLICY = {
    "drinking": {
        "normal_min": 2.4,
        "normal_max": 3.1,
        "zero_is_no_pressure": True,
    },
    "irrigation": {
        "critical_low_below": 0.3,
        "normal_min": 2.5,
        "normal_max": 3.5,
        "warning_high_max": 4.0,
    },
}
