/**
 * CopilotSessionParser — Parses Copilot CLI events.jsonl files into ParsedMessage[].
 *
 * Converts the event-stream format used by Copilot CLI into the same ParsedMessage
 * structure that Claude Code sessions use, so ChunkBuilder and the entire renderer
 * layer work unchanged.
 *
 * Event flow → ParsedMessage mapping:
 *   user.message           → ParsedMessage { type: 'user', isMeta: false }
 *   assistant.message      → ParsedMessage { type: 'assistant', toolCalls from toolRequests }
 *   tool.execution_complete → ParsedMessage { type: 'user', isMeta: true, toolResults }
 *   subagent.started/completed → tracked for Process[] resolution
 *   session.shutdown       → aggregate metrics
 */

import {
  EMPTY_METRICS,
  type ParsedMessage,
  type Process,
  type SessionMetrics,
  type ToolCall,
  type ToolResult,
} from '@main/types';
import {
  type CopilotAssistantMessageEvent,
  type CopilotEvent,
  type CopilotSessionShutdownEvent,
  type CopilotSubagentCompletedEvent,
  type CopilotSubagentStartedEvent,
  type CopilotToolExecutionCompleteEvent,
  type CopilotToolExecutionStartEvent,
  type CopilotUserMessageEvent,
  isCopilotEvent,
} from '@main/types/copilotEvents';
import { type ContentBlock, type TextContent, type ToolResultContent, type ToolUseContent } from '@main/types/jsonl';
import {
  isParsedInternalUserMessage,
  isParsedRealUserMessage,
} from '@main/types/messages';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as readline from 'readline';

import { type ParsedSession } from './SessionParser';

const logger = createLogger('Parsing:CopilotSessionParser');

// =============================================================================
// Core Parser
// =============================================================================

export class CopilotSessionParser {
  /**
   * Parse a Copilot CLI events.jsonl file and return a ParsedSession.
   */
  async parseSessionFile(filePath: string): Promise<ParsedSession> {
    const events = await readEventsJsonl(filePath);
    const messages = convertEventsToMessages(events);
    return processMessages(messages);
  }

  /**
   * Parse a Copilot CLI events.jsonl file and also extract subagent Process[].
   */
  async parseSessionFileWithSubagents(
    filePath: string
  ): Promise<{ parsed: ParsedSession; subagents: Process[] }> {
    const events = await readEventsJsonl(filePath);
    const messages = convertEventsToMessages(events);
    const parsed = processMessages(messages);
    const subagents = extractSubagentProcesses(events, parsed.taskCalls);
    return { parsed, subagents };
  }
}

// =============================================================================
// JSONL Reader
// =============================================================================

async function readEventsJsonl(filePath: string): Promise<CopilotEvent[]> {
  const events: CopilotEvent[] = [];

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isCopilotEvent(parsed)) {
        events.push(parsed as CopilotEvent);
      }
    } catch {
      logger.debug(`Skipping invalid JSON line in ${filePath}`);
    }
  }

  return events;
}

// =============================================================================
// Event → ParsedMessage Conversion
// =============================================================================

/**
 * Convert a stream of Copilot CLI events into ParsedMessage[].
 *
 * The key challenge is reconstructing the turn-based message structure that
 * ChunkBuilder expects from the event-based format:
 *
 *   1. user.message → user ParsedMessage (isMeta=false, starts new chunk)
 *   2. assistant.message → assistant ParsedMessage (has toolCalls)
 *   3. tool.execution_complete (batched) → internal user ParsedMessage (isMeta=true, has toolResults)
 *   4. Repeat 2-3 until turn ends
 */
