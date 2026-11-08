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
    root              TEXT NOT NULL,     -- repo root, one spelling per repo, e.g. C:\git\repo, or '<none>' without a workspace
    tool_name         TEXT NOT NULL,     -- raw name: Bash, PowerShell, Read, run_command, read_file, edit_file, write_file, mcp__x__y, ...
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
    extra             TEXT,              -- remaining payload fields as JSON (claude: bash_response; agy: step_type, step_status)
    UNIQUE (agent, session_id, call_id)
);
```

The database uses WAL mode, so you can read it while agents run.

Calls the hook could not log are listed in `errors.log` next to the database.

## Antigravity output arrives one call later

Antigravity writes a tool's result only after the hook has run. Each AGY row therefore starts with `output` NULL and is filled by the next AGY tool call, for up to 24 hours. Claude Code rows are complete right away.

Before an analysis, fill every pending AGY row, with no age limit:

```bash
bun <plugin folder>/hooks/agent-tool-call-tracer.ts --fill
```

Inside a clone of this repository, `bun run fill` does the same.

It prints the rows filled, the rows still pending, and the background tasks without a final result. A command that AGY runs in the background has `step_status = 'BACKGROUND'` in `extra` and keeps the "running as a background task" notice as `output`.

## Example queries

```sql
-- calls per repo and agent
SELECT root, agent, count(*) AS calls, sum(failed) AS failed FROM tool_calls GROUP BY root, agent;

-- tool mix per agent
SELECT agent, tool, count(*) AS calls FROM tool_calls GROUP BY agent, tool ORDER BY agent, calls DESC;

-- JSON fields
SELECT id, ts, tool_name, extra ->> '$.step_status' AS status FROM tool_calls WHERE agent = 'agy' ORDER BY id DESC;
```

## License

Apache License 2.0, see [LICENSE](LICENSE).
