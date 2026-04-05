/**
 * Copilot CLI event types — raw data structures from events.jsonl files.
 *
 * These types represent the event stream format stored in:
 * ~/.copilot/session-state/{session-uuid}/events.jsonl
 *
 * Each line is a JSON object with a `type` discriminator, event `data`,
 * a unique `id`, ISO `timestamp`, and `parentId` for event chaining.
 */

// =============================================================================
// Base Event
// =============================================================================

export interface CopilotBaseEvent {
  type: string;
  id: string;
  timestamp: string;
  parentId: string | null;
}

// =============================================================================
// Session Lifecycle Events
// =============================================================================

export interface CopilotSessionStartEvent extends CopilotBaseEvent {
  type: 'session.start';
  data: {
    sessionId: string;
    version: number;
    producer: string;
    copilotVersion: string;
    startTime: string;
    context: CopilotSessionContext;
    alreadyInUse: boolean;
  };
}

export interface CopilotSessionResumeEvent extends CopilotBaseEvent {
  type: 'session.resume';
  data: {
    resumeTime: string;
    eventCount: number;
    context: CopilotSessionContext;
    alreadyInUse: boolean;
  };
}

export interface CopilotSessionShutdownEvent extends CopilotBaseEvent {
  type: 'session.shutdown';
  data: {
    shutdownType: string;
    totalPremiumRequests: number;
    totalApiDurationMs: number;
    sessionStartTime: number;
    codeChanges: {
      linesAdded: number;
      linesRemoved: number;
      filesModified: string[];
    };
    modelMetrics: Record<
      string,
      {
        requests: { count: number; cost: number };
        usage: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        };
      }
    >;
    currentModel: string;
  };
}

export interface CopilotSessionInfoEvent extends CopilotBaseEvent {
  type: 'session.info';
  data: {
    infoType: string;
    message: string;
    url?: string;
  };
}

// =============================================================================
// Context
// =============================================================================

export interface CopilotSessionContext {
  cwd: string;
  gitRoot?: string;
  branch?: string;
  headCommit?: string;
  repository?: string;
  hostType?: string;
  baseCommit?: string;
}

// =============================================================================
// User Message Event
// =============================================================================

export interface CopilotUserMessageEvent extends CopilotBaseEvent {
  type: 'user.message';
  data: {
    content: string;
    transformedContent: string;
    attachments: unknown[];
    interactionId: string;
  };
}

// =============================================================================
// Assistant Events
// =============================================================================

export interface CopilotToolRequest {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  type: string;
  intentionSummary?: string;
}

export interface CopilotAssistantMessageEvent extends CopilotBaseEvent {
  type: 'assistant.message';
  data: {
    messageId: string;
    content: string;
    toolRequests: CopilotToolRequest[];
    interactionId: string;
    reasoningOpaque?: string;
    reasoningText?: string;
    outputTokens?: number;
  };
}

export interface CopilotAssistantTurnStartEvent extends CopilotBaseEvent {
  type: 'assistant.turn_start';
  data: {
    turnId: string;
    interactionId: string;
  };
}

export interface CopilotAssistantTurnEndEvent extends CopilotBaseEvent {
  type: 'assistant.turn_end';
  data: {
    turnId: string;
  };
}

// =============================================================================
// Tool Execution Events
// =============================================================================

export interface CopilotToolExecutionStartEvent extends CopilotBaseEvent {
  type: 'tool.execution_start';
  data: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
}

export interface CopilotToolExecutionCompleteEvent extends CopilotBaseEvent {
  type: 'tool.execution_complete';
  data: {
    toolCallId: string;
    model?: string;
    interactionId?: string;
    success: boolean;
    result?: {
      content: string;
      detailedContent?: string;
    };
    toolTelemetry?: Record<string, unknown>;
  };
}

// =============================================================================
// Subagent Events
// =============================================================================

export interface CopilotSubagentStartedEvent extends CopilotBaseEvent {
  type: 'subagent.started';
  data: {
    toolCallId: string;
    agentName: string;
    agentDisplayName: string;
    agentDescription?: string;
  };
}

