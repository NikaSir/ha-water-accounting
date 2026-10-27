# Salt saving repair implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this focused repair.

**Goal:** Persist a salt top-up even when a background filter read is running, and make its confirmed result visible at the salt controls.

**Architecture:** Keep the existing authenticated, revision-checked FilterStore API. Separate frontend read single-flight from write exclusion, wait for an in-flight read before submitting one captured action, and display the server-confirmed mass/date or failure inside the salt card.

**Tech stack:** Autonomous JavaScript custom panel, Home Assistant WebSocket/storage API, Python unittest and Node test harness.

**Spec:** User request of 2026-10-27: salt mass does not save; consult «Контроль замены фильтров» and correct calculations/constants where supported. NikaS Engineering Knowledge Base §§3.4–3.5, 11–12 applies.

## Global constraints

- Preserve saved filter dates, meter baselines, salt history and user-edited settings.
- A top-up is a recorded mass, not a measured remaining stock or a salt-level inspection.
- Three household users are confirmed in the available NikaS context; change the initial default only.
- Full chat retrieval is unavailable. Do not infer hardness units, a measured regeneration dose or an actual cycle interval from incomplete excerpts.
- HACS currently installs this repository by main commit, not releases. Use a PR and green checks; do not create a tag/release or restart HA.

## Review focus

- A top-up pressed during a background read must be sent once using the refreshed revision.
- A failed write must keep the entered mass and previous confirmed data, with a local error.
- A newer draft typed while a write is pending must survive the earlier acknowledgement.
- Read failures and duplicate presses must neither invent a saved event nor leave the form locked.
- Salt saving must preserve the independent manual inspection and filter-replacement semantics.

## Task 1: Repair the save lifecycle

- [x] Add behavior tests to `tests/filter_ui_harness.mjs` for the five cases above; run them against the existing bundle and confirm the relevant failures.
- [x] Update `frontend/src/water-accounting-panel-core.js`: single-flight reads, write exclusion across the wait, local salt feedback and conditional draft clearing.
- [x] Build the production bundle and run the frontend harness until green.

## Task 2: Reconcile constants and publish a reviewable change

- [x] In `tests/test_filters.py`, exercise automatic cartridge-life calculation using initial settings and hardness 3; expect 2 months for the confirmed three-person household. Confirm the existing default fails this case.
- [x] Change only `filter_model.defaults()` to three people; keep existing persisted choices and the manufacturer's hardness table.
- [x] Record accessible-chat observations, their limits and the distinction between the 6-day check reminder, a regeneration interval and an unverified salt dose in `docs/WATER_TREATMENT_NOTES.md`.
- [x] Bump synchronized version markers to `0.2.0-beta003`, update changelog/release notes, rebuild, run `npm run check`, syntax checks and `git diff --check`.
- [x] Obtain a fresh review and commit the repair. Review found no blocking issues; the same-mass draft case and changelog headings were also corrected.
- [ ] Push the repair branch, open a PR and inspect CI; report separately from target-phone acceptance.

## Verification record

Original bundle: four save/feedback tests failed, and the initial household calculation produced 3.5 months instead of 2. Each repair passed after implementation. Additional failing cases covered settings-revision preservation and re-entering an identical mass. Full suite: 29 statistics tests, 11 filter frontend tests, 29 Python tests, UI regression harness, bundle/version parity, JS syntax and whitespace checks. Public documentation contains technical calculation rules without personal chat excerpts.

Publication status: automatic approval review rejected git push pending explicit user authorization to publish the repair branch to NikaSir/ha-water-accounting. Repository ownership (connected NikaSir), public visibility and admin/push permission were verified. No PR, remote update, HACS installation or HA restart was performed. A local mail patch is prepared for review.
