# Architectural Considerations & Future Enhancements

**Target File**: [`hooks/agent-tool-call-tracer.ts`](../hooks/agent-tool-call-tracer.ts)  
**Status**: All core optimizations, concurrency guards, and defensive hardening are fully implemented.

The following items represent architectural trade-offs and future considerations:

---

## 1. Test Suite Layout & Subprocess Instrumentation

- **Test Colocation vs. Separation**:
  Subprocess tests (`describe('process')` and `describe('fill')`) currently run inside [`tests/unit/agent-tool-call-tracer.test.ts`](../tests/unit/agent-tool-call-tracer.test.ts). Per testing setup conventions, moving process-spawning tests to `tests/integration/` would cleanly separate pure unit tests from end-to-end process tests.
- **Coverage Instrumentation Across Process Boundaries**:
  CLI entrypoints executed via `Bun.spawn` (such as `main()` CLI branches) run in separate OS processes and are not instrumented by `bun test --coverage` (accounting for the remaining ~4.9% uncovered lines). Adding programmatic in-process test harnesses would allow 100% coverage reporting if required.

---

## 2. Agent Payload Schema Evolution

- **Claude Code Exit Code Extraction**:
  Claude Code does not provide structured exit codes in `PostToolUseFailure`. The tracer parses it heuristically from stderr/error text (`Exit code (\d+)`). If Claude Code changes its error format in future versions, this heuristic will need updating.
- **AGY Background Task Transcript Lag**:
  Antigravity hook events execute before result steps are written to disk. The deferred backfill mechanism (`backfillAgy`) fills pending rows on subsequent tool calls or via `bun run fill`. For workflows with thousands of rapid subagent tool calls, monitoring transcript seek latency via `findAgyStep` should be benchmarked at scale.

---

## 3. Data Retention & Maintenance

- **SQLite Database Pruning**:
  Currently, records in `~/.agent-tool-call-tracer/log.sqlite` are retained indefinitely. While SQLite with WAL mode handles hundreds of thousands of rows effortlessly, adding an optional pruning or archiving CLI flag (e.g. `bun hooks/agent-tool-call-tracer.ts --prune <days>`) would be a useful utility for long-running workstations.
