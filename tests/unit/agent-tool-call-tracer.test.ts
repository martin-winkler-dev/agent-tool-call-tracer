import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    detectAgent,
    fillLog,
    findAgyStep,
    logFile,
    normalizeRoot,
    normalizeTool,
    readTranscript,
    type ToolCallRow,
    toRow,
    writeRow,
} from '../../hooks/agent-tool-call-tracer.js';

type Json = Record<string, unknown>;

const SCRIPT = join(import.meta.dir, '../../hooks/agent-tool-call-tracer.ts');
const NOW = new Date('2026-10-01T12:00:00.123Z');

let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-tool-call-tracer-'));
    file = join(dir, 'log', 'log.sqlite');
    process.env.AGENT_LOG_DB = file;
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function line(step: Json): string {
    return JSON.stringify(step);
}

function writeTranscript(logs: string, lines: string[]): string {
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'transcript_full.jsonl'), lines.map((text) => `${text}\n`).join(''));
    return join(logs, 'transcript_full.jsonl');
}

function rows(): Json[] {
    const db = new Database(file, { readonly: true });
    try {
        return db.query('SELECT * FROM tool_calls ORDER BY id').all() as Json[];
    } finally {
        db.close();
    }
}

// planner step 4 calls two view_file tools in parallel; results 5 and 6 are written out of order.
// step 3 is written as RUNNING first and rewritten as DONE.
const AGY_LINES = [
    line({ step_index: 3, type: 'RUN_COMMAND', status: 'RUNNING', content: 'partial' }),
    line({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'view_file' }, { name: 'view_file' }],
    }),
    line({ step_index: 6, type: 'VIEW_FILE', status: 'DONE', content: 'content of b' }),
    line({ step_index: 5, type: 'VIEW_FILE', status: 'DONE', content: 'content of a' }),
    line({ step_index: 3, type: 'RUN_COMMAND', status: 'DONE', exit_code: 3, content: 'x'.repeat(10_000) }),
];

function agyPayload(stepIdx: number | string, toolCall: Json, transcriptPath: string): Json {
    return {
        conversationId: 'conv-1',
        workspacePaths: [dir],
        transcriptPath,
        modelName: 'gemini-x',
        stepIdx,
        toolCall,
        error: '',
    };
}

