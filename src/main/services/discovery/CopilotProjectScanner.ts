/**
 * CopilotProjectScanner — Discovers Copilot CLI sessions and presents them as Projects.
 *
 * Scans ~/.copilot/session-state/ for session directories, reads workspace.yaml
 * metadata, and groups sessions by cwd into Project objects compatible with the
 * existing UI.
 *
 * Project IDs use the `copilot::` prefix to distinguish from Claude Code projects.
 */

import { type Project, type Session } from '@main/types';
import { type CopilotWorkspaceMetadata } from '@main/types/copilotEvents';
import {
  buildCopilotEventsPath,
  buildCopilotProjectId,
  buildCopilotWorkspacePath,
  encodePath,
  getCopilotSessionStatePath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { isUUID } from '@shared/utils/sessionIdValidator';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('Discovery:CopilotProjectScanner');

// =============================================================================
// Workspace YAML Parser (simple key: value format, no dependency needed)
// =============================================================================

function parseWorkspaceYaml(content: string): CopilotWorkspaceMetadata {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }

  return {
    id: result.id ?? '',
    cwd: result.cwd ?? '',
    gitRoot: result.git_root,
    repository: result.repository,
    hostType: result.host_type,
    branch: result.branch,
    summary: result.summary,
    summaryCount: result.summary_count ? parseInt(result.summary_count, 10) : undefined,
    createdAt: result.created_at,
    updatedAt: result.updated_at,
  };
}

// =============================================================================
// Scanner
// =============================================================================

export class CopilotProjectScanner {
  private sessionStatePath: string;

  /** Cache of workspace metadata keyed by session UUID */
  private metadataCache = new Map<string, CopilotWorkspaceMetadata>();

  constructor(sessionStatePath?: string) {
    this.sessionStatePath = sessionStatePath ?? getCopilotSessionStatePath();
  }

  // ===========================================================================
  // Project Scanning
  // ===========================================================================

  /**
   * Scans ~/.copilot/session-state/ and returns projects grouped by cwd.
   * Each unique cwd becomes a separate Project with `copilot::` prefixed ID.
   */
  async scan(): Promise<Project[]> {
    try {
      if (!fs.existsSync(this.sessionStatePath)) {
        logger.warn(`Copilot session-state directory not found: ${this.sessionStatePath}`);
        return [];
      }

      const sessionDirs = await fs.promises.readdir(this.sessionStatePath, {
        withFileTypes: true,
      });

      // Read all workspace.yaml files in parallel
      const metadataPromises = sessionDirs
        .filter((d) => d.isDirectory() && isUUID(d.name))
        .map((d) => this.readWorkspaceMetadata(d.name));

      const metadataResults = await Promise.allSettled(metadataPromises);

      // Group sessions by cwd → Project
      const projectMap = new Map<string, { metadata: CopilotWorkspaceMetadata[]; cwd: string }>();

      for (const result of metadataResults) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const meta = result.value;
        if (!meta.cwd) continue;

        const key = meta.cwd;
        if (!projectMap.has(key)) {
          projectMap.set(key, { metadata: [], cwd: key });
        }
        projectMap.get(key)!.metadata.push(meta);
      }

      // Convert to Project[]
      const projects: Project[] = [];
      for (const [cwd, group] of projectMap) {
        const encodedCwd = encodePath(cwd);
        const projectId = buildCopilotProjectId(encodedCwd);

        // Sort sessions by most recent first
        group.metadata.sort((a, b) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bTime - aTime;
        });

        const mostRecent = group.metadata[0];
        const mostRecentTime = mostRecent?.updatedAt
          ? new Date(mostRecent.updatedAt).getTime()
          : Date.now();

        const oldestTime = group.metadata.reduce((min, m) => {
          const t = m.createdAt ? new Date(m.createdAt).getTime() : Date.now();
          return t < min ? t : min;
        }, Date.now());

        projects.push({
          id: projectId,
          path: cwd,
          name: `${path.basename(cwd)} (Copilot)`,
          sessions: group.metadata.map((m) => m.id),
          createdAt: oldestTime,
          mostRecentSession: mostRecentTime,
        });
      }

      // Sort by most recent activity
      projects.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));

      logger.info(`Scanned ${projects.length} Copilot projects with ${metadataResults.length} sessions`);
      return projects;
    } catch (error) {
      logger.error('Error scanning Copilot sessions:', error);
      return [];
    }
  }

  // ===========================================================================
  // Session Listing
  // ===========================================================================

  /**
   * List sessions for a Copilot project (identified by copilot:: prefixed ID).
   */
  async listSessions(projectId: string): Promise<Session[]> {
    const projects = await this.scan();
    const project = projects.find((p) => p.id === projectId);

    if (!project) return [];

    const sessions: Session[] = [];
    for (const sessionId of project.sessions) {
      const session = await this.buildSession(sessionId, projectId, project.path);
      if (session) sessions.push(session);
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.createdAt - a.createdAt);
    return sessions;
  }

  // ===========================================================================
  // Session Access
  // ===========================================================================

  /**
   * Get a single session's metadata.
   */
  async getSession(projectId: string, sessionId: string): Promise<Session | null> {
    const projects = await this.scan();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;

    return this.buildSession(sessionId, projectId, project.path);
  }

  /**
   * Get the path to a session's events.jsonl file.
   */
  getEventsPath(sessionId: string): string {
    return buildCopilotEventsPath(this.sessionStatePath, sessionId);
  }

  /**
   * Check whether a session has events.jsonl.
   */
  hasEvents(sessionId: string): boolean {
    return fs.existsSync(this.getEventsPath(sessionId));
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  private async readWorkspaceMetadata(
    sessionId: string
  ): Promise<CopilotWorkspaceMetadata | null> {
    // Check cache
    if (this.metadataCache.has(sessionId)) {
      return this.metadataCache.get(sessionId)!;
    }

    const yamlPath = buildCopilotWorkspacePath(this.sessionStatePath, sessionId);
    try {
      if (!fs.existsSync(yamlPath)) return null;

      const content = await fs.promises.readFile(yamlPath, 'utf-8');
      const metadata = parseWorkspaceYaml(content);

      // Also check that events.jsonl exists
      const eventsPath = buildCopilotEventsPath(this.sessionStatePath, sessionId);
      if (!fs.existsSync(eventsPath)) return null;

      this.metadataCache.set(sessionId, metadata);
      return metadata;
    } catch (error) {
      logger.debug(`Failed to read workspace.yaml for session ${sessionId}:`, error);
      return null;
    }
  }

  private async buildSession(
    sessionId: string,
    projectId: string,
    projectPath: string
  ): Promise<Session | null> {
    const meta = await this.readWorkspaceMetadata(sessionId);
    if (!meta) return null;

    const eventsPath = this.getEventsPath(sessionId);

    // Get file stats for creation time
    let createdAt: number;
    try {
      const stat = await fs.promises.stat(eventsPath);
      createdAt = meta.createdAt
        ? new Date(meta.createdAt).getTime()
        : stat.birthtimeMs;
    } catch {
      createdAt = meta.createdAt ? new Date(meta.createdAt).getTime() : Date.now();
    }

    return {
      id: sessionId,
      projectId,
      projectPath,
      createdAt,
      firstMessage: meta.summary ?? undefined,
      messageTimestamp: meta.createdAt,
      hasSubagents: false, // Will be updated when parsing
      messageCount: 0, // Will be updated when parsing
      gitBranch: meta.branch,
      metadataLevel: 'light',
    };
  }

  /**
   * Clears the internal metadata cache (for file-change invalidation).
   */
  clearCache(): void {
    this.metadataCache.clear();
  }
}
