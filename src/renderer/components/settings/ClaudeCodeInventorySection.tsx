/**
 * "Loaded for this project" (Claude Code page): the user's own Claude Code configuration that
 * tasks pick up when Claude Code runs in the selected project (subagents, skills, slash commands,
 * hooks, MCP servers, CLAUDE.md and settings files). Shows the last scan; Refresh scans again.
 */

import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { formatTime } from '../../../shared/utils/format-date-time';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { useClaudeCodeInventory } from './hooks/useClaudeCodeInventory';
import type { ClaudeCodeInventory, ClaudeCodeInventoryItem } from '../../../shared/types/claude-code';

const GROUPS: (keyof ClaudeCodeInventory)[] = [
  'agents',
  'skills',
  'commands',
  'hooks',
  'mcpServers',
  'memoryFiles',
  'settingsFiles'
];

interface ClaudeCodeInventorySectionProps {
  projectPath: string;
  projectName?: string;
}

export function ClaudeCodeInventorySection({ projectPath, projectName }: ClaudeCodeInventorySectionProps) {
  const { t } = useTranslation('settings');
  const { inventory, checkedAt, isLoading, error, refresh } = useClaudeCodeInventory(projectPath);

  const nonEmptyGroups = inventory ? GROUPS.filter((group) => inventory[group].length > 0) : [];
  const emptyGroups = inventory ? GROUPS.filter((group) => inventory[group].length === 0) : [];

  const statusText = isLoading && !inventory
    ? t('claudeCode.inventory.loading')
    : error !== null
      ? (error ? t('claudeCode.inventory.error', { error }) : t('claudeCode.inventory.errorGeneric'))
      : [
          t('claudeCode.inventory.description', { project: projectName ?? projectPath }),
          checkedAt ? t('claudeCode.inventory.lastChecked', { time: formatTime(checkedAt) }) : null
        ]
          .filter(Boolean)
          .join(' · ');

  const renderItem = (item: ClaudeCodeInventoryItem) => (
    <SettingsRow
      key={`${item.scope}:${item.path}:${item.name}`}
      label={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{item.name}</span>
          <span className="shrink-0 text-(--nav-label-color)">{t(`claudeCode.inventory.scopes.${item.scope}`)}</span>
        </span>
      }
      description={
        <span className="block truncate" title={item.path}>
          {item.description?.trim() || item.path}
        </span>
      }
    />
  );

  return (
    <SettingsSection title={t('claudeCode.inventory.title')}>
      <SettingsRows>
        <SettingsRow label={t('claudeCode.inventory.configuration')} description={statusText}>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void refresh()}
            disabled={isLoading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            {t('claudeCode.inventory.refresh')}
          </Button>
        </SettingsRow>
      </SettingsRows>

      {inventory && nonEmptyGroups.length === 0 && (
        <p className="mt-2 text-sm text-(--nav-label-color)">{t('claudeCode.inventory.nothingFound')}</p>
      )}

      {nonEmptyGroups.map((group) => (
        <div key={group} className="mt-5">
          <div className="pb-1 text-xs text-(--nav-label-color)">
            {t(`claudeCode.inventory.groups.${group}`)} · {inventory![group].length}
          </div>
          <SettingsRows>{inventory![group].map(renderItem)}</SettingsRows>
        </div>
      ))}

      {nonEmptyGroups.length > 0 && emptyGroups.length > 0 && (
        <p className="mt-5 text-sm text-(--nav-label-color)">
          {t('claudeCode.inventory.noneFound', {
            groups: emptyGroups.map((group) => t(`claudeCode.inventory.groups.${group}`)).join(', ')
          })}
        </p>
      )}
    </SettingsSection>
  );
}
