#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import {
    appendFileSync,
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Key-value record representing arbitrary JSON objects. */
type Json = Record<string, unknown>;

/** Supported agent execution runtimes. */
export type Agent = 'claude' | 'agy';

/** Normalized SQLite schema record capturing a single tool invocation across supported agents. */
export type ToolCallRow = {
    ts: string;
    agent: Agent;
    session_id: string;
    call_id: string;
    turn_id: string | null;
    parent_session_id: string | null;
    subagent_id: string | null;
    subagent_type: string | null;
    model: string | null;
    root: string;
    tool_name: string;
    tool: string;
    command: string | null;
    file_path: string | null;
    failed: 0 | 1;
    error: string | null;
    exit_code: number | null;
    interrupted: 0 | 1 | null;
    output: string | null;
    stderr: string | null;
    output_chars: number | null;
    input: string;
    extra: string | null;
};

/** Single step record parsed from Antigravity transcript JSONL files. */
export type AgyStep = {
    step_index: number;
    type?: string;
    status?: string;
    content?: string;
    error?: string;
};

/** Subset of tool_calls queried during Antigravity transcript backfill operations. */
type PendingRow = { id: number; call_id: string; tool_name: string; error: string | null; extra: string | null };

/** Subset of tool_calls queried during Claude Code model backfill operations. */
type ClaudePendingRow = {
    id: number;
    ts: string;
    session_id: string;
    subagent_id: string | null;
    call_id: string;
    extra: string | null;
};

/** Scope limiting a Claude Code model backfill to a single session or subagent. */
export type ClaudeBackfillScope = {
    sessionId: string;
    subagentId?: string | null | undefined;
    transcriptPath: string | null;
};

/** Status counters for resolved, pending, and background tasks after a transcript fill. */
export type FillResult = { filled: number; pending: number; background: number };

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** SQLite schema version tracked in PRAGMA user_version. */
const SCHEMA_VERSION = 4;

/** Maximum time window (24h) in milliseconds for resolving missing transcript steps. */
const AGY_BACKFILL_MS = 24 * 60 * 60 * 1000;

/** Chunk size in bytes when reading transcript JSONL files backwards from the tail. */
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;

/** Maximum bytes scanned from the tail during a blocking live AGY backfill. */
const AGY_LIVE_MAX_BYTES = 2 * 1024 * 1024;

/** Grace period (10 min) before live Claude Stop hooks mark an unfound row as model_missing. */
const CLAUDE_MISSING_GRACE_MS = 10 * 60 * 1000;

/** Matches leading lowercase drive letters in absolute Windows file paths. */
const MATCH_WINDOWS_DRIVE_PREFIX = /^[a-z]:/;

/** Parses exit code number from Claude Code error messages. */
const MATCH_CLAUDE_EXIT_CODE = /^Exit code (\d+)/;

/** Parses exit code number from the header line of Antigravity run_command step outputs. */
const MATCH_AGY_GENERIC_EXIT_CODE = /^Command exited with code (-?\d+)/m;

/** Identifies Antigravity output indicating task handoff to a background process. */
const MATCH_AGY_BACKGROUND = /^(?:Created At: .*\n)?Tool is running as a background task with task id: /;

/** Maps raw agent tool identifiers to normalized taxonomy categories. */
const TOOLS: Record<string, string> = {
    Bash: 'shell',
    PowerShell: 'shell',
    BashOutput: 'shell',
    run_command: 'shell',
    Read: 'read',
    read_file: 'read',
    Edit: 'edit',
    MultiEdit: 'edit',
    NotebookEdit: 'edit',
    edit_file: 'edit',
    Write: 'write',
    write_file: 'write',
    Grep: 'grep',
    Glob: 'glob',
    WebFetch: 'web',
    WebSearch: 'web',
    search_web: 'web',
    Agent: 'agent',
    Task: 'agent',
    invoke_subagent: 'agent',
};

/** Claude Code payload properties mapped directly to columns and excluded from extra JSON. */
const CLAUDE_MAPPED = [
    'session_id',
    'tool_use_id',
    'prompt_id',
    'agent_id',
    'agent_type',
    'tool_name',
    'tool_input',
    'tool_response',
    'error',
    'is_interrupt',
] as const;

/** Claude Code Bash response properties mapped directly to columns; the rest is kept as bash_response in extra JSON. */
const BASH_MAPPED = ['stdout', 'stderr', 'interrupted'] as const;

