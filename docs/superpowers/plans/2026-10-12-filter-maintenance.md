# Filter maintenance implementation plan

Goal: add shared filter settings and replacement tracking to the existing Water Accounting panel.
Architecture: a pure Python calculation module plus integration-owned HA Store and authenticated WebSocket commands; cached frontend tab with editable forms and status updates.

- [ ] Test profiles, hardness table, calendar deadlines, unavailable/reset meters, validation and baseline preservation.
- [ ] Implement persistent settings and admin-only mutations, serialised writes and reload cleanup.
- [ ] Add Filters tab, per-cartridge dates, replacement buttons, settings and explicit unknown status.
- [ ] Update version to 0.2.0-beta001, build, run existing checks and new tests; open a draft PR.

Approved requirements: main mechanical BB20 5µm 100m³/6 months; wound BB20 10µm 200m³/6 months (time is a local default, not confirmed manufacturer guidance). Choose volume/time/both, custom limits. Only drinking meter counts. Three Expert cartridges have separate dates and 6-month defaults; softening automatic recommendation uses 1–3 people and hardness up to 5, capped at 6 months, with manual override outside table. Settings changes never reset baselines. No inferred replacement dates. Existing pressure/Recorder behavior stays intact.
