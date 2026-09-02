# AIUI Sports Agents

AIUI Sports Agents is an evidence-first open-source benchmark and governance hub for sports agents on smart glasses. The application source planned for AISmartRun, AIBike, AISmartRower, and AISmartPaddle is a separate source-available distribution, not an OSI open-source grant.

The project maintains independent running, cycling, rowing-machine, and dual-mode kayak/indoor-rower applications under one public benchmark and governance model. It does not merge different sports into one monolithic app.

The shared rules are simple:

1. Prefer measured sensor data.
2. Label every estimate.
3. Keep unavailable data unavailable.
4. Bind every capability claim to a version, environment, and evidence level.

The current tracks are AISmartRun, AIBike, AISmartRower, and AISmartPaddle. Rower telemetry uses the standard Fitness Machine Service and keeps physical machine control disabled by default.

Run the repository checks with:

```bash
npm run validate
npm run report
```

See [README.md](README.md) for the complete Chinese guide, [benchmark/README.md](benchmark/README.md) for the evaluation model, and `projects/` for individual product cards.

This public benchmark and governance hub remains under Apache-2.0, including its permission for compliant commercial use. Source snapshots for the four applications have not been published. When separately released, their original application code is planned to use PolyForm Noncommercial 1.0.0 plus a separate written commercial license; this policy does not revoke or restrict any Apache-2.0 version. See [LICENSE_POLICY.md](LICENSE_POLICY.md) and [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md). Third-party materials remain subject to their own licenses.
