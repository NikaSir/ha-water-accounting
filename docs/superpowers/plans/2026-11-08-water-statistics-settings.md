# Water Statistics and Settings Implementation Plan

> **For agentic workers:** Execute independent file scopes in parallel; retain a fresh whole-branch review before delivery. Steps use checkbox tracking.

**Goal:** Add weekly-report statistics and shared planned irrigation shutdown settings.

**Architecture:** Pure frontend analytics over Recorder and the treatment journal, with a persistent settings WebSocket endpoint. Five tabs retain the existing shell.

**Tech Stack:** Existing Home Assistant Python integration, vanilla JavaScript custom element, Node test runner, Python unittest.

**Spec:** `docs/superpowers/specs/2026-11-08-water-statistics-settings-design.md`

## Global Constraints

Moscow full days; monthly real zeros included; no invented measurements; no estimated regeneration deductions; retain NikaS 2.2 shell. Defaults and payload schema are in the spec. No live device changes or new automation.

## Review Focus

- Missing/duplicated boundary hours must not produce complete daily or monthly totals.
- A failed settings read or stale save must not mask an irrigation fault or overwrite another device.
- Missing or duplicate regeneration records must not produce a falsely confirmed clean total.
- Browser timezone and year change must not alter Moscow dates or silently assume unknown calendar transfers.
- Refresh/disconnect and edited forms must preserve current values and avoid stale request commits.

### Task 1: Shared settings and outage annotation

Files: new `settings.py`, settings tests; modify `__init__.py` only as needed. Implement the spec's snapshot and authenticated get/update API, validated settings, revision lock, durable atomic write/readback. Test normal save/reload, malformed fields, unauthorized and stale revisions, concurrent updates and disk errors before implementation. Check with `python -m unittest discover -s tests -v`.

### Task 2: Report model

Files: new `frontend/src/report-model.js`, `tests/report-model.test.mjs`. Implement `periods` and `build` interface in spec; official RF calendar classification, hourly coverage, same-day regeneration conflict handling, typical groups, month totals and previous-Monday reconstruction. Write hand-calculated synthetic examples and failure cases first. Check with `node --test tests/report-model.test.mjs`.

### Task 3: Statistics/settings UI and outage rendering

Files: existing frontend core/styles, new `report-ui.js` if useful, frontend tests. Consume shared API and model. Add statistics/settings tabs, merge meters/diagnostics, lazy loading, explicit save/revision/failure states. Planned inactive irrigation is neutral while unrelated faults remain visible; history retains actual readings. Preserve stable nodes, focus and scroll. Test read-only users and edited forms. Check shipped bundle, browser geometry and full `npm run check`.

### Task 4: Integration, release metadata and evidence

Files: deterministic builder, manifests/contracts/package, release notes/methodology, CI test command. Version `0.3.0-beta002`. Verify full suite, local browser, independent review, branch publication/PR and CI without claiming merge or install. Update the existing knowledge base with confirmed results and limitations, preserving concurrent edits.

## Execution record

- Baseline: GitHub main `beb7557fd459230185e692122d6eec0f8e894826`; exact local tree matches. `npm run check` passed: 29 Recorder tests, 16 Python tests, frontend contracts and NikaS UI checks.
- Engineering decisions: separate statistics tab; explicit verification interval for exact net values; planned outages are metadata; diagnostics join meters as explicitly requested.
- Completed: persistent admin settings, pure report model, five-tab UI, merged diagnostics, release metadata and methodology.
- Local verification: `npm run check` passes (29 Recorder, 23 report-model, 9 report-UI JavaScript tests; 34 Python tests; deterministic bundle, panel/NikaS contracts and refresh harness).
- Chromium acceptance: 25 viewport/tab combinations (390×844, 430×932, 932×430, 768×1024, 1440×900), stable header/footer and telemetry nodes, Moscow day boundaries, planned outage versus drinking faults, delayed save, dirty field/focus, refresh, conflict/reload, re-enable, storage-read failure and non-admin access. Browser fixtures are synthetic; actual household measurements are not committed.
- Independent review fixed three reproduced issues: regeneration identity conflicts beyond the requested dates, concurrent save across integration reload, and settings polling stopping when its timer fires during a save. Regression tests cover each; reviewers confirmed the fixes.
- Actual HA hourly statistics were privately compared against the known weekly calculation. Inputs and exact household totals remain outside this public repository. Live installation and endpoint acceptance require the beta to be installed; this branch does not claim deployment.