function convertEventsToMessages(events: CopilotEvent[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  // Collect tool execution results keyed by toolCallId
  const toolResults = new Map<string, CopilotToolExecutionCompleteEvent>();
  // Collect subagent events keyed by toolCallId
  const subagentStarts = new Map<string, CopilotSubagentStartedEvent>();
  // Session context from start/resume events
  let sessionContext: { cwd?: string; branch?: string } = {};
  // Aggregate metrics from shutdown
  let shutdownMetrics: CopilotSessionShutdownEvent['data'] | null = null;

  // First pass: index tool results and subagent events
  for (const event of events) {
    switch (event.type) {
      case 'tool.execution_complete':
        toolResults.set(
          (event).data.toolCallId,
          event
        );
        break;
      case 'subagent.started':
        subagentStarts.set(
          (event).data.toolCallId,
          event
        );
        break;
      case 'session.start':
        sessionContext = {
          cwd: (event).data.context.cwd,
          branch: (event).data.context.branch,
        };
        break;
      case 'session.resume':
        // Update context on resume (may have changed branch/cwd)
        {
          const resumeData = (event as { data: { context: { cwd?: string; branch?: string } } }).data;
          if (resumeData.context.cwd) sessionContext.cwd = resumeData.context.cwd;
          if (resumeData.context.branch) sessionContext.branch = resumeData.context.branch;
        }
        break;
      case 'session.shutdown':
        shutdownMetrics = (event).data;
        break;
    }
  }

  // Second pass: generate ParsedMessages from conversation events
  let messageIndex = 0;

  for (const event of events) {
    switch (event.type) {
      case 'user.message':
        messages.push(
          buildUserMessage(event, sessionContext, messageIndex++)
        );
        break;

      case 'assistant.message': {
        const assistantEvent = event;
        const assistantMsg = buildAssistantMessage(
          assistantEvent,
          sessionContext,
          subagentStarts,
          messageIndex++
        );
        messages.push(assistantMsg);

        // If this assistant message has tool calls, generate a tool-result
        // internal user message from the corresponding tool.execution_complete events
        if (assistantEvent.data.toolRequests.length > 0) {
          const toolResultMsg = buildToolResultMessage(
            assistantEvent,
            toolResults,
            sessionContext,
            messageIndex++
          );
          if (toolResultMsg) {
            messages.push(toolResultMsg);
          }
        }
        break;
      }
    }
  }

  // Attach aggregate usage to the last assistant message if available
  if (shutdownMetrics && messages.length > 0) {
    applyShutdownMetrics(messages, shutdownMetrics);
  }

  return messages;
}

// =============================================================================
// Message Builders
// =============================================================================

function buildUserMessage(
  event: CopilotUserMessageEvent,
  context: { cwd?: string; branch?: string },
  _index: number
): ParsedMessage {
  // Use raw content (not transformedContent which has system wrappers)
  const content = event.data.content;

  return {
    uuid: event.id,
    parentUuid: event.parentId,
    type: 'user',
    timestamp: new Date(event.timestamp),
    role: 'user',
    content,
    cwd: context.cwd,
    gitBranch: context.branch,
    isSidechain: false,
    isMeta: false,
    userType: 'external',
    toolCalls: [],
    toolResults: [],
  };
}

function buildAssistantMessage(
  event: CopilotAssistantMessageEvent,
  context: { cwd?: string; branch?: string },
  subagentStarts: Map<string, CopilotSubagentStartedEvent>,
  _index: number
): ParsedMessage {
  const contentBlocks: ContentBlock[] = [];

  // Add text content if present
  const textContent = event.data.content.trim();
  if (textContent) {
    contentBlocks.push({
      type: 'text',
      text: textContent,
    } as TextContent);
  }

  // Convert toolRequests to ToolUseContent blocks
  for (const req of event.data.toolRequests) {
    contentBlocks.push({
      type: 'tool_use',
      id: req.toolCallId,
      name: req.name,
      input: req.arguments,
    } as ToolUseContent);
  }

  // Extract tool calls
  const toolCalls: ToolCall[] = event.data.toolRequests.map((req) => {
    const subagent = subagentStarts.get(req.toolCallId);
    const isTask = req.name === 'task' || !!subagent;

    return {
      id: req.toolCallId,
      name: req.name,
      input: req.arguments,
      isTask,
      taskDescription: isTask
        ? (req.arguments.description as string | undefined)
        : undefined,
      taskSubagentType: isTask
        ? (subagent?.data.agentName ?? (req.arguments.agent_type as string | undefined))
        : undefined,
    };
  });

  return {
    uuid: event.id,
    parentUuid: event.parentId,
    type: 'assistant',
    timestamp: new Date(event.timestamp),
    role: 'assistant',
    content: contentBlocks,
    model: undefined, // Model info comes from tool.execution_complete or session.shutdown
    cwd: context.cwd,
    gitBranch: context.branch,
    isSidechain: false,
    isMeta: false,
    toolCalls,
    toolResults: [],
  };
}

function buildToolResultMessage(
  assistantEvent: CopilotAssistantMessageEvent,
  toolResults: Map<string, CopilotToolExecutionCompleteEvent>,
  context: { cwd?: string; branch?: string },
  _index: number
): ParsedMessage | null {
  const resultBlocks: ContentBlock[] = [];
  const parsedResults: ToolResult[] = [];
  let latestTimestamp = new Date(assistantEvent.timestamp);
  let model: string | undefined;

  for (const req of assistantEvent.data.toolRequests) {
    const result = toolResults.get(req.toolCallId);
    if (!result) continue;

    const resultTimestamp = new Date(result.timestamp);
    if (resultTimestamp > latestTimestamp) {
      latestTimestamp = resultTimestamp;
    }

    // Capture model from tool execution
    if (result.data.model) {
      model = result.data.model;
    }

    const resultContent = result.data.result?.content ?? '';
    const detailedContent = result.data.result?.detailedContent;

    // Build ToolResultContent block
    resultBlocks.push({
      type: 'tool_result',
      tool_use_id: req.toolCallId,
      content: detailedContent ?? resultContent,
      is_error: !result.data.success,
    } as ToolResultContent);

    parsedResults.push({
      toolUseId: req.toolCallId,
      content: detailedContent ?? resultContent,
      isError: !result.data.success,
    });
  }

  if (resultBlocks.length === 0) return null;

  return {
    uuid: `tool-results-${assistantEvent.id}`,
    parentUuid: assistantEvent.id,
    type: 'user',
    timestamp: latestTimestamp,
    role: 'user',
    content: resultBlocks,
    model,
    cwd: context.cwd,
    gitBranch: context.branch,
    isSidechain: false,
    isMeta: true,
    toolCalls: [],
    toolResults: parsedResults,
  };
}

/**
 * Apply aggregate token metrics from session.shutdown to the last assistant message.
 * This ensures calculateMetrics() has token data to work with.
 */
function applyShutdownMetrics(
  messages: ParsedMessage[],
  shutdown: CopilotSessionShutdownEvent['data']
): void {
  // Find the last assistant message to attach usage to
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'assistant') {
      // Sum usage across all models
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;

      for (const [modelName, metrics] of Object.entries(shutdown.modelMetrics)) {
        inputTokens += metrics.usage.inputTokens;
        outputTokens += metrics.usage.outputTokens;
        cacheReadTokens += metrics.usage.cacheReadTokens;
        cacheWriteTokens += metrics.usage.cacheWriteTokens;

        if (!msg.model) {
          msg.model = modelName;
        }
      }

      msg.usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: cacheWriteTokens,
      };
      break;
    }
  }
}