/** Antigravity payload properties mapped directly to columns and excluded from extra JSON. */
const AGY_MAPPED = [
    'conversationId',
    'stepIdx',
    'executionId',
    'parentConversationId',
    'agentName',
    'modelName',
    'toolCall',
    'error',
] as const;

/** SQL condition matching Antigravity tool calls awaiting final transcript results. */
const AGY_PENDING = `agent = 'agy' AND (json_extract(extra, '$.step_status') IS NULL OR json_extract(extra, '$.step_status') IN ('RUNNING', 'BACKGROUND'))`;

/** SQL condition matching Claude Code tool calls awaiting model resolution from transcripts. */
const CLAUDE_PENDING = `agent = 'claude' AND model IS NULL AND json_extract(extra, '$.model_missing') IS NULL`;

/** SQLite table and index definitions with composite keys and partial indexes. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    turn_id TEXT,
    parent_session_id TEXT,
    subagent_id TEXT,
    subagent_type TEXT,
    model TEXT,
    root TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool TEXT NOT NULL,
    command TEXT,
    file_path TEXT,
    failed INTEGER NOT NULL,
    error TEXT,
    exit_code INTEGER,
    interrupted INTEGER,
    output TEXT,
    stderr TEXT,
    output_chars INTEGER,
    input TEXT NOT NULL,
    extra TEXT,
    UNIQUE (agent, session_id, call_id)
);
CREATE INDEX IF NOT EXISTS tool_calls_session ON tool_calls(agent, session_id, ts);
CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls(tool, ts);
CREATE INDEX IF NOT EXISTS tool_calls_root ON tool_calls(root, ts);
DROP INDEX IF EXISTS tool_calls_agy_pending;
CREATE INDEX tool_calls_agy_pending ON tool_calls(ts) WHERE ${AGY_PENDING};
DROP INDEX IF EXISTS tool_calls_claude_pending;
CREATE INDEX tool_calls_claude_pending ON tool_calls(session_id, subagent_id, ts) WHERE ${CLAUDE_PENDING};
`;

/** Ordered column names matching tool_calls table schema for prepared insert parameters. */
const COLUMNS = [
    'ts',
    'agent',
    'session_id',
    'call_id',
    'turn_id',
    'parent_session_id',
    'subagent_id',
    'subagent_type',
    'model',
    'root',
    'tool_name',
    'tool',
    'command',
    'file_path',
    'failed',
    'error',
    'exit_code',
    'interrupted',
    'output',
    'stderr',
    'output_chars',
    'input',
    'extra',
] as const satisfies readonly (keyof ToolCallRow)[];

