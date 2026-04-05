/**
 * HTTP route handlers for Project Operations.
 *
 * Routes:
 * - GET /api/projects - List all projects
 * - GET /api/repository-groups - List projects grouped by git repository
 * - GET /api/worktrees/:id/sessions - List sessions for a worktree
 */

import { createLogger } from '@shared/utils/logger';

import { validateProjectId } from '../ipc/guards';

import type { HttpServices } from './index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:projects');

export function registerProjectRoutes(app: FastifyInstance, services: HttpServices): void {
  app.get('/api/projects', async () => {
    try {
      const claudeProjects = await services.projectScanner.scan();

      // Merge Copilot CLI projects if available
      if (services.copilotScanner) {
        try {
          const copilotProjects = await services.copilotScanner.scan();
          return [...claudeProjects, ...copilotProjects];
        } catch (error) {
          logger.error('Error scanning Copilot projects (continuing with Claude only):', error);
        }
      }

      return claudeProjects;
    } catch (error) {
      logger.error('Error in GET /api/projects:', error);
      return [];
    }
  });

  app.get('/api/repository-groups', async () => {
    try {
      const groups = await services.projectScanner.scanWithWorktreeGrouping();

      // Merge Copilot CLI projects as repository groups
      if (services.copilotScanner) {
        try {
          const copilotProjects = await services.copilotScanner.scan();
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
      logger.error('Error in GET /api/repository-groups:', error);
      return [];
    }
  });

  app.get<{ Params: { id: string } }>('/api/worktrees/:id/sessions', async (request) => {
    try {
      const validated = validateProjectId(request.params.id);
      if (!validated.valid) {
        logger.error(`GET /api/worktrees/:id/sessions rejected: ${validated.error ?? 'unknown'}`);
        return [];
      }

      const sessions = await services.projectScanner.listWorktreeSessions(validated.value!);
      return sessions;
    } catch (error) {
      logger.error(`Error in GET /api/worktrees/${request.params.id}/sessions:`, error);
      return [];
    }
  });
}
