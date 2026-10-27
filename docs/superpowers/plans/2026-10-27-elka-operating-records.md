# Elka operating records implementation plan

> **For agentic workers:** Use superpowers:executing-plans; implement in this session with one final fresh review.

**Goal:** Apply the supplied water-treatment handoff to editable assumptions, manual salt accounting and GH measurements without fabricating equipment telemetry.

**Spec:** User's attached technical handoff, sections 3–10. Its personal observations remain outside the public repository. NikaS Engineering Knowledge Base §§3.4–3.5, 11–12 applies.

**Architecture:** Extend the existing FilterStore/revision-checked WebSocket API. Keep salt bookkeeping and water-treatment/measurement calculations in separate pure Python modules. Add frontend controls through a compiled-in treatment UI module, reusing existing save guards and the stable shell. Do not change Recorder consumption or write to the physical valve.

## Design and constraints

- Old-device preliminary profile: resin 8 L, salt dose 1 kg/cycle, temporarily configured cycle volume 1.20 m³; A-01, 03:00, HU-01, F-00, H-06, b-01; stage times 10/75/1/6 min. Every field is identified as configured, assumed or measured. A minute of refill never becomes a measured salt dose.
- Preserve all stored settings/dates/history. Legacy doses receive an unverified provenance flag; existing 1.5 kg must not silently become a measured old-device dose. Offer explicit application of the preliminary old-device profile.
- Salt ledger starts with unknown stock. A tank-service entry sets stock to the explicitly entered remaining mass plus the new addition, rather than adding to the old stock. Salt removal is a separate operation. No pre-entered refill or maintenance event.
- Regeneration entries require confirmation of a completed cycle. Count records, not lifetime cycles. Unknown actual salt consumption invalidates known mass; its optional estimate uses a dose recorded with that event. Confirmation of effectiveness is separate from recording the cycle.
- Keep kg of salt, L of refill water and m³ of regeneration water separate. No second deduction from meter consumption. Optional time coverage uses explicitly configured household service consumption and is labelled a scenario.
- GH journal: NILPA, 5 ml only, integer drop count; 1 drop = 1 °dGH, 1 °dGH = 0.3566 °Ж. Records retain point/date/raw/result. Only a user-explicit measurement from the softener outlet can update the BARRIER input hardness.
- Store resin start year and replacement date separately from tank maintenance. Unknown dates stay unknown.
- Retain the existing profiles as selected maintenance profiles; the handoff does not independently confirm installed cartridge models.
- Human dates use HA's local date. Future events and out-of-order stock mutations are rejected. Old history is preserved; new recent-event display is bounded.
- No automatic import of personal samples or recommended refill quantities from the handoff. No HA restart/install or valve reconfiguration.

## Approaches

Use the current shared HA store and manual event API: it already provides persistence, admin checks and conflict detection. A separate helper/automation system would duplicate state. Inferring regeneration from a counter reset would incorrectly claim effective regeneration and is excluded by the handoff.

## Review focus

- Migration must preserve custom doses, history, dates and meter baselines.
- Cleanup must replace the opening stock, including explicit zero values.
- Estimated doses must never appear as measured remaining stock.
- GH from raw mains or BARRIER outlet must not become BARRIER input hardness.
- Pending reads, failed writes, duplicate presses and new drafts must retain beta003 behavior.

## Tasks

1. **Domain models:** write RED tests for salt reset/removal/cycles/migration and GH conversion/stage sums; implement `salt_model.py` and `treatment_model.py`; run model tests GREEN.
2. **Persistence:** extend `filters.py` load/mutation/snapshot and test reload, admin/conflict/error paths without losing existing filter data.
3. **UI:** compile `treatment-ui.js` into the standalone bundle; add profile, salt-ledger and GH controls with adjacent result messages; test actual payload/rendering, then rebuild.
4. **Delivery:** version `0.2.0-beta004`, update technical notes/changelog, run `npm run check`, JS syntax and diff checks; obtain a fresh review, address findings with tests, and open a PR. Merge and target-phone acceptance are separate steps.

## Verification and review record

Domain, persistence and UI tasks are implemented. New behavior tests first failed against beta003, then passed after implementation. One fresh read-only whole-branch review found two important UI lifecycle issues: overwritten treatment drafts and stale measured fields reused for a new event. Both were reproduced by additional tests and repaired. Its validation-scope finding was treated as a functional issue because unfinished GH input blocked independent cartridge settings; it was also reproduced and repaired.

Successful responses now fill only the submitted settings section and preserve later edits. Event forms clear unchanged committed measurements and effectiveness flags. Dirty configuration drafts retain their original conflict basis; unrelated salt/GH journal updates do not create false settings conflicts.

Final local checks: 29 statistics tests, 26 frontend tests, 45 Python tests, UI regression, deterministic bundle/declared-input/version parity, JS syntax and whitespace checks. Live HA installation, physical iPhone acceptance, brine uptake, actual resin/dose verification and meter placement remain outside automated verification. No personal handoff observations are pre-created in the store.
