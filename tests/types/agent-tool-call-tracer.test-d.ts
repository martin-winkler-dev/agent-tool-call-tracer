import type { Agent, AgyStep, FillResult, ToolCallRow } from '../../hooks/agent-tool-call-tracer.js';

export type Expect<T extends true> = T;
export type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// 1. Agent type must be exactly 'claude' | 'agy'
export type TestAgent = Expect<Equal<Agent, 'claude' | 'agy'>>;

// 2. FillResult structure
export type TestFillResult = Expect<Equal<FillResult, { filled: number; pending: number; background: number }>>;

// 3. ToolCallRow field assertions
export type TestRowAgent = Expect<Equal<ToolCallRow['agent'], Agent>>;
export type TestRowFailed = Expect<Equal<ToolCallRow['failed'], 0 | 1>>;
export type TestRowInterrupted = Expect<Equal<ToolCallRow['interrupted'], 0 | 1 | null>>;

// 4. AgyStep structure
export type TestAgyStepIndex = Expect<Equal<AgyStep['step_index'], number>>;
