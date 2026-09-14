# Update and release policy

## Current repository state

- `main` is the canonical source branch, and accepted changes reach it through reviewed pull requests after required checks pass.
- The integration version is [`0.1.6`](../custom_components/water_accounting/manifest.json).
- At the 2026-09-14 audit baseline, this repository had no Git tags or GitHub Releases. The README documents installation as a custom HACS repository.
- End-to-end acceptance that HACS exposes and installs the current `main` state was not performed by that audit. A merged commit is accepted source, not confirmed user delivery, until verification succeeds in the target Home Assistant installation.

## Acceptance gate

Before an update is presented to users:

1. Repository checks, integration tests, HACS validation and Hassfest pass for the reviewed commit.
2. Recorder data on the target installation verifies both meter rows, hour boundaries, complete intervals and final totals without treating missing coverage as zero consumption.
3. The installed panel, restart behavior, navigation and mobile shell are checked in Home Assistant.
4. The accepted commit SHA and integration version are recorded, and the previous accepted state remains available for rollback.
5. `CHANGELOG.md` describes the user-visible change.

The repository's HACS publication contract applies if testing establishes that delivery is release-driven. Creating a publication workflow, tag or GitHub Release is a separate change; none is created or claimed here.
