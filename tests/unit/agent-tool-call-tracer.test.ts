import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    claudeTranscriptPath,
    detectAgent,
    fillLog,
    findAgyStep,
    handleClaudeStop,
    logFile,
    normalizeRoot,
    normalizeTool,
    parseClaudeModels,
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

// planner step 4 calls two read_file tools in parallel; results 5 and 6 are written out of order.
// step 3 is written as RUNNING first and rewritten as DONE.
const AGY_LINES = [
    line({ step_index: 3, type: 'GENERIC', status: 'RUNNING', content: 'partial' }),
    line({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file' }, { name: 'read_file' }],
    }),
    line({ step_index: 6, type: 'GENERIC', status: 'DONE', content: 'content of b' }),
    line({ step_index: 5, type: 'GENERIC', status: 'DONE', content: 'content of a' }),
    line({
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Command exited with code 3.\n'.padEnd(10_000, 'x'),
    }),
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
            exit_code: 0,
            output: 'ok',
            stderr: 'warn',
            interrupted: 0,
            output_chars: 2,
        });
        expect(JSON.parse(row?.extra ?? '{}')).toEqual({
            cwd: 'C:/elsewhere',
            hook_event_name: 'PostToolUse',
            permission_mode: 'default',
            bash_response: { isImage: false },
        });
    });

    test('interrupted, backgrounded and BashOutput shell calls leave exit_code null', () => {
        const interrupted = toRow(
            'claude',
            {
                session_id: 's1',
                tool_use_id: 't1',
                cwd: dir,
                hook_event_name: 'PostToolUse',
                tool_name: 'Bash',
                tool_input: { command: 'sleep 99' },
                tool_response: { stdout: '', stderr: '', interrupted: true },
            },
            {},
            NOW,
        );
        expect(interrupted).toMatchObject({ failed: 0, interrupted: 1, exit_code: null });

        const backgrounded = toRow(
            'claude',
            {
                session_id: 's1',
                tool_use_id: 't2',
                cwd: dir,
                hook_event_name: 'PostToolUse',
                tool_name: 'Bash',
                tool_input: { command: 'bun dev', run_in_background: true },
                tool_response: { stdout: 'started', stderr: '', interrupted: false, backgroundTaskId: 'bg1' },
            },
            {},
            NOW,
        );
        expect(backgrounded).toMatchObject({ failed: 0, interrupted: 0, exit_code: null });

        const bashOutput = toRow(
            'claude',
            {
                session_id: 's1',
                tool_use_id: 't3',
                cwd: dir,
                hook_event_name: 'PostToolUse',
                tool_name: 'BashOutput',
                tool_input: { bash_id: 'bg1' },
                tool_response: { stdout: 'line', stderr: '', interrupted: false },
            },
            {},
            NOW,
        );
        expect(bashOutput).toMatchObject({ tool: 'shell', failed: 0, exit_code: null });

        const nonZeroSuccess = toRow(
            'claude',
            {
                session_id: 's1',
                tool_use_id: 't4',
                cwd: dir,
                hook_event_name: 'PostToolUse',
                tool_name: 'Bash',
                tool_input: { command: 'grep missing a.txt' },
                tool_response: {
                    stdout: '',
                    stderr: '',
                    interrupted: false,
                    returnCodeInterpretation: 'No matches found',
                },
            },
            {},
            NOW,
        );
        expect(nonZeroSuccess).toMatchObject({ failed: 0, interrupted: 0, exit_code: null });
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

    test('parseClaudeModels maps tool_use ids to assistant models and skips partial lines', () => {
        const text = [
            line({ type: 'user', message: { role: 'user', content: 'hi' } }),
            line({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'claude-fable-5-2',
                    content: [
                        { type: 'text', text: 'checking' },
                        { type: 'tool_use', id: 'toolu_1', name: 'Read' },
                        { type: 'tool_use', id: 'toolu_2', name: 'Bash' },
                    ],
                },
            }),
            '{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[{"type":"tool_use","id":"toolu_cut',
        ].join('\n');
        expect(parseClaudeModels(text)).toEqual(
            new Map([
                ['toolu_1', 'claude-fable-5-2'],
                ['toolu_2', 'claude-fable-5-2'],
            ]),
        );
    });

    test('claudeTranscriptPath resolves main, direct subagent, nested subagent and flat subagent paths', () => {
        const projectDir = join(dir, 'project');
        const mainPath = join(projectDir, 'sess-1.jsonl');
        const nestedPath = join(projectDir, 'sess-1', 'subagents', 'agent-a1.jsonl');
        const flatPath = join(projectDir, 'agent-a2.jsonl');
        mkdirSync(join(projectDir, 'sess-1', 'subagents'), { recursive: true });
        writeFileSync(nestedPath, '');
        writeFileSync(flatPath, '');

        expect(claudeTranscriptPath(mainPath, 'sess-1', null)).toBe(mainPath);
        expect(claudeTranscriptPath(nestedPath, 'sess-1', 'a1')).toBe(nestedPath);
        expect(claudeTranscriptPath(mainPath, 'sess-1', 'a1')).toBe(nestedPath);
        expect(claudeTranscriptPath(mainPath, 'sess-1', 'a2')).toBe(flatPath);
    });

    test('SubagentStop stays scoped to its subagent while Stop and SessionEnd backfill the whole session', () => {
        const projectDir = join(dir, 'claude-proj');
        const mainPath = join(projectDir, 'sess-1.jsonl');
        const sub1Path = join(projectDir, 'sess-1', 'subagents', 'agent-sub1.jsonl');
        const sub2Path = join(projectDir, 'sess-1', 'subagents', 'agent-sub2.jsonl');
        mkdirSync(join(projectDir, 'sess-1', 'subagents'), { recursive: true });
        writeFileSync(
            mainPath,
            `${line({
                type: 'assistant',
                message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_main' }] },
            })}\n`,
        );
        writeFileSync(
            sub1Path,
            `${line({
                type: 'assistant',
                message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'toolu_sub1' }] },
            })}\n`,
        );
        writeFileSync(
            sub2Path,
            `${line({
                type: 'assistant',
                message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'toolu_sub2' }] },
            })}\n`,
        );

        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-1',
                    tool_use_id: 'toolu_main',
                    cwd: dir,
                    tool_name: 'Read',
                    transcript_path: mainPath,
                },
                {},
                NOW,
            ) as ToolCallRow,
        );
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-1',
                    tool_use_id: 'toolu_sub1',
                    agent_id: 'sub1',
                    agent_type: 'general-purpose',
                    cwd: dir,
                    tool_name: 'Bash',
                    transcript_path: mainPath,
                },
                {},
                NOW,
            ) as ToolCallRow,
        );
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-1',
                    tool_use_id: 'toolu_sub2',
                    agent_id: 'sub2',
                    agent_type: 'Explore',
                    cwd: dir,
                    tool_name: 'Grep',
                    transcript_path: mainPath,
                },
                {},
                NOW,
            ) as ToolCallRow,
        );

        expect(
            handleClaudeStop({
                hook_event_name: 'SubagentStop',
                session_id: 'sess-1',
                agent_id: 'sub1',
                agent_transcript_path: sub1Path,
            }),
        ).toBe(1);
        expect(rows()).toMatchObject([
            { call_id: 'toolu_main', model: null },
            { call_id: 'toolu_sub1', model: 'claude-haiku-5-5' },
            { call_id: 'toolu_sub2', model: null },
        ]);

        // main Stop catches both main rows and orphaned subagent rows whose SubagentStop did not fire
        expect(handleClaudeStop({ hook_event_name: 'Stop', session_id: 'sess-1', transcript_path: mainPath })).toBe(2);
        expect(rows()).toMatchObject([
            { call_id: 'toolu_main', model: 'claude-opus-5-5' },
            { call_id: 'toolu_sub1', model: 'claude-haiku-5-5' },
            { call_id: 'toolu_sub2', model: 'claude-sonnet-5-5' },
        ]);
    });

    test('chunked backward transcript reader resolves models across 256 KB boundaries with multi-byte UTF-8', () => {
        const mainPath = join(dir, 'large-claude.jsonl');
        const filler = 'äöüß🚀'.repeat(60_000);
        writeFileSync(
            mainPath,
            `${[
                line({
                    type: 'assistant',
                    message: { model: 'claude-old-5-0', content: [{ type: 'tool_use', id: 'toolu_early' }] },
                }),
                line({ type: 'user', message: { role: 'user', content: filler } }),
                line({
                    type: 'assistant',
                    message: { model: 'claude-new-5-5', content: [{ type: 'tool_use', id: 'toolu_tail' }] },
                }),
            ].join('\n')}\n`,
        );
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-big',
                    tool_use_id: 'toolu_early',
                    cwd: dir,
                    tool_name: 'Read',
                    transcript_path: mainPath,
                },
                {},
                NOW,
            ) as ToolCallRow,
        );
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-big',
                    tool_use_id: 'toolu_tail',
                    cwd: dir,
                    tool_name: 'Read',
                    transcript_path: mainPath,
                },
                {},
                NOW,
            ) as ToolCallRow,
        );
        expect(
            handleClaudeStop({ hook_event_name: 'SessionEnd', session_id: 'sess-big', transcript_path: mainPath }),
        ).toBe(2);
        expect(rows()).toMatchObject([
            { call_id: 'toolu_early', model: 'claude-old-5-0' },
            { call_id: 'toolu_tail', model: 'claude-new-5-5' },
        ]);
    });

    test('unresolvable Claude rows are marked model_missing and excluded from future scans', () => {
        const mainPath = join(dir, 'claude-missing.jsonl');
        writeFileSync(
            mainPath,
            `${line({
                type: 'assistant',
                message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'toolu_present' }] },
            })}\n`,
        );
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-m',
                    tool_use_id: 'toolu_present',
                    cwd: dir,
                    tool_name: 'Read',
                    transcript_path: mainPath,
                },
                {},
                NOW,
            ) as ToolCallRow,
        );
        // absent from the existing transcript (e.g. randomUUID fallback)
        writeRow(
            toRow(
                'claude',
                { session_id: 'sess-m', cwd: dir, tool_name: 'Read', transcript_path: mainPath },
                {},
                NOW,
            ) as ToolCallRow,
        );
        // no transcript_path recorded at all
        writeRow(
            toRow(
                'claude',
                { session_id: 'sess-no-path', tool_use_id: 'toolu_nopath', cwd: dir, tool_name: 'Read' },
                {},
                NOW,
            ) as ToolCallRow,
        );
        // stale row whose transcript file was deleted (>24h ago)
        const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000);
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-deleted',
                    tool_use_id: 'toolu_deleted',
                    cwd: dir,
                    tool_name: 'Read',
                    transcript_path: join(dir, 'deleted.jsonl'),
                },
                {},
                oldTs,
            ) as ToolCallRow,
        );

        expect(handleClaudeStop({ hook_event_name: 'Stop', session_id: 'sess-m', transcript_path: mainPath })).toBe(1);
        expect(fillLog()).toEqual({ filled: 0, pending: 0, background: 0 });
        expect(
            rows().map((r) => ({ model: r.model, missing: JSON.parse(String(r.extra ?? '{}')).model_missing })),
        ).toEqual([
            { model: 'claude-sonnet-5-5', missing: undefined },
            { model: null, missing: 1 },
            { model: null, missing: 1 },
            { model: null, missing: 1 },
        ]);
    });

    test('fresh Claude rows survive empty or unflushed transcripts on live Stop and fill once flushed', () => {
        const emptyPath = join(dir, 'claude-empty.jsonl');
        const lagPath = join(dir, 'claude-lag.jsonl');
        writeFileSync(emptyPath, '');
        writeFileSync(lagPath, `${line({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
        const fresh = new Date();
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-empty',
                    tool_use_id: 'toolu_e1',
                    cwd: dir,
                    tool_name: 'Read',
                    transcript_path: emptyPath,
                },
                {},
                fresh,
            ) as ToolCallRow,
        );
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 'sess-lag',
                    tool_use_id: 'toolu_l1',
                    cwd: dir,
                    tool_name: 'Read',
                    transcript_path: lagPath,
                },
                {},
                fresh,
            ) as ToolCallRow,
        );

        // live Stop misses both, but neither should be permanently locked out
        expect(
            handleClaudeStop({ hook_event_name: 'Stop', session_id: 'sess-empty', transcript_path: emptyPath }),
        ).toBe(0);
        expect(handleClaudeStop({ hook_event_name: 'Stop', session_id: 'sess-lag', transcript_path: lagPath })).toBe(0);

        writeFileSync(
            emptyPath,
            `${line({
                type: 'assistant',
                message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_e1' }] },
            })}\n`,
        );
        writeFileSync(
            lagPath,
            `${line({
                type: 'assistant',
                message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'toolu_l1' }] },
            })}\n`,
        );

        expect(
            handleClaudeStop({ hook_event_name: 'Stop', session_id: 'sess-empty', transcript_path: emptyPath }),
        ).toBe(1);
        expect(handleClaudeStop({ hook_event_name: 'Stop', session_id: 'sess-lag', transcript_path: lagPath })).toBe(1);
        expect(rows()).toMatchObject([
            { call_id: 'toolu_e1', model: 'claude-opus-5-5' },
            { call_id: 'toolu_l1', model: 'claude-haiku-5-5' },
        ]);
    });
});

describe('agy', () => {
    function log(payload: Json, now = NOW): void {
        writeRow(toRow('agy', payload, {}, NOW) as ToolCallRow, now);
    }

    test('the hook inserts the call without output, because AGY writes the result step afterwards', () => {
        const path = writeTranscript(join(dir, 'logs'), AGY_LINES);
        log(agyPayload(5, { name: 'read_file', args: { Path: 'a.txt' } }, path));
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

    test('chunked backward reader resolves AGY steps across 256 KB boundaries', () => {
        const logs = join(dir, 'logs-big');
        const filler = 'x'.repeat(600_000);
        const path = writeTranscript(logs, [
            line({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'early-step' }),
            line({ step_index: 2, type: 'GENERIC', status: 'DONE', content: filler }),
            line({ step_index: 3, type: 'GENERIC', status: 'DONE', content: 'tail-step' }),
        ]);
        log(agyPayload(1, { name: 'read_file', args: { Path: 'a.txt' } }, path));
        log(agyPayload(3, { name: 'read_file', args: { Path: 'b.txt' } }, path));
        log(agyPayload(4, { name: 'read_file', args: { Path: 'c.txt' } }, path));
        expect(rows()).toMatchObject([
            { call_id: '1', output: 'early-step' },
            { call_id: '3', output: 'tail-step' },
            { call_id: '4', output: null },
        ]);
    });

    test('live AGY backfill is scoped to the current conversation and capped at 2 MB while fillLog fills all', () => {
        const logsA = join(dir, 'logs-a');
        const pathA = writeTranscript(logsA, [
            line({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'from-conv-a' }),
        ]);
        const logsB = join(dir, 'logs-b');
        const huge = 'y'.repeat(2_200_000);
        const pathB = writeTranscript(logsB, [
            line({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'beyond-2mb' }),
            line({ step_index: 2, type: 'GENERIC', status: 'DONE', content: huge }),
            line({ step_index: 3, type: 'GENERIC', status: 'DONE', content: 'recent-b' }),
        ]);
        log({ ...agyPayload(1, { name: 'read_file', args: {} }, pathA), conversationId: 'conv-a' });
        log({ ...agyPayload(1, { name: 'read_file', args: {} }, pathB), conversationId: 'conv-b' });
        log({ ...agyPayload(3, { name: 'read_file', args: {} }, pathB), conversationId: 'conv-b' });
        log({ ...agyPayload(4, { name: 'read_file', args: {} }, pathB), conversationId: 'conv-b' });
        // conv-a was not touched by conv-b; conv-b step 1 is >2 MB back so live hook skipped it
        expect(rows()).toMatchObject([
            { session_id: 'conv-a', call_id: '1', output: null },
            { session_id: 'conv-b', call_id: '1', output: null },
            { session_id: 'conv-b', call_id: '3', output: 'recent-b' },
            { session_id: 'conv-b', call_id: '4', output: null },
        ]);
        expect(fillLog()).toEqual({ filled: 2, pending: 1, background: 0 });
        expect(rows()).toMatchObject([
            { session_id: 'conv-a', call_id: '1', output: 'from-conv-a' },
            { session_id: 'conv-b', call_id: '1', output: 'beyond-2mb' },
            { session_id: 'conv-b', call_id: '3', output: 'recent-b' },
            { session_id: 'conv-b', call_id: '4', output: null },
        ]);
    });

    test('live AGY backfill also fills parent and subagent conversations across handoffs', () => {
        const parentPath = writeTranscript(join(dir, 'logs-parent'), [
            line({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'spawned-subagent' }),
        ]);
        const childPath = writeTranscript(join(dir, 'logs-child'), [
            line({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'child-final-step' }),
        ]);
        // parent spawns subagent -> subagent's first tool call fills parent's pending call
        log({ ...agyPayload(1, { name: 'invoke_subagent', args: {} }, parentPath), conversationId: 'parent-1' });
        log({
            ...agyPayload(1, { name: 'read_file', args: {} }, childPath),
            conversationId: 'child-1',
            parentConversationId: 'parent-1',
        });
        expect(rows()).toMatchObject([
            { session_id: 'parent-1', call_id: '1', output: 'spawned-subagent' },
            { session_id: 'child-1', call_id: '1', output: null },
        ]);
        // subagent finishes -> parent's next tool call fills subagent's final call
        log({ ...agyPayload(2, { name: 'read_file', args: {} }, parentPath), conversationId: 'parent-1' });
        expect(rows()).toMatchObject([
            { session_id: 'parent-1', call_id: '1', output: 'spawned-subagent' },
            { session_id: 'child-1', call_id: '1', output: 'child-final-step' },
            { session_id: 'parent-1', call_id: '2', output: null },
        ]);
    });

    test('the next call fills earlier calls, each from its own result step', () => {
        const logs = join(dir, 'logs');
        const path = writeTranscript(logs, AGY_LINES.slice(0, 2));
        log(agyPayload(5, { name: 'read_file', args: { Path: 'a.txt' } }, path));
        log(agyPayload(6, { name: 'read_file', args: { Path: 'b.txt' } }, path));
        writeTranscript(logs, AGY_LINES);
        log(agyPayload('7', { name: 'read_file', args: {} }, path));
        expect(rows()).toMatchObject([
            { call_id: '5', output: 'content of a', failed: 0 },
            { call_id: '6', output: 'content of b', failed: 0 },
            { call_id: '7', output: null },
        ]);
        expect(JSON.parse(String(rows()[0]?.extra))).toMatchObject({ step_type: 'GENERIC', step_status: 'DONE' });
    });

    test('a RUNNING step stays pending until it is rewritten as DONE', () => {
        const logs = join(dir, 'logs');
        const path = writeTranscript(logs, AGY_LINES.slice(0, 1));
        log(agyPayload(3, { name: 'run_command', args: { CommandLine: 'exit 3' } }, path));
        log(agyPayload(9, { name: 'read_file', args: {} }, path));
        expect(rows()[0]).toMatchObject({ output: 'partial', exit_code: null, failed: 0 });
        writeTranscript(logs, AGY_LINES);
        log(agyPayload(10, { name: 'read_file', args: {} }, path));
        expect(rows()[0]).toMatchObject({ command: 'exit 3', exit_code: 3, failed: 1, output_chars: 10_000 });
    });

    test('a background task is marked BACKGROUND and only fillLog fills it if AGY rewrites its step', () => {
        const logs = join(dir, 'logs');
        const started =
            'Created At: 2026-10-01T19:12:28+02:00\nTool is running as a background task with task id: c/task-3';
        const path = writeTranscript(logs, [
            line({ step_index: 3, type: 'GENERIC', status: 'RUNNING', content: started }),
        ]);
        log(agyPayload(3, { name: 'run_command', args: { CommandLine: 'bun dev' } }, path));
        log(agyPayload(9, { name: 'read_file', args: {} }, path));
        expect(JSON.parse(String(rows()[0]?.extra))).toMatchObject({ step_status: 'BACKGROUND' });
        expect(fillLog()).toEqual({ filled: 0, pending: 1, background: 1 });
        writeTranscript(logs, [
            line({ step_index: 3, type: 'GENERIC', status: 'DONE', content: 'Command exited with code 0' }),
        ]);
        // the live hook skips BACKGROUND rows, so the next call does not read the rewritten step
        log(agyPayload(10, { name: 'read_file', args: {} }, path));
        expect(JSON.parse(String(rows()[0]?.extra))).toMatchObject({ step_status: 'BACKGROUND' });
        expect(fillLog()).toEqual({ filled: 1, pending: 2, background: 0 });
        expect(rows()[0]).toMatchObject({ output: 'Command exited with code 0', exit_code: 0 });
    });

    test('a run_command result gives its exit code in the content', () => {
        // the output itself may contain the same phrase; only the header line counts
        const content =
            'Created At: x\nCompleted At: x\nCommand exited with code 2.\n\nCommand output:\nCommand exited with code 0\n';
        const path = writeTranscript(join(dir, 'logs'), [
            line({ step_index: 8, type: 'GENERIC', status: 'DONE', content }),
        ]);
        log(agyPayload(8, { name: 'run_command', args: { CommandLine: 'false' } }, path));
        log(agyPayload(10, { name: 'read_file', args: {} }, path));
        expect(rows()[0]).toMatchObject({ exit_code: 2, failed: 1, output: content });
    });

    test('rows older than a day are no longer filled', () => {
        const logs = join(dir, 'logs');
        const path = writeTranscript(logs, []);
        log(agyPayload(5, { name: 'read_file', args: {} }, path));
        writeTranscript(logs, AGY_LINES);
        log(agyPayload(9, { name: 'read_file', args: {} }, path), new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
        expect(rows()[0]).toMatchObject({ output: null });
    });

    test('the planner step is never taken as a result', () => {
        expect(findAgyStep(AGY_LINES.join('\n'), 4)).toBeNull();
    });

    test('a partial last line is skipped', () => {
        expect(findAgyStep(`${AGY_LINES.join('\n')}\n{"step_index":5,"type":"GEN`, 5)?.content).toBe('content of a');
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

    test('without a workspace folder the call is kept with root <none>', () => {
        const row = toRow('agy', { toolCall: { name: 'read_file', args: { Path: join(dir, 'a.txt') } } }, {}, NOW);
        expect(row).toMatchObject({ root: '<none>', tool: 'read', file_path: join(dir, 'a.txt') });
    });

    test('a multi-root workspace picks the innermost folder that contains the file', () => {
        const outer = join(dir, 'outer');
        const inner = join(outer, 'inner');
        const other = join(dir, 'other');
        function rootOf(path: string | undefined): unknown {
            const args = path === undefined ? {} : { Path: path };
            const payload = { workspacePaths: [other, outer, inner], toolCall: { name: 'edit_file', args } };
            return toRow('agy', payload, {}, NOW)?.root;
        }
        expect(rootOf(join(inner, 'a.ts'))).toBe(normalizeRoot(inner));
        expect(rootOf(join(outer, 'a.ts'))).toBe(normalizeRoot(outer));
        // a sibling folder that shares the prefix is not inside the workspace folder
        expect(rootOf(`${outer}-x${sep}a.ts`)).toBe(normalizeRoot(other));
        expect(rootOf(undefined)).toBe(normalizeRoot(other));
        if (process.platform === 'win32') {
            expect(rootOf(join(inner, 'a.ts').toUpperCase())).toBe(normalizeRoot(inner));
        }
    });
});