export interface CopilotSubagentCompletedEvent extends CopilotBaseEvent {
  type: 'subagent.completed';
  data: {
    toolCallId: string;
    agentName: string;
    agentDisplayName: string;
    model?: string;
    totalToolCalls?: number;
    totalTokens?: number;
    durationMs?: number;
  };
}

// =============================================================================
// Hook Events
// =============================================================================

export interface CopilotHookStartEvent extends CopilotBaseEvent {
  type: 'hook.start';
  data: {
    hookInvocationId: string;
    hookType: string;
    input: {
      sessionId: string;
      timestamp: number;
      cwd: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
      toolResult: {
        textResultForLlm: string;
        resultType: string;
        sessionLog?: string;
        toolTelemetry?: Record<string, unknown>;
      };
    };
  };
}

export interface CopilotHookEndEvent extends CopilotBaseEvent {
  type: 'hook.end';
  data: {
    hookInvocationId: string;
    hookType: string;
    success: boolean;
  };
}

// =============================================================================
// Skill Event
// =============================================================================

export interface CopilotSkillInvokedEvent extends CopilotBaseEvent {
  type: 'skill.invoked';
  data: {
    name: string;
    path: string;
    content: string;
  };
}

// =============================================================================
// Abort Event
// =============================================================================

export interface CopilotAbortEvent extends CopilotBaseEvent {
  type: 'abort';
  data: {
    reason: string;
  };
}

// =============================================================================
// System Notification Event
// =============================================================================

export interface CopilotSystemNotificationEvent extends CopilotBaseEvent {
  type: 'system.notification';
  data: {
    content: string;
    kind?: {
      type: string;
      agentId?: string;
      agentType?: string;
      status?: string;
      description?: string;
      prompt?: string;
    };
  };
}

// =============================================================================
// Union Type
// =============================================================================

export type CopilotEvent =
  | CopilotSessionStartEvent
  | CopilotSessionResumeEvent
  | CopilotSessionShutdownEvent
  | CopilotSessionInfoEvent
  | CopilotUserMessageEvent
  | CopilotAssistantMessageEvent
  | CopilotAssistantTurnStartEvent
  | CopilotAssistantTurnEndEvent
  | CopilotToolExecutionStartEvent
  | CopilotToolExecutionCompleteEvent
  | CopilotSubagentStartedEvent
  | CopilotSubagentCompletedEvent
  | CopilotHookStartEvent
  | CopilotHookEndEvent
  | CopilotSkillInvokedEvent
  | CopilotAbortEvent
  | CopilotSystemNotificationEvent;

export type CopilotEventType = CopilotEvent['type'];

// =============================================================================
// Workspace Metadata (from workspace.yaml)
// =============================================================================

export interface CopilotWorkspaceMetadata {
  id: string;
  cwd: string;
  gitRoot?: string;
  repository?: string;
  hostType?: string;
  branch?: string;
  summary?: string;
  summaryCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isCopilotEvent(obj: unknown): obj is CopilotBaseEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    'id' in obj &&
    'timestamp' in obj &&
    typeof (obj as CopilotBaseEvent).type === 'string'
  );
}

export function isSessionStartEvent(event: CopilotBaseEvent): event is CopilotSessionStartEvent {
  return event.type === 'session.start';
}

export function isUserMessageEvent(event: CopilotBaseEvent): event is CopilotUserMessageEvent {
  return event.type === 'user.message';
}

export function isAssistantMessageEvent(
  event: CopilotBaseEvent
): event is CopilotAssistantMessageEvent {
  return event.type === 'assistant.message';
}

export function isToolExecutionCompleteEvent(
  event: CopilotBaseEvent
): event is CopilotToolExecutionCompleteEvent {
  return event.type === 'tool.execution_complete';
}

export function isSubagentStartedEvent(
  event: CopilotBaseEvent
): event is CopilotSubagentStartedEvent {
  return event.type === 'subagent.started';
}

export function isSubagentCompletedEvent(
  event: CopilotBaseEvent
): event is CopilotSubagentCompletedEvent {
  return event.type === 'subagent.completed';
}

export function isSessionShutdownEvent(
  event: CopilotBaseEvent
): event is CopilotSessionShutdownEvent {
  return event.type === 'session.shutdown';
}
