import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, ProjectEnvConfig } from '../../shared/types';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { projectStore } from '../project-store';
import { parseEnvFile } from './utils';

/**
 * Register all env-related IPC handlers
 */
export function registerEnvHandlers(
  _getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Environment Configuration Operations
  // ============================================

  /**
   * Generate .env file content from config
   */
  const generateEnvContent = (
    config: Partial<ProjectEnvConfig>,
    existingContent?: string
  ): string => {
    // Parse existing content to preserve comments and structure
    const existingVars = existingContent ? parseEnvFile(existingContent) : {};

    // Update with new values
    if (config.autoBuildModel !== undefined) {
      existingVars['AUTO_BUILD_MODEL'] = config.autoBuildModel;
    }
    // Git/Worktree Settings
    if (config.defaultBranch !== undefined) {
      existingVars['DEFAULT_BRANCH'] = config.defaultBranch;
    }
    if (config.enableFancyUi !== undefined) {
      existingVars['ENABLE_FANCY_UI'] = config.enableFancyUi ? 'true' : 'false';
    }

    // MCP Server Configuration
    if (config.mcpServers) {
      if (config.mcpServers.context7Enabled !== undefined) {
        existingVars['CONTEXT7_ENABLED'] = config.mcpServers.context7Enabled ? 'true' : 'false';
      }
      if (config.mcpServers.electronEnabled !== undefined) {
        existingVars['ELECTRON_MCP_ENABLED'] = config.mcpServers.electronEnabled ? 'true' : 'false';
      }
      if (config.mcpServers.puppeteerEnabled !== undefined) {
        existingVars['PUPPETEER_MCP_ENABLED'] = config.mcpServers.puppeteerEnabled ? 'true' : 'false';
      }
    }

    // Per-agent MCP overrides (add/remove MCPs from specific agents)
    if (config.agentMcpOverrides) {
      // First, clear any existing AGENT_MCP_* entries
      Object.keys(existingVars).forEach(key => {
        if (key.startsWith('AGENT_MCP_')) {
          delete existingVars[key];
        }
      });

      // Add new overrides
      Object.entries(config.agentMcpOverrides).forEach(([agentId, override]) => {
        if (override.add && override.add.length > 0) {
          existingVars[`AGENT_MCP_${agentId}_ADD`] = override.add.join(',');
        }
        if (override.remove && override.remove.length > 0) {
          existingVars[`AGENT_MCP_${agentId}_REMOVE`] = override.remove.join(',');
        }
      });
    }

    // Custom MCP servers (user-defined)
    if (config.customMcpServers !== undefined) {
      if (config.customMcpServers.length > 0) {
        existingVars['CUSTOM_MCP_SERVERS'] = JSON.stringify(config.customMcpServers);
      } else {
        delete existingVars['CUSTOM_MCP_SERVERS'];
      }
    }

    // Generate content with sections
    const content = `# Workbench Framework Environment Variables
# Managed by Workbench UI

# Model override (OPTIONAL)
${existingVars['AUTO_BUILD_MODEL'] ? `AUTO_BUILD_MODEL=${existingVars['AUTO_BUILD_MODEL']}` : '# AUTO_BUILD_MODEL=claude-opus-4-6'}

# =============================================================================
# GIT/WORKTREE SETTINGS (OPTIONAL)
# =============================================================================
# Default base branch for worktree creation
# If not set, Workbench will auto-detect main/master, or fall back to current branch
${existingVars['DEFAULT_BRANCH'] ? `DEFAULT_BRANCH=${existingVars['DEFAULT_BRANCH']}` : '# DEFAULT_BRANCH=main'}

# =============================================================================
# UI SETTINGS (OPTIONAL)
# =============================================================================
${existingVars['ENABLE_FANCY_UI'] !== undefined ? `ENABLE_FANCY_UI=${existingVars['ENABLE_FANCY_UI']}` : '# ENABLE_FANCY_UI=true'}

# =============================================================================
# MCP SERVER CONFIGURATION (per-project overrides)
# =============================================================================
# Context7 documentation lookup (default: enabled)
${existingVars['CONTEXT7_ENABLED'] !== undefined ? `CONTEXT7_ENABLED=${existingVars['CONTEXT7_ENABLED']}` : '# CONTEXT7_ENABLED=true'}
# Electron desktop automation - QA agents only (default: disabled)
${existingVars['ELECTRON_MCP_ENABLED'] !== undefined ? `ELECTRON_MCP_ENABLED=${existingVars['ELECTRON_MCP_ENABLED']}` : '# ELECTRON_MCP_ENABLED=false'}
# Puppeteer browser automation - QA agents only (default: disabled)
${existingVars['PUPPETEER_MCP_ENABLED'] !== undefined ? `PUPPETEER_MCP_ENABLED=${existingVars['PUPPETEER_MCP_ENABLED']}` : '# PUPPETEER_MCP_ENABLED=false'}

# =============================================================================
# PER-AGENT MCP OVERRIDES
# Add or remove MCP servers for specific agents
# Format: AGENT_MCP_<agent_type>_ADD=server1,server2
# Format: AGENT_MCP_<agent_type>_REMOVE=server1,server2
# =============================================================================
${Object.entries(existingVars)
  .filter(([key]) => key.startsWith('AGENT_MCP_'))
  .map(([key, value]) => `${key}=${value}`)
  .join('\n') || '# No per-agent overrides configured'}

# =============================================================================
# CUSTOM MCP SERVERS
# User-defined MCP servers (command-based or HTTP-based)
# JSON format: [{"id":"...","name":"...","type":"command|http",...}]
# =============================================================================
${existingVars['CUSTOM_MCP_SERVERS'] ? `CUSTOM_MCP_SERVERS=${existingVars['CUSTOM_MCP_SERVERS']}` : '# CUSTOM_MCP_SERVERS=[]'}
`;

    return content;
  };

  ipcMain.handle(
    IPC_CHANNELS.ENV_GET,
    async (_, projectId: string): Promise<IPCResult<ProjectEnvConfig>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      const envPath = path.join(project.path, project.autoBuildPath, '.env');

      // Default config
      const config: ProjectEnvConfig = {
        enableFancyUi: true
      };

      // Parse project-specific .env if it exists
      let vars: Record<string, string> = {};
      if (existsSync(envPath)) {
        try {
          const content = readFileSync(envPath, 'utf-8');
          vars = parseEnvFile(content);
        } catch {
          // Continue with empty vars
        }
      }

      if (vars['AUTO_BUILD_MODEL']) {
        config.autoBuildModel = vars['AUTO_BUILD_MODEL'];
      }

      // Git/Worktree config
      if (vars['DEFAULT_BRANCH']) {
        config.defaultBranch = vars['DEFAULT_BRANCH'];
      }

      if (vars['ENABLE_FANCY_UI']?.toLowerCase() === 'false') {
        config.enableFancyUi = false;
      }

      // MCP Server Configuration (per-project overrides)
      // Default: context7=true, electron/puppeteer=false
      config.mcpServers = {
        context7Enabled: vars['CONTEXT7_ENABLED']?.toLowerCase() !== 'false', // default true
        electronEnabled: vars['ELECTRON_MCP_ENABLED']?.toLowerCase() === 'true', // default false
        puppeteerEnabled: vars['PUPPETEER_MCP_ENABLED']?.toLowerCase() === 'true', // default false
      };

      // Parse per-agent MCP overrides (AGENT_MCP_<agent>_ADD/REMOVE)
      const agentMcpOverrides: Record<string, { add?: string[]; remove?: string[] }> = {};
      Object.entries(vars).forEach(([key, value]) => {
        if (key.startsWith('AGENT_MCP_') && key.endsWith('_ADD')) {
          const agentId = key.replace('AGENT_MCP_', '').replace('_ADD', '');
          if (!agentMcpOverrides[agentId]) agentMcpOverrides[agentId] = {};
          agentMcpOverrides[agentId].add = value.split(',').map(s => s.trim()).filter(Boolean);
        } else if (key.startsWith('AGENT_MCP_') && key.endsWith('_REMOVE')) {
          const agentId = key.replace('AGENT_MCP_', '').replace('_REMOVE', '');
          if (!agentMcpOverrides[agentId]) agentMcpOverrides[agentId] = {};
          agentMcpOverrides[agentId].remove = value.split(',').map(s => s.trim()).filter(Boolean);
        }
      });

      if (Object.keys(agentMcpOverrides).length > 0) {
        config.agentMcpOverrides = agentMcpOverrides;
      }

      // Parse custom MCP servers (user-defined)
      if (vars['CUSTOM_MCP_SERVERS']) {
        try {
          config.customMcpServers = JSON.parse(vars['CUSTOM_MCP_SERVERS']);
        } catch {
          // Invalid JSON, ignore
          config.customMcpServers = [];
        }
      }

      return { success: true, data: config };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ENV_UPDATE,
    async (_, projectId: string, config: Partial<ProjectEnvConfig>): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      const envPath = path.join(project.path, project.autoBuildPath, '.env');

      try {
        // Read existing content if file exists (atomic read, no TOCTOU)
        let existingContent: string | undefined;
        try {
          existingContent = readFileSync(envPath, 'utf-8');
        } catch (readErr: unknown) {
          if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') throw readErr;
          // File doesn't exist yet - existingContent stays undefined
        }

        // Generate new content
        const newContent = generateEnvContent(config, existingContent);

        // Write to file
        writeFileSync(envPath, newContent, 'utf-8');

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update .env file'
        };
      }
    }
  );

}
