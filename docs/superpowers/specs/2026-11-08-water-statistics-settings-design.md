# Water statistics and planned irrigation outages

## Intent and authority

Implement the user's request to add statistics corresponding to the existing weekly water report, plus persistent settings for intentional irrigation shutdowns. The user explicitly chose to combine meters and diagnostics. Existing project instructions supply the calculation rules; implementation details below are engineering choices.

## User experience

Five tabs: Обзор, Расход, Статистика, Счётчики, Настройки. Existing consumption graphs remain. Diagnostics are included within meters. Settings are shared across devices through Home Assistant, with an explicit save action and administrator write access. Setting irrigation inactive is a user annotation, not a valve command. Show the reason/date, suppress only irrigation-specific current pressure/connection faults, and restore normal monitoring when enabled. Historical consumption and missing data are never rewritten as zero.

Statistics use the drinking counter and completed Europe/Moscow days. Show cumulative daily averages (workdays, ordinary weekends, national holidays, combined nonworking days, all days), current month to yesterday, previous complete calendar month, measured regeneration deductions, excluded dates/counts, source and freshness. Default cumulative start is 2026-10-27, from the existing report; the configurable initial low-day threshold is 100 litres, explicitly a preliminary assumption. Monthly statistics include every calendar day, including true zeros. Missing data remain missing.

## Approaches

Extending the existing graph card would crowd its mobile layout. A server-side analytics service would duplicate Recorder's API and need a broader dependency. Chosen engineering approach: a separate pure JavaScript report model, existing authenticated Recorder hourly reads, read-only water_treatment/filters journal access, and a small persistent settings API. No second regeneration journal or schedule is created.

## Data contracts

`water_accounting/settings` supports `action: get|update`, with `payload` and `revision` for updates. Snapshot: `{revision, settings: {statistics_start_date, low_day_threshold_l, regeneration_verified_from, regeneration_verified_through, irrigation: {enabled, reason, since}}}`. Dates use YYYY-MM-DD; default verification dates are null. Irrigation is enabled by default; disabled requires a nonempty reason and a valid nonfuture effective date. Mutations require HA administrator status and optimistic revision matching; writes occur off the event loop, atomically, and are verified before success. Failed reads/writes never silently reset saved settings.

Pure browser API: `WaterReportModel.periods(now, settings)` returns UTC millisecond request bounds, Moscow ISO dates and periods; `WaterReportModel.build({now, settings, rows, treatment, treatmentAvailable, unit})` returns a view model. Hour rows are Recorder records with numeric `start`, `sum`, `change`; one preceding baseline is mandatory. `unit` must be a supported volume unit. Require every hour of a day and its preceding baseline. Reject invalid/negative/duplicate/off-grid records rather than guessing.

Journal source is `water_treatment/filters`, action get, `settings.salt.history`. Only `action: regeneration` and explicitly recorded finite nonnegative `water_m3` qualify. The journal's `result` describes softening effectiveness and is not evidence about water volume. Never substitute dose assumptions, refill_l, 390 L, average cycles, or fixed intervals. Records with the same identity are deduplicated; ambiguous same-day records must not be subtracted twice. Missing volumes and unavailable journals are visible. Treat a journal date as a date, never invent an event time.

Complete net values require the user-confirmed journal verification interval and all relevant volumes; outside that interval show only a clearly named residual after recorded cycles, not a confirmed clean total. Monthly gross can remain complete even when net is unknown. Typical-day selection uses the residual threshold on complete, unambiguous days and labels unverified regeneration coverage. Net and gross averages always share the same selected dates. Weighted all-days mean, no average of group averages. Comparison is explicitly a reconstruction ending at the preceding Monday boundary with today's known inputs, not an invented stored prior report.

Settings metadata are scoped to the HA instance and server; never trust a stale browser-local outage flag to suppress faults. A missing settings response must show unknown configuration and retain normal monitoring.

## Constraints and acceptance

Maintain fixed shell geometry, internal scroll, stable DOM under telemetry, full semantic beta version, deterministic standalone bundle, no new third-party runtime dependency. Do not publish private measurement fixtures in the public repository. Calendar transfer data require authoritative sources; unsupported years expose an explicit limitation instead of classifying weekdays as verified workdays.

Verify arithmetic, actual zero versus gaps, UTC/local date boundaries, malformed/duplicate/missing cycle data, monthly denominators, provisional net status, admin/revision/persistence failure handling, outage restoration, freshness and request races. Run repository checks and a real local browser at mobile/desktop sizes. PR/CI, merge, release and target HA installation are separate states.
