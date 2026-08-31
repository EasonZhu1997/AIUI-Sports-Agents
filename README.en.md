# AIUI Sports Agents

AIUI Sports Agents is an evidence-first open-source initiative for sports agents on smart glasses.

The project maintains independent running, cycling, and rowing-machine applications under one public benchmark and governance model. It does not merge different sports into one monolithic app.

The shared rules are simple:

1. Prefer measured sensor data.
2. Label every estimate.
3. Keep unavailable data unavailable.
4. Bind every capability claim to a version, environment, and evidence level.

The initial tracks are AISmartRun, AIBike, and AISmartRower. Rower telemetry uses the standard Fitness Machine Service and keeps physical machine control disabled by default.

Run the repository checks with:

```bash
npm run validate
npm run report
```

See [README.md](README.md) for the complete Chinese guide, [benchmark/README.md](benchmark/README.md) for the evaluation model, and `projects/` for individual product cards.

This local repository has not been published or uploaded. Apache-2.0 covers original work in this repository; third-party materials remain subject to their own licenses.
