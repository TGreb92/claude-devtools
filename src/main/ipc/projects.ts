/**
 * IPC Handlers for Project Operations.
 *
 * Handlers:
 * - get-projects: List all projects
 * - get-repository-groups: List projects grouped by git repository
 * - get-worktree-sessions: List sessions for a specific worktree
 */

import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';

import { type Project, type RepositoryGroup, type Session } from '../types';

import { validateProjectId } from './guards';

import type { ServiceContextRegistry } from '../services';

const logger = createLogger('IPC:projects');

// Service registry - set via initialize
let registry: ServiceContextRegistry;

/**
 * Initializes project handlers with service registry.
 */
export function initializeProjectHandlers(contextRegistry: ServiceContextRegistry): void {
  registry = contextRegistry;
}

/**
 * Registers all project-related IPC handlers.
 */
export function registerProjectHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('get-projects', handleGetProjects);
  ipcMain.handle('get-repository-groups', handleGetRepositoryGroups);
  ipcMain.handle('get-worktree-sessions', handleGetWorktreeSessions);

  logger.info('Project handlers registered');
}

/**
 * Removes all project IPC handlers.
 */
export function removeProjectHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('get-projects');
  ipcMain.removeHandler('get-repository-groups');
  ipcMain.removeHandler('get-worktree-sessions');

  logger.info('Project handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

/**
 * Handler for 'get-projects' IPC call.
 * Lists all projects from ~/.claude/projects/ and ~/.copilot/session-state/
 */
async function handleGetProjects(_event: IpcMainInvokeEvent): Promise<Project[]> {
  try {
    const ctx = registry.getActive();
    const claudeProjects = await ctx.projectScanner.scan();

    // Merge Copilot CLI projects if available
    if (ctx.copilotScanner) {
      try {
        const copilotProjects = await ctx.copilotScanner.scan();
        return [...claudeProjects, ...copilotProjects];
      } catch (error) {
        logger.error('Error scanning Copilot projects (continuing with Claude only):', error);
      }
    }

    return claudeProjects;
  } catch (error) {
    logger.error('Error in get-projects:', error);
    return [];
  }
}

/**
 * Handler for 'get-repository-groups' IPC call.
 * Lists all projects grouped by git repository.
 * Worktrees of the same repo are grouped together.
 */
async function handleGetRepositoryGroups(_event: IpcMainInvokeEvent): Promise<RepositoryGroup[]> {
  try {
    const ctx = registry.getActive();
    const groups = await ctx.projectScanner.scanWithWorktreeGrouping();

    // Merge Copilot CLI projects as repository groups
    if (ctx.copilotScanner) {
      try {
        const copilotProjects = await ctx.copilotScanner.scan();
        for (const project of copilotProjects) {
          groups.push({
            id: project.id,
            identity: null,
            worktrees: [
              {
                id: project.id,
                path: project.path,
                name: project.name,
                sessions: project.sessions,
                createdAt: project.createdAt,
                mostRecentSession: project.mostRecentSession,
                isMainWorktree: true,
                source: 'unknown' as const,
              },
            ],
            name: project.name,
            mostRecentSession: project.mostRecentSession,
            totalSessions: project.sessions.length,
          });
        }
      } catch (error) {
        logger.error('Error scanning Copilot projects for repository groups:', error);
      }
    }

    return groups;
  } catch (error) {
    logger.error('Error in get-repository-groups:', error);
    return [];
  }
}

/**
 * Handler for 'get-worktree-sessions' IPC call.
 * Lists all sessions for a specific worktree within a repository group.
 */
async function handleGetWorktreeSessions(
  _event: IpcMainInvokeEvent,
  worktreeId: string
): Promise<Session[]> {
  try {
    const validatedProject = validateProjectId(worktreeId);
    if (!validatedProject.valid) {
      logger.error(
        `get-worktree-sessions rejected: ${validatedProject.error ?? 'Invalid worktreeId'}`
      );
      return [];
    }

    const { projectScanner } = registry.getActive();
    const sessions = await projectScanner.listWorktreeSessions(validatedProject.value!);
    return sessions;
  } catch (error) {
    logger.error(`Error in get-worktree-sessions for ${worktreeId}:`, error);
    return [];
  }
}