// =============================================================================
// Message Processing (shared with SessionParser)
// =============================================================================

function processMessages(messages: ParsedMessage[]): ParsedSession {
  const byType = {
    user: [] as ParsedMessage[],
    realUser: [] as ParsedMessage[],
    internalUser: [] as ParsedMessage[],
    assistant: [] as ParsedMessage[],
    system: [] as ParsedMessage[],
    other: [] as ParsedMessage[],
  };
  const sidechainMessages: ParsedMessage[] = [];
  const mainMessages: ParsedMessage[] = [];

  for (const m of messages) {
    switch (m.type) {
      case 'user':
        byType.user.push(m);
        if (isParsedRealUserMessage(m)) {
          byType.realUser.push(m);
        } else if (isParsedInternalUserMessage(m)) {
          byType.internalUser.push(m);
        }
        break;
      case 'assistant':
        byType.assistant.push(m);
        break;
      case 'system':
        byType.system.push(m);
        break;
      default:
        byType.other.push(m);
        break;
    }

    if (m.isSidechain) {
      sidechainMessages.push(m);
    } else {
      mainMessages.push(m);
    }
  }

  const metrics = calculateCopilotMetrics(messages);
  const taskCalls = extractTaskCalls(messages);

  return {
    messages,
    metrics,
    taskCalls,
    byType,
    sidechainMessages,
    mainMessages,
  };
}

