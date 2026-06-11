## What

<!-- What this changes, and the issue it relates to (behavior changes: please open the issue first). -->

## Checklist

- [ ] `npm test` passes locally
- [ ] The frozen fixture (`test/fixture.test.mjs`) passes **unmodified** — any new `candidate.json` fields are optional/nullable
- [ ] New numbers a narrative could cite are added to the groundedness support pool (`src/groundedness.mjs`); numbers claimed at submit join the re-derivation (`src/consistency.mjs`)
- [ ] Nothing grades, ranks, or scores a person — counts describe ([ADR-001](../docs/adr/001-just-a-report.md))
- [ ] Privacy boundaries respected: no `.env` reads, `repoLabel` never transmitted, custom MCP/skill names surface as counts only
- [ ] No new runtime dependencies (or the description argues the exception)
- [ ] New signals come with tests
