# Judge fixtures

Each directory holds `input.json` (task, agent claim, deterministic findings, per-file diffs) and `response.json`
(the judge's reply). `npm test` builds the prompt from the input and applies the recorded reply offline.

`response.json` carries a `source` field: `authored` means the reply was written by hand in the schema's shape;
`live` means it was recorded from the model by `scripts/judge-record.mjs`, which also stores the prompt hash so a
rubric change is visible as a hash mismatch. Re-record with `node scripts/judge-record.mjs` when a key is present.
