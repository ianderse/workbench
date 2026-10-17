import { ProjectAPI, createProjectAPI } from './project-api';
import { TerminalAPI, createTerminalAPI } from './terminal-api';
import { TaskAPI, createTaskAPI } from './task-api';
import { SettingsAPI, createSettingsAPI } from './settings-api';
import { AgentAPI, createAgentAPI } from './agent-api';
import type { InsightsAPI } from './modules/insights-api';
import { AppUpdateAPI, createAppUpdateAPI } from './app-update-api';
import { ClaudeCodeAPI, createClaudeCodeAPI } from './modules/claude-code-api';
import { GraphifyAPI, createGraphifyAPI } from './modules/graphify-api';
import { SelfLearningAPI, createSelfLearningAPI } from './modules/self-learning-api';
import { LiveAgentAPI, createLiveAgentAPI } from './modules/live-agent-api';
import { McpAPI, createMcpAPI } from './modules/mcp-api';
import { ProfileAPI, createProfileAPI } from './profile-api';
import { QueueAPI, createQueueAPI } from './queue-api';

export interface ElectronAPI extends
  ProjectAPI,
  TerminalAPI,
  TaskAPI,
  SettingsAPI,
  AgentAPI,
  InsightsAPI,
  AppUpdateAPI,
  ClaudeCodeAPI,
  GraphifyAPI,
  SelfLearningAPI,
  LiveAgentAPI,
  McpAPI,
  ProfileAPI {
  /** Queue routing API for rate limit recovery */
  queue: QueueAPI;
}

export const createElectronAPI = (): ElectronAPI => ({
  ...createProjectAPI(),
  ...createTerminalAPI(),
  ...createTaskAPI(),
  ...createSettingsAPI(),
  ...createAgentAPI(),  // Includes: Insights, Shell
  ...createAppUpdateAPI(),
  ...createClaudeCodeAPI(),
  ...createGraphifyAPI(),
  ...createSelfLearningAPI(),
  ...createLiveAgentAPI(),
  ...createMcpAPI(),
  ...createProfileAPI(),
  queue: createQueueAPI()  // Queue routing for rate limit recovery
});

// Export individual API creators for potential use in tests or specialized contexts
// Note: InsightsAPI is included in AgentAPI
;

;
