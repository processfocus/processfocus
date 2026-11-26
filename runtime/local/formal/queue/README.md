# Local queue models

These TLA+ models explore queue acceptance, retries, worker supervision,
terminal recovery, and health observation. Start with the
[runtime architecture](../../ARCHITECTURE.md#background-work) for the system view.

The central distinctions are:

- An ID returned inside a transaction is provisional until the outer commit.
- Accepted work can complete or leave a retained terminal record.
- Worker recovery does not imply that an external action's outcome is known.
- Newest-first priority permits starvation under sustained higher-priority
  arrivals; finite-backlog progress assumes the runtime and database can run.

## Running the checks

From the repository root, with Bun, Java, and TLC installed:

```bash
bun runtime/local/formal/queue/check.ts
```

Set `TLC='java -jar /path/to/tla2tools.jar'` if TLC is not on `PATH`.
Use `--case` to select a scenario and `--output` to choose the results directory.
Use `--timeout` for a finite positive per-case timeout in seconds (default 180).
Run the runner's local CLI/failure-path tests with
`bun test runtime/local/formal/queue/check.test.ts`; these do not require TLC.

The runner includes both current-model checks and deliberate counterexamples
for earlier designs or scheduling limits. Success means each scenario produced
its expected result, not that every property holds for the runtime.

These are bounded, manually extracted models. They help reason about lifecycle
design; they do not prove the implementation, storage durability, or exactly-once
external effects. Model configurations and expected results live in
[`check.ts`](check.ts).
