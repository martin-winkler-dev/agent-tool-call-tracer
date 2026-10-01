# Agent Tool Call Tracer

[![Test](https://github.com/martin-winkler-dev/agent-tool-call-tracer/actions/workflows/test.yml/badge.svg)](https://github.com/martin-winkler-dev/agent-tool-call-tracer/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.0-black?logo=bun)](https://bun.sh)

A plugin for
- **Claude Code** and
- **Google Antigravity 2.0 (AGY)**
that logs every agent's tool call into a local SQLite database.

- **Pass-through:** the hook never changes any tool call.
- **Requirement:** written in TypeScript and requires `bun` 1.3 or later on the `PATH`.
- **Database:** `~/.agent-tool-call-tracer/log.sqlite`; (`AGENT_LOG_DB` environment variable overrides this)
- **Sensitive data:** the database stores the raw tool inputs and outputs, so it can contain secrets such as tokens, passwords and file contents.

## How to Install

### Antigravity 2.0 (AGY)

**Global Install via Reference**: from `~/.gemini/config/plugins.json` reference the folder that contains your `agent-tool-call-tracer` clone.

```json
{
  "entries": [
    { "path": "<path that contains agent-tool-call-tracer clone>", "include_only": ["agent-tool-call-tracer"] }
  ]
}
```

**Global Install directly**: clone the repository to `~/.gemini/config/plugins/agent-tool-call-tracer`.

**Workspace Install**: clone the repository to `<workspace-root>/.agents/plugins/agent-tool-call-tracer`.

### Claude Code

**Global Install** (all projects):

*Via slash command:*

```text
/plugin marketplace add martin-winkler-dev/agent-tool-call-tracer
/plugin install agent-tool-call-tracer@agent-tool-call-tracer
```

*Via terminal:*

```bash
claude plugin marketplace add martin-winkler-dev/agent-tool-call-tracer
claude plugin install agent-tool-call-tracer@agent-tool-call-tracer
```

**Workspace Install** (current project only):

*Via slash command:*

```text
/plugin marketplace add martin-winkler-dev/agent-tool-call-tracer --scope project
/plugin install agent-tool-call-tracer@agent-tool-call-tracer --scope project
```

*Via terminal:*

```bash
claude plugin marketplace add martin-winkler-dev/agent-tool-call-tracer --scope project
claude plugin install agent-tool-call-tracer@agent-tool-call-tracer --scope project
```

*(Note: `--scope project` is the literal flag that saves to `.claude/settings.json`. Use `--scope local` if you prefer keeping settings untracked in `.claude/settings.local.json`)*

## Database

```sql
CREATE TABLE tool_calls (
    id                INTEGER PRIMARY KEY,
    ts                TEXT NOT NULL,     -- ISO 8601 UTC with ms, when the hook ran
    agent             TEXT NOT NULL,     -- 'claude' | 'agy'
    session_id        TEXT NOT NULL,     -- claude session_id | agy conversationId
    call_id           TEXT NOT NULL,     -- claude tool_use_id | agy stepIdx
    turn_id           TEXT,              -- claude prompt_id | agy executionId (calls of one user prompt)
    parent_session_id TEXT,              -- agy parentConversationId
    subagent_id       TEXT,              -- claude agent_id
    subagent_type     TEXT,              -- claude agent_type | agy agentName
    model             TEXT,              -- agy modelName
    root              TEXT NOT NULL,     -- repo root, one spelling per repo, e.g. C:\git\repo
    tool_name         TEXT NOT NULL,     -- raw name: Bash, PowerShell, run_command, mcp__x__y, ...
    tool              TEXT NOT NULL,     -- shell | read | edit | write | grep | glob | web | agent | mcp | other
    command           TEXT,              -- shell command line
    file_path         TEXT,              -- target of a read, edit or write
    failed            INTEGER NOT NULL,  -- 0 | 1
    error             TEXT,
    exit_code         INTEGER,
    interrupted       INTEGER,           -- claude Bash
    output            TEXT,              -- full result, no cap
    stderr            TEXT,              -- claude Bash
    output_chars      INTEGER,
    input             TEXT NOT NULL,     -- full tool input as JSON
    extra             TEXT,              -- remaining payload fields as JSON (agy: step_type, step_status)
    UNIQUE (agent, session_id, call_id)
);
```

The database uses WAL mode, so reading it while agents run is safe.

## Repository layout

```text
agent-tool-call-tracer/
├── .claude-plugin/
│   ├── marketplace.json              # Claude Code - marketplace, lists the plugin at ./
│   └── plugin.json                   # Claude Code - plugin manifest
├── plugin.json                       # Antigravity - plugin manifest
├── hooks.json                        # Antigravity - hooks (sync)
├── hooks/
│   ├── hooks.json                    # Claude Code - hooks (async)
│   └── agent-tool-call-tracer.ts     # script
├── tests/
│   ├── types/
│   │   └── agent-tool-call-tracer.test-d.ts
│   └── unit/
│       └── agent-tool-call-tracer.test.ts
├── LICENSE                           # Apache-2.0
├── package.json                      # dev tooling only
├── biome.jsonc
├── bunfig.toml
└── tsconfig.json
```

## How the agents differ

- **Claude Code** sends the tool result in the hook payload. A failed call arrives as `PostToolUseFailure`, so the plugin registers both events. Claude reports no exit code; for a failed Bash call the hook parses it from the error text (`Exit code N`). Hook commands resolve paths via `${CLAUDE_PLUGIN_ROOT}`.
- **Antigravity** waits for the hook and denies the tool on any stdout or a non-zero exit. It writes the tool result to its transcript only after the hook returns, so each AGY row is inserted with `output` NULL and filled by the next AGY tool call, for up to 24 hours. Antigravity has no plugin-root variable; by specification, it sets the hook process working directory to the directory containing `hooks.json` (the plugin root), so relative script paths (`hooks/...`) resolve deterministically.

### Filling missing AGY output

Before an analysis, fill every pending AGY row, with no age limit:

```bash
bun run fill
```

`bun run fill` works inside the clone; from anywhere else run `bun <plugin folder>/hooks/agent-tool-call-tracer.ts --fill`, which fills Antigravity rows only, because Claude Code rows are complete when they are inserted.

It prints the rows filled, the rows still pending, and the background tasks without a final result. A command that AGY moves to the background keeps its transcript step at `RUNNING`; such a row gets `step_status = 'BACKGROUND'` in `extra` and the "running as a background task" notice as `output`. If AGY later rewrites the step as `DONE`, the next fill stores the real output.


### Example queries

```sql
-- calls per repo and agent
SELECT root, agent, count(*) AS calls, sum(failed) AS failed FROM tool_calls GROUP BY root, agent;

-- tool mix per agent
SELECT agent, tool, count(*) AS calls FROM tool_calls GROUP BY agent, tool ORDER BY agent, calls DESC;

-- JSON fields
SELECT id, ts, tool_name, extra ->> '$.step_status' AS status FROM tool_calls WHERE agent = 'agy' ORDER BY id DESC;
```

## Development

```bash
bun install
bun run check      # lint, typecheck, tests
bun run lint:fix   # Biome safe fixes
```

## License

Apache License 2.0, see [LICENSE](LICENSE).
