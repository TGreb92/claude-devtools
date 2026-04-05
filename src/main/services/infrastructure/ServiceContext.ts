/**
 * ServiceContext - Bundle of session-data services for a single workspace context.
 *
 * Responsibilities:
 * - Encapsulate all session-data services (ProjectScanner, SessionParser, etc.)
 * - Manage service lifecycle (creation, start, stop, dispose)
 * - Provide isolation between local and SSH contexts
 *
 * Each ServiceContext represents a complete service stack for one workspace:
 * - Local context: ~/.claude/projects/ on local filesystem
 * - SSH context: remote ~/.claude/projects/ over SFTP
 */

import { ChunkBuilder } from '@main/services/analysis/ChunkBuilder';
import { CopilotProjectScanner } from '@main/services/discovery/CopilotProjectScanner';
import { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import { SubagentResolver } from '@main/services/discovery/SubagentResolver';
import { CopilotSessionParser } from '@main/services/parsing/CopilotSessionParser';
import { SessionParser } from '@main/services/parsing/SessionParser';
import { getCopilotSessionStatePath } from '@main/utils/pathDecoder';
import {
  CACHE_CLEANUP_INTERVAL_MINUTES,
  CACHE_TTL_MINUTES,
  MAX_CACHE_SESSIONS,
} from '@shared/constants';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';

import { DataCache } from './DataCache';
import { FileWatcher } from './FileWatcher';

import type { FileSystemProvider } from './FileSystemProvider';

const logger = createLogger('Infrastructure:ServiceContext');

/**
 * Configuration for creating a ServiceContext.
 */
export interface ServiceContextConfig {
  /** Unique identifier (e.g., 'local', 'ssh-myserver') */
  id: string;
  /** Context type */
  type: 'local' | 'ssh';
  /** Filesystem provider for this context */
  fsProvider: FileSystemProvider;
  /** Projects directory path (defaults to ~/.claude/projects) */
  projectsDir?: string;
  /** Todos directory path (defaults to ~/.claude/todos) */
  todosDir?: string;
}

/**
 * ServiceContext - Isolated service bundle for one workspace context.
 *
 * Contains all session-data services configured for a specific workspace
 * (local or SSH). Services share the same FileSystemProvider and are
 * properly wired with dependencies.
 *
 * Lifecycle:
 * - Create: new ServiceContext(config)
 * - Start: context.start() — activates file watching and cache cleanup
 * - Pause: context.stopFileWatcher() — on context switch
 * - Resume: context.startFileWatcher() — on context switch back
 * - Destroy: context.dispose() — cleans up all resources
 */
export class ServiceContext {
  /** Context identifier */
  readonly id: string;
  /** Context type */
  readonly type: 'local' | 'ssh';
  /** Filesystem provider */
  readonly fsProvider: FileSystemProvider;

  // Service instances
  readonly projectScanner: ProjectScanner;
  readonly sessionParser: SessionParser;
  readonly subagentResolver: SubagentResolver;
  readonly chunkBuilder: ChunkBuilder;
  readonly dataCache: DataCache;
  readonly fileWatcher: FileWatcher;

  // Copilot CLI services (optional — only created for local contexts)
  readonly copilotScanner?: CopilotProjectScanner;
  readonly copilotParser?: CopilotSessionParser;

  private cleanupInterval: NodeJS.Timeout | null = null;
  private copilotWatcher: fs.FSWatcher | null = null;
  private copilotDebounceTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(config: ServiceContextConfig) {
    this.id = config.id;
    this.type = config.type;
    this.fsProvider = config.fsProvider;

    logger.info(`Creating ServiceContext: ${config.id} (${config.type})`);

    // Create services in dependency order
    const disableCache = process.env.CLAUDE_CONTEXT_DISABLE_CACHE === '1';

    // 1. ProjectScanner - no dependencies (uses fsProvider directly)
    this.projectScanner = new ProjectScanner(
      config.projectsDir,
      config.todosDir,
      config.fsProvider
    );

    // 2. SessionParser - depends on ProjectScanner
    this.sessionParser = new SessionParser(this.projectScanner);

    // 3. SubagentResolver - depends on ProjectScanner
    this.subagentResolver = new SubagentResolver(this.projectScanner);

    // 4. ChunkBuilder - no dependencies
    this.chunkBuilder = new ChunkBuilder();

    // 5. DataCache - standalone service
    this.dataCache = new DataCache(MAX_CACHE_SESSIONS, CACHE_TTL_MINUTES, !disableCache);

    // 6. FileWatcher - uses fsProvider and dataCache
    this.fileWatcher = new FileWatcher(
      this.dataCache,
      config.projectsDir,
      config.todosDir,
      config.fsProvider
    );
    this.fileWatcher.setProjectScanner(this.projectScanner);

    // 7. Copilot CLI services (local contexts only — SSH doesn't access Copilot sessions)
    if (config.type === 'local') {
      this.copilotScanner = new CopilotProjectScanner();
      this.copilotParser = new CopilotSessionParser();
      logger.info('Copilot CLI services initialized');
    }

    logger.info(`ServiceContext created: ${config.id}`);
  }

  /**
   * Starts the file watcher and cache cleanup.
   * Call this after creating the context to activate monitoring.
   */
  start(): void {
    if (this.disposed) {
      logger.error(`Cannot start disposed context: ${this.id}`);
      return;
    }

    logger.info(`Starting ServiceContext: ${this.id}`);

    // Start file watcher
    this.fileWatcher.start();

    // Start cache auto-cleanup
    this.cleanupInterval = this.dataCache.startAutoCleanup(CACHE_CLEANUP_INTERVAL_MINUTES);

    // Start Copilot session-state watcher
    if (this.copilotScanner) {
      this.startCopilotWatcher();
    }
  }

  /**
   * Stops the file watcher (for pausing on context switch).
   * Does not dispose resources - can be resumed with startFileWatcher().
   */
  stopFileWatcher(): void {
    logger.info(`Stopping FileWatcher for context: ${this.id}`);
    this.fileWatcher.stop();
    this.stopCopilotWatcher();
  }

  /**
   * Starts the file watcher (for resuming after context switch).
   */
  startFileWatcher(): void {
    if (this.disposed) {
      logger.error(`Cannot start FileWatcher on disposed context: ${this.id}`);
      return;
    }

    logger.info(`Starting FileWatcher for context: ${this.id}`);
    this.fileWatcher.start();
    if (this.copilotScanner) {
      this.startCopilotWatcher();
    }
  }

  /**
   * Disposes all resources.
   * After calling dispose(), this context cannot be reused.
   */
  dispose(): void {
    if (this.disposed) {
      logger.warn(`ServiceContext already disposed: ${this.id}`);
      return;
    }

    logger.info(`Disposing ServiceContext: ${this.id}`);

    // Stop and dispose FileWatcher
    this.fileWatcher.dispose();

    // Stop Copilot watcher
    this.stopCopilotWatcher();

    // Dispose DataCache
    this.dataCache.dispose();

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.disposed = true;

    logger.info(`ServiceContext disposed: ${this.id}`);
  }

  /**
   * Returns whether this context has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  // ===========================================================================
  // Copilot Session Watcher
  // ===========================================================================

  private startCopilotWatcher(): void {
    if (this.copilotWatcher) return;

    const copilotPath = getCopilotSessionStatePath();
    if (!fs.existsSync(copilotPath)) return;

    try {
      this.copilotWatcher = fs.watch(copilotPath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const parts = filename.replace(/\\/g, '/').split('/');
        const basename = parts.pop() ?? '';
        if (basename !== 'events.jsonl' && basename !== 'workspace.yaml') return;

        // Extract session UUID from path (e.g., "{uuid}/events.jsonl")
        const sessionId = parts[0];

        // Debounce
        if (this.copilotDebounceTimer) {
          clearTimeout(this.copilotDebounceTimer);
        }
        this.copilotDebounceTimer = setTimeout(() => {
          this.copilotDebounceTimer = null;
          // Clear caches
          this.copilotScanner?.clearCache();
          this.dataCache.clear();
          // Emit a proper FileChangeEvent so the renderer refreshes
          this.fileWatcher.emit('file-change', {
            type: basename === 'workspace.yaml' ? 'add' : 'change',
            path: copilotPath,
            sessionId: sessionId ?? undefined,
            isSubagent: false,
          });
        }, 500);
      });

      this.copilotWatcher.on('error', () => {
        this.stopCopilotWatcher();
      });
    } catch {
      // Directory may become unavailable — not critical
    }
  }

  private stopCopilotWatcher(): void {
    if (this.copilotWatcher) {
      this.copilotWatcher.close();
      this.copilotWatcher = null;
    }
    if (this.copilotDebounceTimer) {
      clearTimeout(this.copilotDebounceTimer);
      this.copilotDebounceTimer = null;
    }
  }
}