function calculateCopilotMetrics(messages: ParsedMessage[]): SessionMetrics {
  if (messages.length === 0) {
    return { ...EMPTY_METRICS };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));
  let minTime = 0;
  let maxTime = 0;
  if (timestamps.length > 0) {
    minTime = timestamps[0];
    maxTime = timestamps[0];
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < minTime) minTime = timestamps[i];
      if (timestamps[i] > maxTime) maxTime = timestamps[i];
    }
  }

  for (const msg of messages) {
    if (msg.usage) {
      inputTokens += msg.usage.input_tokens ?? 0;
      outputTokens += msg.usage.output_tokens ?? 0;
      cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += msg.usage.cache_creation_input_tokens ?? 0;
    }
  }

  return {
    durationMs: maxTime - minTime,
    totalTokens: inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    messageCount: messages.length,
  };
}

function extractTaskCalls(messages: ParsedMessage[]): ToolCall[] {
  return messages.flatMap((m) => m.toolCalls.filter((tc) => tc.isTask));
}

// =============================================================================
// Subagent Process Extraction
// =============================================================================

/**
 * Extract Process[] from subagent.started/completed events.
 * Pairs start/complete events by toolCallId and builds Process objects
 * compatible with the ChunkBuilder.
 */
function extractSubagentProcesses(events: CopilotEvent[], taskCalls: ToolCall[]): Process[] {
  const starts = new Map<string, CopilotSubagentStartedEvent>();
  const completes = new Map<string, CopilotSubagentCompletedEvent>();
  const toolStarts = new Map<string, CopilotToolExecutionStartEvent>();
  const toolResults = new Map<string, CopilotToolExecutionCompleteEvent>();

  for (const event of events) {
    if (event.type === 'subagent.started') {
      starts.set((event as CopilotSubagentStartedEvent).data.toolCallId, event as CopilotSubagentStartedEvent);
    } else if (event.type === 'subagent.completed') {
      completes.set((event as CopilotSubagentCompletedEvent).data.toolCallId, event as CopilotSubagentCompletedEvent);
    } else if (event.type === 'tool.execution_start') {
      const ts = event as CopilotToolExecutionStartEvent;
      toolStarts.set(ts.data.toolCallId, ts);
    } else if (event.type === 'tool.execution_complete') {
      const te = event as CopilotToolExecutionCompleteEvent;
      toolResults.set(te.data.toolCallId, te);
    }
  }

  // Build a map from agent_id → best read_agent result content
  // read_agent calls have arguments.agent_id; we want the last completed one per agent
  const agentResults = new Map<string, string>();
  for (const [toolCallId, startEvt] of toolStarts) {
    if (startEvt.data.toolName !== 'read_agent') continue;
    const agentId = startEvt.data.arguments?.agent_id as string | undefined;
    if (!agentId) continue;

    const result = toolResults.get(toolCallId);
    if (!result?.data.success || !result.data.result?.content) continue;

    // Keep the last (most complete) read_agent result per agent
    agentResults.set(agentId, result.data.result.content);
  }

  const processes: Process[] = [];

  for (const [toolCallId, startEvent] of starts) {
    const completeEvent = completes.get(toolCallId);
    const taskCall = taskCalls.find((tc) => tc.id === toolCallId);
    const toolResult = toolResults.get(toolCallId);

    const startTime = new Date(startEvent.timestamp);
    const endTime = completeEvent ? new Date(completeEvent.timestamp) : startTime;
    const durationMs = completeEvent?.data.durationMs ?? (endTime.getTime() - startTime.getTime());

    const totalTokens = completeEvent?.data.totalTokens ?? 0;
    const totalToolCalls = completeEvent?.data.totalToolCalls ?? 0;

    // Extract the agent_id used for read_agent results
    // The task call's name argument becomes the agent_id (e.g., "explore-main")
    const agentName = taskCall?.input?.name as string | undefined;
    const readAgentResult = agentName ? agentResults.get(agentName) : undefined;

    processes.push({
      id: toolCallId,
      filePath: '',
      messages: [],
      startTime,
      endTime,
      durationMs,
      metrics: {
        durationMs,
        totalTokens,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messageCount: totalToolCalls,
      },
      description: taskCall?.taskDescription ?? startEvent.data.agentDisplayName,
      prompt: taskCall?.input?.prompt as string | undefined,
      result: readAgentResult,
      subagentType: startEvent.data.agentName,
      isParallel: false,
      parentTaskId: toolCallId,
      isOngoing: !completeEvent,
    });
  }

  // Sort by start time
  processes.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  return processes;
}