/** Pre-compiled parameterized SQL statement for inserting or ignoring tool call records. */
const INSERT_TOOL_CALL_SQL = `INSERT OR IGNORE INTO tool_calls (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/** Resolves SQLite database path from AGENT_LOG_DB override (relative paths resolve from home) or default. */
export function logFile(env: Record<string, string | undefined>): string {
    const custom = str(env.AGENT_LOG_DB);
    return custom !== null ? resolve(homedir(), custom) : join(homedir(), '.agent-tool-call-tracer', 'log.sqlite');
}

/** Standardizes repository paths across platforms, capitalizing Windows drive prefixes. */
export function normalizeRoot(path: string): string {
    const full = resolve(path);
    return MATCH_WINDOWS_DRIVE_PREFIX.test(full) ? full[0].toUpperCase() + full.slice(1) : full;
}

/** Maps raw tool identifier to unified taxonomy category or 'mcp' for MCP tools. */
export function normalizeTool(name: string): string {
    if (name.startsWith('mcp_')) {
        return 'mcp';
    }
    return TOOLS[name] ?? 'other';
}

/**
 * **Parses Claude Code hook payload into normalized row**.
 *
 * - extracts command line, target file, stdout, stderr, and interrupt state
 * - recovers exit codes from bash error messages
 * - moves unmapped payload attributes into extra JSON
 *
 * @returns Normalized row, or null if repository root cannot be determined.
 */
export function fromClaude(payload: Json, env: Record<string, string | undefined>, now: Date): ToolCallRow | null {
    const root = str(env.CLAUDE_PROJECT_DIR) ?? str(payload.cwd);
    if (root === null) {
        return null;
    }
    const toolName = str(payload.tool_name) ?? 'unknown';
    const input = obj(payload.tool_input);
    const response = payload.tool_response;
    const error = str(payload.error);
    const failed = payload.hook_event_name === 'PostToolUseFailure' || error !== null;
    let output: string | null = null;
    let stderr: string | null = null;
    let interrupted: 0 | 1 | null = payload.is_interrupt === true ? 1 : null;
    let extraSource = payload;
    let shellCompleted = false;
    if (typeof response === 'string') {
        output = response;
    } else if (response !== undefined && response !== null) {
        const fields = obj(response);
        if (typeof fields.stdout === 'string') {
            output = fields.stdout;
            stderr = str(fields.stderr);
            interrupted = fields.interrupted === true ? 1 : 0;
            shellCompleted =
                !failed &&
                (toolName === 'Bash' || toolName === 'PowerShell') &&
                interrupted === 0 &&
                input.run_in_background !== true &&
                str(fields.backgroundTaskId) === null &&
                str(fields.returnCodeInterpretation) === null;
            const rest = without(fields, BASH_MAPPED);
            if (Object.keys(rest).length > 0) {
                extraSource = { ...payload, bash_response: rest };
            }
        } else {
            output = JSON.stringify(response);
        }
    }
    const exitMatch = error?.match(MATCH_CLAUDE_EXIT_CODE);
    const exitCode = exitMatch ? Number(exitMatch[1]) : shellCompleted ? 0 : null;
    return {
        ts: now.toISOString(),
        agent: 'claude',
        session_id: str(payload.session_id) ?? 'unknown',
        call_id: str(payload.tool_use_id) ?? crypto.randomUUID(),
        turn_id: str(payload.prompt_id),
        parent_session_id: null,
        subagent_id: str(payload.agent_id),
        subagent_type: str(payload.agent_type),
        model: null,
        root: normalizeRoot(root),
        tool_name: toolName,
        tool: normalizeTool(toolName),
        command: str(input.command),
        file_path: str(input.file_path) ?? str(input.notebook_path),
        failed: failed ? 1 : 0,
        error,
        exit_code: exitCode,
        interrupted,
        output,
        stderr,
        output_chars: output?.length ?? null,
        input: JSON.stringify(input),
        extra: omit(extraSource, CLAUDE_MAPPED),
    };
}

/** Reads transcript content, prioritizing transcript_full.jsonl over truncated transcript.jsonl. */
export function readTranscript(transcriptPath: string): string | null {
    try {
        const path = agyTranscriptPath(transcriptPath);
        return path !== null ? readFileSync(path, 'utf8') : null;
    } catch {
        return null;
    }
}

/**
 * **Extracts latest non-planner step matching step index**.
 *
 * - searches backward from end of transcript to obtain final status updates
 * - ignores intermediate planner steps matching the same index
 * - handles incomplete lines during concurrent write operations
 *
 * @returns Step object, or null if no valid entry exists.
 */
export function findAgyStep(text: string, stepIdx: number): AgyStep | null {
    const needle = `{"step_index":${stepIdx},`;
    let pos = text.length;
    while (pos >= 0) {
        const at = text.lastIndexOf(needle, pos);
        if (at < 0) {
            return null;
        }
        if (at === 0 || text[at - 1] === '\n') {
            const end = text.indexOf('\n', at);
            try {
                const step = JSON.parse(text.slice(at, end < 0 ? undefined : end)) as AgyStep;
                if (step.type !== 'PLANNER_RESPONSE') {
                    return step;
                }
            } catch {}
        }
        pos = at - 1;
    }
    return null;
}

/**
 * **Parses Antigravity hook payload into initial pending row**.
 *
 * - picks the workspace folder containing the target file, or '<none>' without a workspace
 * - extracts command line and target file arguments
 * - sets output to null pending subsequent transcript completion
 */
export function fromAgy(payload: Json, now: Date): ToolCallRow {
    const call = obj(payload.toolCall);
    const args = obj(call.args);
    const workspaces: unknown[] = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
    const filePath = toPath(args.Path);
    const toolName = str(call.name) ?? 'unknown';
    const error = str(payload.error);
    return {
        ts: now.toISOString(),
        agent: 'agy',
        session_id: str(payload.conversationId) ?? 'unknown',
        call_id: str(payload.stepIdx) ?? crypto.randomUUID(),
        turn_id: str(payload.executionId),
        parent_session_id: str(payload.parentConversationId),
        subagent_id: null,
        subagent_type: str(payload.agentName),
        model: str(payload.modelName),
        root: pickRoot(workspaces, filePath) ?? '<none>',
        tool_name: toolName,
        tool: normalizeTool(toolName),
        command: str(args.CommandLine),
        file_path: filePath,
        failed: error === null ? 0 : 1,
        error,
        exit_code: null,
        interrupted: null,
        output: null,
        stderr: null,
        output_chars: null,
        input: JSON.stringify(args),
        extra: omit(payload, AGY_MAPPED),
    };
}

/** Identifies agent platform from explicit CLI flag or heuristic inspection of payload keys. */
export function detectAgent(argv: readonly string[], payload: Json): Agent {
    const flag = argv.indexOf('--agent');
    const named = flag >= 0 ? argv[flag + 1] : undefined;
    if (named === 'claude' || named === 'agy') {
        return named;
    }
    return 'conversationId' in payload || 'toolCall' in payload ? 'agy' : 'claude';
}

/** Dispatches payload to agent-specific parser generating a normalized row. */
export function toRow(
    agent: Agent,
    payload: Json,
    env: Record<string, string | undefined>,
    now = new Date(),
): ToolCallRow | null {
    return agent === 'agy' ? fromAgy(payload, now) : fromClaude(payload, env, now);
}

/**
 * **Synchronizes pending Antigravity rows with transcript outputs**.
 *
 * - reads transcript files backwards outside the write transaction to prevent lock contention
 * - extracts exit codes and execution failure indicators from completed steps
 * - updates pending records within an immediate database transaction
 * - on the live hook path (since/sessionId set), skips BACKGROUND rows, scopes to the current conversation
 *   and its parent/child subagent conversations, and caps the tail scan to `AGY_LIVE_MAX_BYTES`
 */
export function backfillAgy(
    db: Database,
    since: string | null,
    sessionId?: string,
    parentSessionId?: string | null,
): number {
    const filter =
        since !== null ? `${AGY_PENDING} AND json_extract(extra, '$.step_status') IS NOT 'BACKGROUND'` : AGY_PENDING;
    const pending =
        sessionId !== undefined
            ? (db
                  .query(
                      `SELECT id, call_id, tool_name, error, extra FROM tool_calls INDEXED BY tool_calls_agy_pending WHERE ${filter} AND ts >= ? AND (session_id = ? OR parent_session_id = ? OR (? IS NOT NULL AND session_id = ?))`,
                  )
                  .all(
                      since ?? '',
                      sessionId,
                      sessionId,
                      parentSessionId ?? null,
                      parentSessionId ?? null,
                  ) as PendingRow[])
            : (db
                  .query(
                      `SELECT id, call_id, tool_name, error, extra FROM tool_calls INDEXED BY tool_calls_agy_pending WHERE ${filter} AND ts >= ?`,
                  )
                  .all(since ?? '') as PendingRow[]);
    if (pending.length === 0) {
        return 0;
    }
    const items: { row: PendingRow; extra: Json; transcriptPath: string; stepIdx: number }[] = [];
    const neededByPath = new Map<string, Set<number>>();
    for (const row of pending) {
        let extra: Json = {};
        if (row.extra) {
            try {
                extra = obj(JSON.parse(row.extra));
            } catch {
                extra = {};
            }
        }
        const transcriptPath = toPath(extra.transcriptPath);
        const stepIdx = Number(row.call_id);
        if (transcriptPath === null || !Number.isInteger(stepIdx)) {
            continue;
        }
        items.push({ row, extra, transcriptPath, stepIdx });
        let needed = neededByPath.get(transcriptPath);
        if (needed === undefined) {
            needed = new Set();
            neededByPath.set(transcriptPath, needed);
        }
        needed.add(stepIdx);
    }
    const maxBytes = sessionId !== undefined ? AGY_LIVE_MAX_BYTES : undefined;
    const stepsByPath = new Map<string, Map<number, AgyStep>>();
    for (const [transcriptPath, needed] of neededByPath) {
        stepsByPath.set(transcriptPath, readAgySteps(transcriptPath, needed, maxBytes));
    }
    const updates: (string | number | null)[][] = [];
    for (const { row, extra, transcriptPath, stepIdx } of items) {
        const step = stepsByPath.get(transcriptPath)?.get(stepIdx) ?? null;
        if (step === null) {
            continue;
        }
        const output = str(step.content);
        const status =
            step.status === 'RUNNING' && MATCH_AGY_BACKGROUND.test(output ?? '')
                ? 'BACKGROUND'
                : (step.status ?? 'DONE');
        if ((status === 'RUNNING' || status === 'BACKGROUND') && extra.step_status === status) {
            continue;
        }
        const exitCode = agyExitCode(step, row.tool_name);
        const error = row.error ?? str(step.error);
        const failed = error !== null || step.status === 'ERROR' || (exitCode !== null && exitCode !== 0);
        updates.push([
            output,
            output?.length ?? null,
            exitCode,
            failed ? 1 : 0,
            error,
            JSON.stringify({ ...extra, step_type: step.type, step_status: status }),
            row.id,
        ]);
    }
    if (updates.length === 0) {
        return 0;
    }
    const update = db.query(
        `UPDATE tool_calls SET output = ?, output_chars = ?, exit_code = ?, failed = ?, error = ?, extra = ? WHERE id = ? AND ${AGY_PENDING}`,
    );
    return db
        .transaction(() => updates.reduce((filled, values) => filled + update.run(...values).changes, 0))
        .immediate();
}

/**
 * **Maps Claude Code tool_use ids to the model that emitted them**.
 *
 * - skips lines without a tool_use block before parsing JSON
 * - ignores partial or malformed lines at the tail of an active transcript
 */
export function parseClaudeModels(text: string): Map<string, string> {
    const models = new Map<string, string>();
    parseClaudeModelsInto(text, models);
    return models;
}

/**
 * **Resolves the Claude Code transcript JSONL file for a session or subagent**.
 *
 * - returns main session transcript directly when subagentId is null
 * - returns transcriptPath directly when it already points to the subagent transcript
 * - checks `<dir>/<sessionId>/subagents/agent-<subagentId>.jsonl`, then `<dir>/agent-<subagentId>.jsonl`
 */
export function claudeTranscriptPath(transcriptPath: string, sessionId: string, subagentId: string | null): string {
    if (subagentId === null) {
        return transcriptPath;
    }
    const fileName = `agent-${subagentId}.jsonl`;
    if (transcriptPath.endsWith(fileName)) {
        return transcriptPath;
    }
    const baseDir = dirname(transcriptPath);
    const nested = join(baseDir, sessionId, 'subagents', fileName);
    if (existsSync(nested)) {
        return nested;
    }
    const flat = join(baseDir, fileName);
    if (existsSync(flat)) {
        return flat;
    }
    return nested;
}

/**
 * **Backfills missing Claude Code model names from session and subagent transcripts**.
 *
 * - reads each referenced transcript file backwards in chunks until all needed call_ids are found
 * - marks rows `extra.model_missing = 1` when unresolvable (no transcript path, absent after a full scan
 *   of an existing transcript, or missing transcript older than 24h during `--fill`)
 * - updates only rows that still have model IS NULL inside an immediate transaction
 */
export function backfillClaude(db: Database, scope?: ClaudeBackfillScope): number {
    let pending: ClaudePendingRow[];
    if (scope && scope.subagentId !== undefined) {
        pending = db
            .query(
                `SELECT id, ts, session_id, subagent_id, call_id, extra FROM tool_calls INDEXED BY tool_calls_claude_pending WHERE ${CLAUDE_PENDING} AND session_id = ? AND subagent_id IS ?`,
            )
            .all(scope.sessionId, scope.subagentId) as ClaudePendingRow[];
    } else if (scope) {
        pending = db
            .query(
                `SELECT id, ts, session_id, subagent_id, call_id, extra FROM tool_calls INDEXED BY tool_calls_claude_pending WHERE ${CLAUDE_PENDING} AND session_id = ?`,
            )
            .all(scope.sessionId) as ClaudePendingRow[];
    } else {
        pending = db
            .query(
                `SELECT id, ts, session_id, subagent_id, call_id, extra FROM tool_calls INDEXED BY tool_calls_claude_pending WHERE ${CLAUDE_PENDING}`,
            )
            .all() as ClaudePendingRow[];
    }
    if (pending.length === 0) {
        return 0;
    }
    const items: { row: ClaudePendingRow; path: string }[] = [];
    const neededByPath = new Map<string, Set<string>>();
    const missingIds: number[] = [];
    for (const row of pending) {
        let basePath = scope?.transcriptPath ?? null;
        if (basePath === null && row.extra) {
            try {
                basePath = toPath(obj(JSON.parse(row.extra)).transcript_path);
            } catch {
                basePath = null;
            }
        }
        if (basePath === null) {
            missingIds.push(row.id);
            continue;
        }
        const path = claudeTranscriptPath(basePath, row.session_id, row.subagent_id);
        items.push({ row, path });
        let needed = neededByPath.get(path);
        if (needed === undefined) {
            needed = new Set();
            neededByPath.set(path, needed);
        }
        needed.add(row.call_id);
    }
    const transcripts = new Map<string, { models: Map<string, string>; exists: boolean; exhausted: boolean }>();
    for (const [path, needed] of neededByPath) {
        transcripts.set(path, readClaudeModels(path, needed));
    }
    const updates: [string, number][] = [];
    const nowMs = Date.now();
    const graceCutoff = nowMs - CLAUDE_MISSING_GRACE_MS;
    const staleCutoff = nowMs - AGY_BACKFILL_MS;
    for (const { row, path } of items) {
        const result = transcripts.get(path);
        const model = result?.models.get(row.call_id);
        if (model !== undefined) {
            updates.push([model, row.id]);
        } else if (
            (result?.exhausted && (scope === undefined || Date.parse(row.ts) < graceCutoff)) ||
            (!result?.exists && scope === undefined && Date.parse(row.ts) < staleCutoff)
        ) {
            missingIds.push(row.id);
        }
    }
    if (updates.length === 0 && missingIds.length === 0) {
        return 0;
    }
    const updateModel = db.query(`UPDATE tool_calls SET model = ? WHERE id = ? AND model IS NULL`);
    const markMissing = db.query(
        `UPDATE tool_calls SET extra = json_set(coalesce(extra, '{}'), '$.model_missing', 1) WHERE id = ? AND model IS NULL`,
    );
    return db
        .transaction(() => {
            const filled = updates.reduce((count, values) => count + updateModel.run(...values).changes, 0);
            for (const id of missingIds) {
                markMissing.run(id);
            }
            return filled;
        })
        .immediate();
}

/** Handles Claude Code Stop, SubagentStop and SessionEnd payloads by backfilling pending models. */
export function handleClaudeStop(payload: Json, file = logFile(process.env)): number {
    const sessionId = str(payload.session_id);
    if (sessionId === null) {
        return 0;
    }
    const isSubagent = payload.hook_event_name === 'SubagentStop';
    const subagentId = isSubagent ? str(payload.agent_id) : undefined;
    if (isSubagent && subagentId === null) {
        return 0;
    }
    const transcriptPath =
        (isSubagent ? toPath(payload.agent_transcript_path) : null) ?? toPath(payload.transcript_path);
    const db = openDb(file);
    try {
        return backfillClaude(db, { sessionId, subagentId, transcriptPath });
    } finally {
        db.close();
    }
}

/** Persists normalized row into database and triggers backfill for earlier Antigravity calls in related conversations. */
export function writeRow(row: ToolCallRow, now = new Date(), file = logFile(process.env)): void {
    const db = openDb(file);
    try {
        if (row.agent === 'agy') {
            backfillAgy(
                db,
                new Date(now.getTime() - AGY_BACKFILL_MS).toISOString(),
                row.session_id,
                row.parent_session_id,
            );
        }
        db.query(INSERT_TOOL_CALL_SQL).run(...COLUMNS.map((column) => row[column]));
    } finally {
        db.close();
    }
}

/** Backfills all historical pending Antigravity and Claude Code rows without age constraints. */
export function fillLog(file = logFile(process.env)): FillResult {
    const db = openDb(file);
    try {
        const filled = backfillAgy(db, null) + backfillClaude(db);
        const { pending: agyPending, background } = db
            .query(
                `SELECT count(*) AS pending, count(*) FILTER (WHERE json_extract(extra, '$.step_status') = 'BACKGROUND') AS background
                 FROM tool_calls INDEXED BY tool_calls_agy_pending WHERE ${AGY_PENDING}`,
            )
            .get() as { pending: number; background: number };
        const { pending: claudePending } = db
            .query(
                `SELECT count(*) AS pending FROM tool_calls INDEXED BY tool_calls_claude_pending WHERE ${CLAUDE_PENDING}`,
            )
            .get() as { pending: number };
        return { filled, pending: agyPending - background + claudePending, background };
    } finally {
        db.close();
    }
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

/** Coerces truthy input to string or returns null. */
function str(value: unknown): string | null {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return typeof value === 'string' ? value : String(value);
}

/** Validates record object type or returns empty fallback object. */
function obj(value: unknown): Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

/** Copies record properties omitting matched exclusion keys. */
function without(payload: Json, keys: readonly string[]): Json {
    const rest: Json = {};
    for (const key of Object.keys(payload)) {
        if (!keys.includes(key)) {
            rest[key] = payload[key];
        }
    }
    return rest;
}

/** Serializes remaining properties to JSON string omitting matched exclusion keys. */
function omit(payload: Json, keys: readonly string[]): string | null {
    const rest = without(payload, keys);
    return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
}

/** Converts file URI strings or filesystem paths to native filesystem path. */
function toPath(value: unknown): string | null {
    const path = str(value);
    if (path === null) {
        return null;
    }
    try {
        return path.startsWith('file:') ? fileURLToPath(path) : path;
    } catch {
        return null;
    }
}

/**
 * **Picks the workspace folder that contains the target file**.
 *
 * - compares case-insensitively on Windows and on a path separator boundary
 * - prefers the longest match, so nested workspace folders resolve to the innermost one
 *
 * @returns Normalized workspace root, the first workspace without a match, or null without workspaces.
 */
function pickRoot(workspaces: unknown[], filePath: string | null): string | null {
    const roots = workspaces
        .map(toPath)
        .filter((path): path is string => path !== null)
        .map(normalizeRoot);
    if (filePath !== null && roots.length > 1) {
        const target = foldCase(normalizeRoot(filePath));
        let best: string | null = null;
        for (const root of roots) {
            const folded = foldCase(root);
            const prefix = folded.endsWith(sep) ? folded : `${folded}${sep}`;
            if ((target === folded || target.startsWith(prefix)) && (best === null || root.length > best.length)) {
                best = root;
            }
        }
        if (best !== null) {
            return best;
        }
    }
    return roots[0] ?? null;
}

/** Lowercases paths on Windows, where the file system ignores case. */
function foldCase(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** Extracts numeric process exit code from command console output. */
function agyExitCode(step: AgyStep, toolName: string): number | null {
    const match = toolName === 'run_command' ? step.content?.match(MATCH_AGY_GENERIC_EXIT_CODE) : null;
    return match ? Number(match[1]) : null;
}

/**
 * **Opens SQLite database connection configuring WAL mode and busy timeout**.
 *
 * - ensures parent directory exists
 * - applies WAL journal mode (retried, see enableWal) and NORMAL synchronicity
 * - executes DDL migrations when user_version is behind SCHEMA_VERSION, inside an immediate
 *   transaction that re-checks the version, so parallel first calls migrate exactly once
 */
function openDb(file: string): Database {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    db.run('PRAGMA busy_timeout = 5000');
    enableWal(db);
    db.run('PRAGMA synchronous = NORMAL');
    if (schemaVersion(db) < SCHEMA_VERSION) {
        db.transaction(() => {
            if (schemaVersion(db) < SCHEMA_VERSION) {
                db.run(SCHEMA);
                db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            }
        }).immediate();
    }
    return db;
}

/** Switches to WAL, retrying on SQLITE_BUSY because SQLite skips the busy handler while another process changes the journal mode. */
function enableWal(db: Database): void {
    for (let attempt = 1; ; attempt++) {
        try {
            db.run('PRAGMA journal_mode = WAL');
            return;
        } catch (error) {
            if ((error as { code?: string }).code !== 'SQLITE_BUSY' || attempt === 100) {
                throw error;
            }
            Bun.sleepSync(20);
        }
    }
}

/** Reads the schema version stored in PRAGMA user_version. */
function schemaVersion(db: Database): number {
    return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** Resolves the existing Antigravity transcript path, preferring transcript_full.jsonl. */
function agyTranscriptPath(transcriptPath: string): string | null {
    const full = join(dirname(transcriptPath), 'transcript_full.jsonl');
    if (existsSync(full)) {
        return full;
    }
    return existsSync(transcriptPath) ? transcriptPath : null;
}

/**
 * **Reads a UTF-8 JSONL file backwards in chunks along newline boundaries**.
 *
 * - splits strictly on `0x0a` bytes so multi-byte UTF-8 sequences never split across chunks
 * - buffers chunks of lines larger than one chunk in an array and concatenates once (linear time)
 * - stops early when `onChunk` returns true or `maxBytes` has been scanned
 * - returns true only when the full file was read cleanly to byte 0 without stopping early
 */
function readLinesBackwards(path: string, onChunk: (text: string) => boolean, maxBytes?: number): boolean {
    let fd: number;
    try {
        fd = openSync(path, 'r');
    } catch {
        return false;
    }
    try {
        let offset = fstatSync(fd).size;
        let scanned = 0;
        let pendingChunks: Buffer<ArrayBufferLike>[] = [];
        while (offset > 0) {
            if (maxBytes !== undefined && scanned >= maxBytes) {
                return false;
            }
            const length = Math.min(TRANSCRIPT_CHUNK_BYTES, offset);
            offset -= length;
            scanned += length;
            const chunk = Buffer.allocUnsafe(length);
            let bytesRead = 0;
            while (bytesRead < length) {
                const n = readSync(fd, chunk, bytesRead, length - bytesRead, offset + bytesRead);
                if (n <= 0) {
                    return false;
                }
                bytesRead += n;
            }
            const slice = chunk.subarray(0, bytesRead);
            if (offset > 0) {
                const firstNl = slice.indexOf(0x0a);
                if (firstNl < 0) {
                    pendingChunks.push(slice);
                    continue;
                }
                const tail = slice.subarray(firstNl + 1);
                const combined = pendingChunks.length > 0 ? Buffer.concat([tail, ...pendingChunks.reverse()]) : tail;
                pendingChunks = [slice.subarray(0, firstNl)];
                if (onChunk(combined.toString('utf8'))) {
                    return false;
                }
            } else {
                const combined = pendingChunks.length > 0 ? Buffer.concat([slice, ...pendingChunks.reverse()]) : slice;
                return !onChunk(combined.toString('utf8'));
            }
        }
        return false;
    } catch {
        return false;
    } finally {
        closeSync(fd);
    }
}

/** Reads the latest non-planner Antigravity steps for the given indices from the transcript tail. */
function readAgySteps(transcriptPath: string, needed: ReadonlySet<number>, maxBytes?: number): Map<number, AgyStep> {
    const found = new Map<number, AgyStep>();
    const path = agyTranscriptPath(transcriptPath);
    if (path === null) {
        return found;
    }
    readLinesBackwards(
        path,
        (text) => {
            for (const stepIdx of needed) {
                if (!found.has(stepIdx)) {
                    const step = findAgyStep(text, stepIdx);
                    if (step !== null) {
                        found.set(stepIdx, step);
                    }
                }
            }
            return found.size === needed.size;
        },
        maxBytes,
    );
    return found;
}

/** Parses Claude Code tool_use model mappings from text into an existing map. */
function parseClaudeModelsInto(text: string, models: Map<string, string>): void {
    for (const line of text.split('\n')) {
        if (!line.includes('"tool_use"')) {
            continue;
        }
        try {
            const entry = obj(JSON.parse(line));
            const message = obj(entry.message);
            if (entry.type !== 'assistant' && message.role !== 'assistant') {
                continue;
            }
            const model = str(message.model);
            if (model === null || !Array.isArray(message.content)) {
                continue;
            }
            for (const block of message.content) {
                const item = obj(block);
                const id = item.type === 'tool_use' ? str(item.id) : null;
                if (id !== null && !models.has(id)) {
                    models.set(id, model);
                }
            }
        } catch {
            // partial last line while the agent is still writing
        }
    }
}

/** Reads and parses model mappings from a Claude Code transcript file, scanning backwards until all needed ids are found. */
function readClaudeModels(
    path: string,
    needed: ReadonlySet<string>,
): { models: Map<string, string>; exists: boolean; exhausted: boolean } {
    const models = new Map<string, string>();
    if (!existsSync(path) || statSync(path).size === 0) {
        return { models, exists: false, exhausted: false };
    }
    const exhausted = readLinesBackwards(path, (text) => {
        parseClaudeModelsInto(text, models);
        for (const id of needed) {
            if (!models.has(id)) {
                return false;
            }
        }
        return true;
    });
    return { models, exists: true, exhausted };
}

/** Reads hook payload from standard input and commits normalized row or runs stop backfill. */
async function main(): Promise<void> {
    const payload = obj(JSON.parse(await Bun.stdin.text()));
    const agent = detectAgent(process.argv, payload);
    if (
        agent === 'claude' &&
        (payload.hook_event_name === 'Stop' ||
            payload.hook_event_name === 'SubagentStop' ||
            payload.hook_event_name === 'SessionEnd')
    ) {
        handleClaudeStop(payload);
        return;
    }
    const row = toRow(agent, payload, process.env);
    if (row !== null) {
        writeRow(row);
    }
}

if (import.meta.main && process.argv.includes('--fill')) {
    const { filled, pending, background } = fillLog();
    console.log(
        `${logFile(process.env)}: filled ${filled}, still pending ${pending}, background tasks without a final result ${background}`,
    );
} else if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        // stdout, stderr and the exit code stay clean, because hook runners treat any of them as a hook error
        try {
            const errors = join(dirname(logFile(process.env)), 'errors.log');
            mkdirSync(dirname(errors), { recursive: true });
            const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
            appendFileSync(errors, `${new Date().toISOString()} ${text}\n`);
        } catch {}
    }
    process.exit(0);
}