describe('helpers', () => {
    test('normalizeTool maps tool names to categories, including both MCP prefixes', () => {
        expect(normalizeTool('PowerShell')).toBe('shell');
        expect(normalizeTool('edit_file')).toBe('edit');
        expect(normalizeTool('mcp__github__get_pr')).toBe('mcp');
        expect(normalizeTool('mcp_github_get_pr')).toBe('mcp');
        expect(normalizeTool('ask_question')).toBe('other');
    });

    test('detectAgent prefers the flag, then the payload shape', () => {
        expect(detectAgent(['bun', 'x', '--agent', 'claude'], { conversationId: 'c' })).toBe('claude');
        expect(detectAgent([], { conversationId: 'c' })).toBe('agy');
        expect(detectAgent([], { session_id: 's' })).toBe('claude');
    });

    test('logFile defaults to the home folder and resolves relative paths from home', () => {
        expect(logFile({})).toBe(join(homedir(), '.agent-tool-call-tracer', 'log.sqlite'));
        expect(logFile({ AGENT_LOG_DB: file })).toBe(file);
        expect(logFile({ AGENT_LOG_DB: 'logs/custom.sqlite' })).toBe(join(homedir(), 'logs', 'custom.sqlite'));
    });

    test('normalizeRoot gives one spelling per repo', () => {
        const repo = join(tmpdir(), 'x');
        expect(normalizeRoot(`${repo}/`)).toBe(normalizeRoot(repo));
        // Backslash and drive letters are path syntax on Windows only
        if (process.platform === 'win32') {
            expect(normalizeRoot('C:/git/x/')).toBe(normalizeRoot('C:\\git\\x'));
            expect(normalizeRoot('c:/git/x')).toBe('C:\\git\\x');
        }
    });

    test('a claude call without a root gives no row', () => {
        expect(toRow('claude', { tool_name: 'Bash' }, {}, NOW)).toBeNull();
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
    // one pending read_file row, logged two days ago, before its result step existed
    function logOld(): string {
        const logs = join(dir, 'logs');
        const path = writeTranscript(logs, AGY_LINES.slice(0, 2));
        const old = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
        const payload = agyPayload(5, { name: 'read_file', args: { Path: 'a.txt' } }, path);
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

    test('fillLog also backfills Claude Code models for main and subagent rows', () => {
        const projectDir = join(dir, 'claude-fill');
        const mainPath = join(projectDir, 's1.jsonl');
        const subPath = join(projectDir, 's1', 'subagents', 'agent-a1.jsonl');
        mkdirSync(join(projectDir, 's1', 'subagents'), { recursive: true });
        writeFileSync(
            mainPath,
            `${line({
                type: 'assistant',
                message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'toolu_m' }] },
            })}\n`,
        );
        writeFileSync(
            subPath,
            `${line({
                type: 'assistant',
                message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'toolu_s' }] },
            })}\n`,
        );
        writeRow(
            toRow(
                'claude',
                { session_id: 's1', tool_use_id: 'toolu_m', cwd: dir, tool_name: 'Read', transcript_path: mainPath },
                {},
                NOW,
            ) as ToolCallRow,
        );
        writeRow(
            toRow(
                'claude',
                {
                    session_id: 's1',
                    tool_use_id: 'toolu_s',
                    agent_id: 'a1',
                    cwd: dir,
                    tool_name: 'Bash',
                    transcript_path: mainPath,
                },
                {},
                NOW,
            ) as ToolCallRow,
        );

        expect(fillLog()).toEqual({ filled: 2, pending: 0, background: 0 });
        expect(rows()).toMatchObject([
            { call_id: 'toolu_m', model: 'claude-sonnet-5-5' },
            { call_id: 'toolu_s', model: 'claude-haiku-5-5' },
        ]);
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

    test('malformed input exits 0, prints nothing and is logged to errors.log', () => {
        expect(run('not json', ['--agent', 'agy'])).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(readFileSync(join(dir, 'log', 'errors.log'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT.*SyntaxError/);
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
        const first = agyPayload(5, { name: 'read_file', args: { Path: 'a.txt' } }, path);
        const second = agyPayload(6, { name: 'read_file', args: { Path: 'b.txt' } }, path);
        expect(run(JSON.stringify(first), ['--agent', 'agy'])).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(run(JSON.stringify(second), ['--agent', 'agy'])).toEqual({ code: 0, stdout: '', stderr: '' });
        // the second call fills the earlier pending call and skips itself
        expect(rows()).toMatchObject([
            { agent: 'agy', call_id: '5', output: 'content of a' },
            { agent: 'agy', call_id: '6', output: null },
        ]);
    });

    test('claude Stop hook fills models without inserting a row or printing output', () => {
        const transcriptPath = join(dir, 'sess-stop.jsonl');
        writeFileSync(
            transcriptPath,
            `${line({
                type: 'assistant',
                message: { model: 'claude-fable-5-2', content: [{ type: 'tool_use', id: 'toolu_9' }] },
            })}\n`,
        );
        const toolPayload = {
            session_id: 'sess-stop',
            tool_use_id: 'toolu_9',
            cwd: dir,
            hook_event_name: 'PostToolUse',
            tool_name: 'Read',
            transcript_path: transcriptPath,
        };
        const stopPayload = {
            session_id: 'sess-stop',
            hook_event_name: 'Stop',
            transcript_path: transcriptPath,
        };
        expect(run(JSON.stringify(toolPayload), ['--agent', 'claude'])).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(rows()).toMatchObject([{ call_id: 'toolu_9', model: null }]);
        expect(run(JSON.stringify(stopPayload), ['--agent', 'claude'])).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(rows()).toHaveLength(1);
        expect(rows()).toMatchObject([{ call_id: 'toolu_9', model: 'claude-fable-5-2' }]);
    });
});
