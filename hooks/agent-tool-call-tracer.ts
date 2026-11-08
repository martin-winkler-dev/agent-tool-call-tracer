#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

/** Status counters for resolved, pending, and background tasks after a transcript fill. */
export type FillResult = { filled: number; pending: number; background: number };

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** SQLite schema version tracked in PRAGMA user_version. */
const SCHEMA_VERSION = 2;

/** Maximum time window (24h) in milliseconds for resolving missing transcript steps. */
const AGY_BACKFILL_MS = 24 * 60 * 60 * 1000;

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

/** Resolves SQLite database path from AGENT_LOG_DB override or user home directory default. */
export function logFile(env: Record<string, string | undefined>): string {
    return str(env.AGENT_LOG_DB) ?? join(homedir(), '.agent-tool-call-tracer', 'log.sqlite');
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
    if (typeof response === 'string') {
        output = response;
    } else if (response !== undefined && response !== null) {
        const fields = obj(response);
        if (typeof fields.stdout === 'string') {
            output = fields.stdout;
            stderr = str(fields.stderr);
            interrupted = fields.interrupted === true ? 1 : 0;
            const rest = without(fields, BASH_MAPPED);
            if (Object.keys(rest).length > 0) {
                extraSource = { ...payload, bash_response: rest };
            }
        } else {
            output = JSON.stringify(response);
        }
    }
    const exitMatch = error?.match(MATCH_CLAUDE_EXIT_CODE);
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
        exit_code: exitMatch ? Number(exitMatch[1]) : null,
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
        const full = join(dirname(transcriptPath), 'transcript_full.jsonl');
        if (existsSync(full)) {
            return readFileSync(full, 'utf8');
        }
        return existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : null;
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
 * - reads transcript files outside the write transaction to prevent lock contention
 * - extracts exit codes and execution failure indicators from completed steps
 * - updates pending records within an immediate database transaction
 * - skips BACKGROUND rows on the live hook path (since set), because AGY never rewrites their step
 */
export function backfillAgy(db: Database, since: string | null): number {
    const filter =
        since !== null ? `${AGY_PENDING} AND json_extract(extra, '$.step_status') IS NOT 'BACKGROUND'` : AGY_PENDING;
    const pending = db
        .query(
            `SELECT id, call_id, tool_name, error, extra FROM tool_calls INDEXED BY tool_calls_agy_pending WHERE ${filter} AND ts >= ?`,
        )
        .all(since ?? '') as PendingRow[];
    const transcripts = new Map<string, string | null>();
    const updates: (string | number | null)[][] = [];
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
        if (!transcripts.has(transcriptPath)) {
            transcripts.set(transcriptPath, readTranscript(transcriptPath));
        }
        const text = transcripts.get(transcriptPath);
        const step = text ? findAgyStep(text, stepIdx) : null;
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

/** Persists normalized row into database and triggers backfill for recent Antigravity calls. */
export function writeRow(row: ToolCallRow, now = new Date(), file = logFile(process.env)): void {
    const db = openDb(file);
    try {
        db.query(INSERT_TOOL_CALL_SQL).run(...COLUMNS.map((column) => row[column]));
        if (row.agent === 'agy') {
            backfillAgy(db, new Date(now.getTime() - AGY_BACKFILL_MS).toISOString());
        }
    } finally {
        db.close();
    }
}

/** Backfills all historical pending Antigravity rows without age constraints. */
export function fillLog(file = logFile(process.env)): FillResult {
    const db = openDb(file);
    try {
        const filled = backfillAgy(db, null);
        const { pending, background } = db
            .query(
                `SELECT count(*) AS pending, count(*) FILTER (WHERE json_extract(extra, '$.step_status') = 'BACKGROUND') AS background
                 FROM tool_calls INDEXED BY tool_calls_agy_pending WHERE ${AGY_PENDING}`,
            )
            .get() as { pending: number; background: number };
        return { filled, pending: pending - background, background };
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

/** Reads hook payload from standard input and commits normalized row. */
async function main(): Promise<void> {
    const payload = obj(JSON.parse(await Bun.stdin.text()));
    const row = toRow(detectAgent(process.argv, payload), payload, process.env);
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
