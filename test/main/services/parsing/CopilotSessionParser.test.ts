/**
 * Tests for CopilotSessionParser — validates conversion of Copilot CLI events.jsonl
 * into the ParsedMessage[] format used by ChunkBuilder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CopilotSessionParser } from '@main/services/parsing/CopilotSessionParser';

// =============================================================================
// Test Fixtures
// =============================================================================

function buildEvent(type: string, data: Record<string, unknown>, overrides?: Partial<{
  id: string;
  timestamp: string;
  parentId: string | null;
}>): string {
  return JSON.stringify({
    type,
    data,
    id: overrides?.id ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: overrides?.timestamp ?? '2026-04-01T10:00:00.000Z',
    parentId: overrides?.parentId ?? null,
  });
}

const SESSION_START = buildEvent('session.start', {
  sessionId: 'test-session-id',
  version: 1,
  producer: 'copilot-agent',
  copilotVersion: '1.0.7',
  startTime: '2026-04-01T10:00:00.000Z',
  context: {
    cwd: '/home/user/project',
    gitRoot: '/home/user/project',
    branch: 'main',
    repository: 'user/project',
  },
  alreadyInUse: false,
}, { id: 'start-1', timestamp: '2026-04-01T10:00:00.000Z' });

const USER_MESSAGE = buildEvent('user.message', {
  content: 'Hello, help me with this code',
  transformedContent: '<current_datetime>2026-04-01T10:00:05.000Z</current_datetime>\n\nHello, help me with this code',
  attachments: [],
  interactionId: 'interaction-1',
}, { id: 'user-1', timestamp: '2026-04-01T10:00:05.000Z', parentId: 'start-1' });

const ASSISTANT_MESSAGE_TEXT_ONLY = buildEvent('assistant.message', {
  messageId: 'msg-1',
  content: 'Sure, I can help with that!',
  toolRequests: [],
  interactionId: 'interaction-1',
}, { id: 'assistant-1', timestamp: '2026-04-01T10:00:10.000Z', parentId: 'user-1' });

const ASSISTANT_MESSAGE_WITH_TOOLS = buildEvent('assistant.message', {
  messageId: 'msg-2',
  content: 'Let me look at the code.',
  toolRequests: [
    {
      toolCallId: 'tool-call-1',
      name: 'view',
      arguments: { path: '/home/user/project/src/index.ts' },
      type: 'function',
      intentionSummary: 'view the index file',
    },
    {
      toolCallId: 'tool-call-2',
      name: 'grep',
      arguments: { pattern: 'TODO', path: '/home/user/project' },
      type: 'function',
    },
  ],
  interactionId: 'interaction-1',
}, { id: 'assistant-2', timestamp: '2026-04-01T10:00:15.000Z', parentId: 'user-1' });

const TOOL_COMPLETE_1 = buildEvent('tool.execution_complete', {
  toolCallId: 'tool-call-1',
  model: 'claude-sonnet-4',
  interactionId: 'interaction-1',
  success: true,
  result: {
    content: 'File contents here...',
    detailedContent: 'const x = 1;\nconst y = 2;',
  },
  toolTelemetry: {},
}, { id: 'tool-complete-1', timestamp: '2026-04-01T10:00:16.000Z' });

const TOOL_COMPLETE_2 = buildEvent('tool.execution_complete', {
  toolCallId: 'tool-call-2',
  model: 'claude-sonnet-4',
  interactionId: 'interaction-1',
  success: true,
  result: {
    content: 'No matches found',
  },
  toolTelemetry: {},
}, { id: 'tool-complete-2', timestamp: '2026-04-01T10:00:17.000Z' });

const TOOL_COMPLETE_ERROR = buildEvent('tool.execution_complete', {
  toolCallId: 'tool-call-1',
  model: 'claude-sonnet-4',
  interactionId: 'interaction-1',
  success: false,
  result: {
    content: 'File not found',
  },
  toolTelemetry: {},
}, { id: 'tool-complete-err', timestamp: '2026-04-01T10:00:16.000Z' });

const SUBAGENT_STARTED = buildEvent('subagent.started', {
  toolCallId: 'task-call-1',
  agentName: 'explore',
  agentDisplayName: 'Explore Agent',
  agentDescription: 'Fast codebase exploration',
}, { id: 'sub-start-1', timestamp: '2026-04-01T10:00:20.000Z' });

const ASSISTANT_WITH_TASK = buildEvent('assistant.message', {
  messageId: 'msg-3',
  content: 'Let me explore the codebase.',
  toolRequests: [
    {
      toolCallId: 'task-call-1',
      name: 'task',
      arguments: {
        agent_type: 'explore',
        prompt: 'Find all test files',
        description: 'Finding tests',
      },
      type: 'function',
    },
  ],
  interactionId: 'interaction-1',
}, { id: 'assistant-3', timestamp: '2026-04-01T10:00:20.000Z' });

const TASK_TOOL_COMPLETE = buildEvent('tool.execution_complete', {
  toolCallId: 'task-call-1',
  model: 'claude-sonnet-4',
  interactionId: 'interaction-1',
  success: true,
  result: {
    content: 'Found 10 test files',
  },
}, { id: 'task-complete-1', timestamp: '2026-04-01T10:00:30.000Z' });

const SESSION_SHUTDOWN = buildEvent('session.shutdown', {
  shutdownType: 'routine',
  totalPremiumRequests: 5,
  totalApiDurationMs: 30000,
  sessionStartTime: 1712048400000,
  codeChanges: { linesAdded: 10, linesRemoved: 2, filesModified: [] },
  modelMetrics: {
    'claude-sonnet-4': {
      requests: { count: 5, cost: 5 },
      usage: {
        inputTokens: 5000,
        outputTokens: 1000,
        cacheReadTokens: 2000,
        cacheWriteTokens: 500,
      },
    },
  },
  currentModel: 'claude-sonnet-4',
}, { id: 'shutdown-1', timestamp: '2026-04-01T10:01:00.000Z' });

const TURN_START = buildEvent('assistant.turn_start', {
  turnId: '0',
  interactionId: 'interaction-1',
}, { id: 'turn-start-1', timestamp: '2026-04-01T10:00:09.000Z' });

const TURN_END = buildEvent('assistant.turn_end', {
  turnId: '0',
}, { id: 'turn-end-1', timestamp: '2026-04-01T10:00:30.000Z' });

// =============================================================================
// Test Helpers
// =============================================================================

let tempDir: string;
let parser: CopilotSessionParser;

function writeEventsFile(...events: string[]): string {
  const filePath = path.join(tempDir, 'events.jsonl');
  fs.writeFileSync(filePath, events.join('\n') + '\n', 'utf-8');
  return filePath;
}

// =============================================================================
// Tests
// =============================================================================

describe('CopilotSessionParser', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-parser-test-'));
    parser = new CopilotSessionParser();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('basic parsing', () => {
    it('should parse an empty events file', async () => {
      const filePath = writeEventsFile(SESSION_START);
      const result = await parser.parseSessionFile(filePath);

      expect(result.messages).toHaveLength(0);
      expect(result.metrics.messageCount).toBe(0);
    });

    it('should parse a simple user + assistant conversation', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        TURN_START,
        ASSISTANT_MESSAGE_TEXT_ONLY,
        TURN_END
      );
      const result = await parser.parseSessionFile(filePath);

      expect(result.messages).toHaveLength(2);

      // User message
      const userMsg = result.messages[0];
      expect(userMsg.type).toBe('user');
      expect(userMsg.isMeta).toBe(false);
      expect(userMsg.content).toBe('Hello, help me with this code');
      expect(userMsg.cwd).toBe('/home/user/project');
      expect(userMsg.gitBranch).toBe('main');

      // Assistant message
      const assistantMsg = result.messages[1];
      expect(assistantMsg.type).toBe('assistant');
      expect(assistantMsg.toolCalls).toHaveLength(0);
      expect(Array.isArray(assistantMsg.content)).toBe(true);
    });

    it('should categorize messages correctly', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_TEXT_ONLY
      );
      const result = await parser.parseSessionFile(filePath);

      expect(result.byType.user).toHaveLength(1);
      expect(result.byType.realUser).toHaveLength(1);
      expect(result.byType.assistant).toHaveLength(1);
      expect(result.byType.system).toHaveLength(0);
      expect(result.mainMessages).toHaveLength(2);
      expect(result.sidechainMessages).toHaveLength(0);
    });
  });

  describe('tool call handling', () => {
    it('should extract tool calls from assistant messages', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_WITH_TOOLS,
        TOOL_COMPLETE_1,
        TOOL_COMPLETE_2
      );
      const result = await parser.parseSessionFile(filePath);

      // User + assistant + tool-result internal message
      expect(result.messages).toHaveLength(3);

      const assistantMsg = result.messages[1];
      expect(assistantMsg.type).toBe('assistant');
      expect(assistantMsg.toolCalls).toHaveLength(2);
      expect(assistantMsg.toolCalls[0].name).toBe('view');
      expect(assistantMsg.toolCalls[0].id).toBe('tool-call-1');
      expect(assistantMsg.toolCalls[1].name).toBe('grep');
    });

    it('should generate internal user messages for tool results', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_WITH_TOOLS,
        TOOL_COMPLETE_1,
        TOOL_COMPLETE_2
      );
      const result = await parser.parseSessionFile(filePath);

      const toolResultMsg = result.messages[2];
      expect(toolResultMsg.type).toBe('user');
      expect(toolResultMsg.isMeta).toBe(true);
      expect(toolResultMsg.toolResults).toHaveLength(2);
      expect(toolResultMsg.toolResults[0].toolUseId).toBe('tool-call-1');
      expect(toolResultMsg.toolResults[0].content).toBe('const x = 1;\nconst y = 2;');
      expect(toolResultMsg.toolResults[0].isError).toBe(false);
    });

    it('should mark failed tool results as errors', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_WITH_TOOLS,
        TOOL_COMPLETE_ERROR,
        TOOL_COMPLETE_2
      );
      const result = await parser.parseSessionFile(filePath);

      const toolResultMsg = result.messages[2];
      expect(toolResultMsg.toolResults[0].isError).toBe(true);
      expect(toolResultMsg.toolResults[0].content).toBe('File not found');
    });

    it('should include tool_use and tool_result content blocks', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_WITH_TOOLS,
        TOOL_COMPLETE_1,
        TOOL_COMPLETE_2
      );
      const result = await parser.parseSessionFile(filePath);

      // Assistant should have text + tool_use blocks
      const assistantContent = result.messages[1].content;
      expect(Array.isArray(assistantContent)).toBe(true);
      const blocks = assistantContent as Array<{ type: string }>;
      expect(blocks.some((b) => b.type === 'text')).toBe(true);
      expect(blocks.filter((b) => b.type === 'tool_use')).toHaveLength(2);

      // Tool result message should have tool_result blocks
      const toolContent = result.messages[2].content;
      expect(Array.isArray(toolContent)).toBe(true);
      const resultBlocks = toolContent as Array<{ type: string }>;
      expect(resultBlocks.filter((b) => b.type === 'tool_result')).toHaveLength(2);
    });
  });

  describe('subagent / task handling', () => {
    it('should detect task tool calls and mark them as isTask', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        SUBAGENT_STARTED,
        ASSISTANT_WITH_TASK,
        TASK_TOOL_COMPLETE
      );
      const result = await parser.parseSessionFile(filePath);

      // Should find 1 task call
      expect(result.taskCalls).toHaveLength(1);
      expect(result.taskCalls[0].isTask).toBe(true);
      expect(result.taskCalls[0].name).toBe('task');
      expect(result.taskCalls[0].taskSubagentType).toBe('explore');
      expect(result.taskCalls[0].taskDescription).toBe('Finding tests');
    });
  });

  describe('metrics', () => {
    it('should apply shutdown metrics to the last assistant message', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_TEXT_ONLY,
        SESSION_SHUTDOWN
      );
      const result = await parser.parseSessionFile(filePath);

      const assistantMsg = result.messages[1];
      expect(assistantMsg.usage).toBeDefined();
      expect(assistantMsg.usage!.input_tokens).toBe(5000);
      expect(assistantMsg.usage!.output_tokens).toBe(1000);
      expect(assistantMsg.usage!.cache_read_input_tokens).toBe(2000);
      expect(assistantMsg.model).toBe('claude-sonnet-4');
    });

    it('should calculate session metrics from messages', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_TEXT_ONLY,
        SESSION_SHUTDOWN
      );
      const result = await parser.parseSessionFile(filePath);

      expect(result.metrics.inputTokens).toBe(5000);
      expect(result.metrics.outputTokens).toBe(1000);
      expect(result.metrics.cacheReadTokens).toBe(2000);
      expect(result.metrics.messageCount).toBe(2);
    });
  });

  describe('session context', () => {
    it('should use session.start context for cwd and branch', async () => {
      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_TEXT_ONLY
      );
      const result = await parser.parseSessionFile(filePath);

      expect(result.messages[0].cwd).toBe('/home/user/project');
      expect(result.messages[0].gitBranch).toBe('main');
      expect(result.messages[1].cwd).toBe('/home/user/project');
      expect(result.messages[1].gitBranch).toBe('main');
    });

    it('should update context on session.resume', async () => {
      const resume = buildEvent('session.resume', {
        resumeTime: '2026-04-01T10:30:00.000Z',
        eventCount: 50,
        context: {
          cwd: '/home/user/other-project',
          gitRoot: '/home/user/other-project',
          branch: 'feature',
          repository: 'user/other-project',
        },
        alreadyInUse: false,
      }, { id: 'resume-1', timestamp: '2026-04-01T10:30:00.000Z' });

      const laterUser = buildEvent('user.message', {
        content: 'Continue working',
        transformedContent: 'Continue working',
        attachments: [],
        interactionId: 'interaction-2',
      }, { id: 'user-2', timestamp: '2026-04-01T10:30:05.000Z' });

      const filePath = writeEventsFile(
        SESSION_START,
        USER_MESSAGE,
        ASSISTANT_MESSAGE_TEXT_ONLY,
        SESSION_SHUTDOWN,
        resume,
        laterUser
      );
      const result = await parser.parseSessionFile(filePath);

      // Last user message should have updated context
      const lastUser = result.messages[result.messages.length - 1];
      expect(lastUser.cwd).toBe('/home/user/other-project');
      expect(lastUser.gitBranch).toBe('feature');
    });
  });

  describe('edge cases', () => {
    it('should skip invalid JSON lines', async () => {
      const filePath = path.join(tempDir, 'events.jsonl');
      fs.writeFileSync(
        filePath,
        [SESSION_START, 'not valid json {{{', USER_MESSAGE, ASSISTANT_MESSAGE_TEXT_ONLY].join('\n'),
        'utf-8'
      );
      const result = await parser.parseSessionFile(filePath);

      // Should still parse the valid lines
      expect(result.messages).toHaveLength(2);
    });

    it('should handle assistant message with no text content', async () => {
      const noTextAssistant = buildEvent('assistant.message', {
        messageId: 'msg-empty',
        content: '',
        toolRequests: [{
          toolCallId: 'tc-1',
          name: 'view',
          arguments: { path: '/tmp/file.ts' },
          type: 'function',
        }],
        interactionId: 'interaction-1',
      }, { id: 'assistant-empty', timestamp: '2026-04-01T10:00:10.000Z' });

      const toolResult = buildEvent('tool.execution_complete', {
        toolCallId: 'tc-1',
        success: true,
        result: { content: 'file contents' },
      }, { id: 'tc-result-1', timestamp: '2026-04-01T10:00:11.000Z' });

      const filePath = writeEventsFile(SESSION_START, USER_MESSAGE, noTextAssistant, toolResult);
      const result = await parser.parseSessionFile(filePath);

      const assistantMsg = result.messages[1];
      // Should have only tool_use block, no text block
      const blocks = assistantMsg.content as Array<{ type: string }>;
      expect(blocks.filter((b) => b.type === 'text')).toHaveLength(0);
      expect(blocks.filter((b) => b.type === 'tool_use')).toHaveLength(1);
    });
  });
});