describe('claude', () => {
    test('Bash success maps stdout, stderr and ids', () => {
        const row = toRow(
            'claude',
            {
                session_id: 's1',
                tool_use_id: 'toolu_1',
                prompt_id: 'p1',
                cwd: 'C:/elsewhere',
                hook_event_name: 'PostToolUse',
                permission_mode: 'default',
                tool_name: 'Bash',
                tool_input: { command: 'bun test', description: 'run tests' },
                tool_response: { stdout: 'ok', stderr: 'warn', interrupted: false, isImage: false },
            },
            { CLAUDE_PROJECT_DIR: dir },
            NOW,
        );
        expect(row).toMatchObject({
            ts: '2026-10-01T12:00:00.123Z',
            agent: 'claude',
            session_id: 's1',
            call_id: 'toolu_1',
            turn_id: 'p1',
            root: dir,
            tool_name: 'Bash',
            tool: 'shell',
            command: 'bun test',
            failed: 0,
            output: 'ok',
            stderr: 'warn',
            interrupted: 0,
            output_chars: 2,
        });
        expect(JSON.parse(row?.extra ?? '{}')).toEqual({
            cwd: 'C:/elsewhere',
            hook_event_name: 'PostToolUse',
            permission_mode: 'default',
        });
    });

    test('PostToolUseFailure sets failed, error and the exit code from the error text', () => {
        const row = toRow(
            'claude',
            {
                session_id: 's1',
                tool_use_id: 'toolu_2',
                cwd: dir,
                hook_event_name: 'PostToolUseFailure',
                tool_name: 'Bash',
                tool_input: { command: 'exit 3' },
                error: 'Exit code 3\nboom',
            },
            {},
            NOW,
        );
        expect(row).toMatchObject({ root: dir, failed: 1, error: 'Exit code 3\nboom', exit_code: 3, output: null });
    });

    test('an object response without stdout is stored as JSON', () => {
        const response = { type: 'text', file: { filePath: 'a.ts', content: 'x' } };
        const row = toRow(
            'claude',
            {
                session_id: 's1',
                tool_use_id: 't',
                cwd: dir,
                tool_name: 'Read',
                tool_input: { file_path: 'a.ts' },
                tool_response: response,
            },
            {},
            NOW,
        );
        expect(row).toMatchObject({ tool: 'read', file_path: 'a.ts', output: JSON.stringify(response) });
    });

    test('a plain string response is stored directly as output', () => {
        const row = toRow(
            'claude',
            { session_id: 's', tool_use_id: 't', cwd: dir, tool_name: 'Custom', tool_response: 'plain result text' },
            {},
            NOW,
        );
        expect(row).toMatchObject({ output: 'plain result text', output_chars: 17 });
    });

    test('NotebookEdit stores notebook_path as file_path', () => {
        const row = toRow(
            'claude',
            {
                session_id: 's',
                tool_use_id: 't',
                cwd: dir,
                tool_name: 'NotebookEdit',
                tool_input: { notebook_path: 'a.ipynb' },
            },
            {},
            NOW,
        );
        expect(row).toMatchObject({ tool: 'edit', file_path: 'a.ipynb' });
    });

    test('subagent calls keep agent_id and agent_type', () => {
        const row = toRow(
            'claude',
            { session_id: 's', tool_use_id: 't', cwd: dir, agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep' },
            {},
            NOW,
        );
        expect(row).toMatchObject({ subagent_id: 'a1', subagent_type: 'Explore', tool: 'grep' });
    });

    test('an empty or null error does not mark a call failed', () => {
        for (const error of [null, '']) {
            const row = toRow(
                'claude',
                { session_id: 's', tool_use_id: 't', cwd: dir, tool_name: 'Read', error },
                {},
                NOW,
            );
            expect(row).toMatchObject({ failed: 0, error: null });
        }
    });
});

describe('agy', () => {
    function log(payload: Json, now = NOW): void {
        writeRow(toRow('agy', payload, {}, NOW) as ToolCallRow, now);
    }

    test('the hook inserts the call without output, because AGY writes the result step afterwards', () => {
        const path = writeTranscript(join(dir, 'logs'), AGY_LINES.slice(0, 2));
        log(agyPayload(5, { name: 'view_file', args: { AbsolutePath: 'a.txt' } }, path));
        expect(rows()).toMatchObject([
            {
                agent: 'agy',
                session_id: 'conv-1',
                call_id: '5',
                model: 'gemini-x',
                tool: 'read',
                file_path: 'a.txt',
                failed: 0,
                error: null,
                output: null,
            },
        ]);
    });

    test('the next call fills earlier calls, each from its own result step', () => {
        const logs = join(dir, 'logs');
        const path = writeTranscript(logs, AGY_LINES.slice(0, 2));
        log(agyPayload(5, { name: 'view_file', args: { AbsolutePath: 'a.txt' } }, path));
        log(agyPayload(6, { name: 'view_file', args: { AbsolutePath: 'b.txt' } }, path));
        writeTranscript(logs, AGY_LINES);
        log(agyPayload('7', { name: 'list_dir', args: {} }, path));
        expect(rows()).toMatchObject([
            { call_id: '5', output: 'content of a', failed: 0 },
            { call_id: '6', output: 'content of b', failed: 0 },
            { call_id: '7', output: null },
        ]);
        expect(JSON.parse(String(rows()[0]?.extra))).toMatchObject({ step_type: 'VIEW_FILE', step_status: 'DONE' });
    });

    test('a RUNNING step stays pending until it is rewritten as DONE', () => {
        const logs = join(dir, 'logs');
        const path = writeTranscript(logs, AGY_LINES.slice(0, 1));
        log(agyPayload(3, { name: 'run_command', args: { CommandLine: 'exit 3' } }, path));
        log(agyPayload(9, { name: 'view_file', args: {} }, path));
        expect(rows()[0]).toMatchObject({ output: 'partial', exit_code: null, failed: 0 });
        writeTranscript(logs, AGY_LINES);
        log(agyPayload(10, { name: 'view_file', args: {} }, path));
        expect(rows()[0]).toMatchObject({ command: 'exit 3', exit_code: 3, failed: 1, output_chars: 10_000 });
    });

    test('a background task is marked BACKGROUND and still filled if AGY rewrites its step', () => {
        const logs = join(dir, 'logs');
        const started =
            'Created At: 2026-10-01T19:12:28+02:00\nTool is running as a background task with task id: c/task-3';
        const path = writeTranscript(logs, [
            line({ step_index: 3, type: 'RUN_COMMAND', status: 'RUNNING', content: started }),
        ]);
        log(agyPayload(3, { name: 'run_command', args: { CommandLine: 'bun dev' } }, path));
        log(agyPayload(9, { name: 'view_file', args: {} }, path));
        expect(JSON.parse(String(rows()[0]?.extra))).toMatchObject({ step_status: 'BACKGROUND' });
        expect(fillLog()).toEqual({ filled: 0, pending: 1, background: 1 });
        writeTranscript(logs, [
            line({ step_index: 3, type: 'RUN_COMMAND', status: 'DONE', content: 'The command exited with code 0' }),
        ]);
        expect(fillLog()).toEqual({ filled: 1, pending: 1, background: 0 });
        expect(rows()[0]).toMatchObject({ output: 'The command exited with code 0', exit_code: 0 });
    });

    test('a GENERIC run_command result gives its exit code in the content', () => {
        const content = 'Created At: x\n\nThe command exited with code 2.\nOutput:\nboom\n';
        const path = writeTranscript(join(dir, 'logs'), [
            line({ step_index: 8, type: 'GENERIC', status: 'DONE', content }),
        ]);
        log(agyPayload(8, { name: 'run_command', args: { CommandLine: 'false' } }, path));
        log(agyPayload(10, { name: 'view_file', args: {} }, path));
        expect(rows()[0]).toMatchObject({ exit_code: 2, failed: 1, output: content });
    });

    test('rows older than a day are no longer filled', () => {
        const logs = join(dir, 'logs');
        const path = writeTranscript(logs, []);
        log(agyPayload(5, { name: 'view_file', args: {} }, path));
        writeTranscript(logs, AGY_LINES);
        log(agyPayload(9, { name: 'view_file', args: {} }, path), new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
        expect(rows()[0]).toMatchObject({ output: null });
    });

    test('the planner step is never taken as a result', () => {
        expect(findAgyStep(AGY_LINES.join('\n'), 4)).toBeNull();
    });

    test('a partial last line is skipped', () => {
        expect(findAgyStep(`${AGY_LINES.join('\n')}\n{"step_index":5,"type":"VIEW`, 5)?.content).toBe('content of a');
    });

    test('readTranscript prefers transcript_full.jsonl and falls back to the given file', () => {
        const logs = join(dir, 'logs');
        writeTranscript(logs, ['full']);
        writeFileSync(join(logs, 'transcript.jsonl'), 'short');
        expect(readTranscript(join(logs, 'transcript.jsonl'))).toBe('full\n');
        writeFileSync(join(dir, 'transcript.jsonl'), 'short');
        expect(readTranscript(join(dir, 'transcript.jsonl'))).toBe('short');
        expect(readTranscript(join(dir, 'missing', 'transcript.jsonl'))).toBeNull();
    });

    test('error in the payload marks the call failed; file URIs become paths', () => {
        const row = toRow(
            'agy',
            {
                conversationId: 'c',
                workspacePaths: [pathToFileURL(dir).href],
                stepIdx: 1,
                toolCall: { name: 'run_command', args: {} },
                error: 'denied',
            },
            {},
            NOW,
        );
        expect(row).toMatchObject({ root: dir, failed: 1, error: 'denied' });
    });
});

describe('helpers', () => {
    test('normalizeTool maps tool names to categories, including both MCP prefixes', () => {
        expect(normalizeTool('PowerShell')).toBe('shell');
        expect(normalizeTool('multi_replace_file_content')).toBe('edit');
        expect(normalizeTool('mcp__github__get_pr')).toBe('mcp');
        expect(normalizeTool('mcp_github_get_pr')).toBe('mcp');
        expect(normalizeTool('ask_question')).toBe('other');
    });

    test('detectAgent prefers the flag, then the payload shape', () => {
        expect(detectAgent(['bun', 'x', '--agent', 'claude'], { conversationId: 'c' })).toBe('claude');
        expect(detectAgent([], { conversationId: 'c' })).toBe('agy');
        expect(detectAgent([], { session_id: 's' })).toBe('claude');
    });

    test('logFile defaults to the home folder', () => {
        expect(logFile({})).toBe(join(homedir(), '.agent-tool-call-tracer', 'log.sqlite'));
        expect(logFile({ AGENT_LOG_DB: file })).toBe(file);
    });

    test('normalizeRoot gives one spelling per repo', () => {
        expect(normalizeRoot('C:/git/x/')).toBe(normalizeRoot('C:\\git\\x'));
        if (process.platform === 'win32') {
            expect(normalizeRoot('c:/git/x')).toBe('C:\\git\\x');
        }
    });

    test('no root means no row', () => {
        expect(toRow('claude', { tool_name: 'Bash' }, {}, NOW)).toBeNull();
        expect(toRow('agy', { toolCall: { name: 'view_file', args: {} } }, {}, NOW)).toBeNull();
    });
});

describe('database', () => {
    test('writeRow creates the folders and ignores a repeated call', () => {
        const row = toRow('claude', { session_id: 's', tool_use_id: 't', cwd: dir, tool_name: 'Bash' }, {}, NOW);
        writeRow(row as ToolCallRow);
        writeRow({ ...(row as ToolCallRow), output: 'second' });
        expect(rows()).toMatchObject([{ call_id: 't', output: null }]);
        const db = new Database(file, { readonly: true });
        try {
            expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
        } finally {
            db.close();
        }
    });
});

describe('fill', () => {
    // one pending view_file row, logged two days ago, before its result step existed
    function logOld(): string {
        const logs = join(dir, 'logs');
        const path = writeTranscript(logs, AGY_LINES.slice(0, 2));
        const old = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
        const payload = agyPayload(5, { name: 'view_file', args: { AbsolutePath: 'a.txt' } }, path);
        writeRow(toRow('agy', payload, {}, old) as ToolCallRow, old);
        writeTranscript(logs, AGY_LINES);
        return path;
    }

    test('fillLog fills pending rows of any age and reports what is left', () => {
        logOld();
        expect(fillLog()).toEqual({ filled: 1, pending: 0, background: 0 });
        expect(rows()).toMatchObject([{ call_id: '5', output: 'content of a' }]);
        expect(fillLog()).toEqual({ filled: 0, pending: 0, background: 0 });
    });

    test('two fills at the same time fill each row once and both exit 0', async () => {
        logOld();
        function spawn() {
            return Bun.spawn(['bun', SCRIPT, '--fill'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
        }
        const runs = [spawn(), spawn()];
        const results = await Promise.all(
            runs.map(async (proc) => ({
                code: await proc.exited,
                stdout: await new Response(proc.stdout).text(),
                stderr: await new Response(proc.stderr).text(),
            })),
        );
        expect(results.map((result) => [result.code, result.stderr])).toEqual([
            [0, ''],
            [0, ''],
        ]);
        const filled = results.map((result) => Number(result.stdout.match(/filled (\d+)/)?.[1]));
        expect(filled.sort()).toEqual([0, 1]);
        expect(rows()).toMatchObject([{ call_id: '5', output: 'content of a' }]);
    });
});

describe('process', () => {
    function run(stdin: string, args: string[] = []) {
        const result = Bun.spawnSync(['bun', SCRIPT, ...args], {
            stdin: Buffer.from(stdin),
            env: { ...process.env, CLAUDE_PROJECT_DIR: '' },
        });
        return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    }

    test('malformed input exits 0 and prints nothing', () => {
        expect(run('not json', ['--agent', 'agy'])).toEqual({ code: 0, stdout: '', stderr: '' });
    });

    test('eight parallel claude calls on a new database are all logged without any output', async () => {
        const procs = Array.from({ length: 8 }, (_, i) =>
            Bun.spawn(['bun', SCRIPT, '--agent', 'claude'], {
                stdin: Buffer.from(
                    JSON.stringify({ session_id: 's', tool_use_id: `t${i}`, cwd: dir, tool_name: 'Bash' }),
                ),
                stdout: 'pipe',
                stderr: 'pipe',
                env: { ...process.env, CLAUDE_PROJECT_DIR: '' },
            }),
        );
        const results = await Promise.all(
            procs.map(async (proc) => ({
                code: await proc.exited,
                stdout: await new Response(proc.stdout).text(),
                stderr: await new Response(proc.stderr).text(),
            })),
        );
        expect(results).toEqual(Array(8).fill({ code: 0, stdout: '', stderr: '' }));
        expect(
            rows()
                .map((row) => row.call_id)
                .sort(),
        ).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
    }, 30_000);

    test('agy calls are logged and filled without any output', () => {
        const path = writeTranscript(join(dir, 'logs'), AGY_LINES);
        const first = agyPayload(5, { name: 'view_file', args: { AbsolutePath: 'a.txt' } }, path);
        const second = agyPayload(6, { name: 'view_file', args: { AbsolutePath: 'b.txt' } }, path);
        expect(run(JSON.stringify(first), ['--agent', 'agy'])).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(run(JSON.stringify(second), ['--agent', 'agy'])).toEqual({ code: 0, stdout: '', stderr: '' });
        // both results exist in the fixture, so the second call fills both rows
        expect(rows()).toMatchObject([
            { agent: 'agy', call_id: '5', output: 'content of a' },
            { agent: 'agy', call_id: '6', output: 'content of b' },
        ]);
    });
});
