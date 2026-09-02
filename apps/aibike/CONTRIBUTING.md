# Contributing to AIBike

Keep changes evidence-first and privacy-bounded:

1. Open an issue describing the scenario, device profile, expected behavior, and
   evidence level.
2. Add deterministic parser, lifecycle, and failure-path tests before changing the
   UI claim.
3. Run `npm ci`, `npm test`, `npm run doctor:aiui`, and the three local AIX pack and
   inspect commands documented in `README.md`.
4. Never commit AIX files, captures, credentials, production endpoints, stable BLE
   identifiers, raw health packets, or personal activity records.
5. Do not state that real hardware is supported until the documented host reaches
   first valid packet, sustained freshness, cleanup, disconnect, and reconnect gates.

Contributors retain rights in their contributions unless a separate written
agreement says otherwise. Before accepting a contribution intended for commercial
dual licensing, maintainers may require a separately reviewed contributor agreement.
