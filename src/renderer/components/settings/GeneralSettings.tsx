import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Input } from '../ui/input';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { useIsOmpBackend } from '../../hooks/useIsOmpBackend';
import type {
  AppSettings,
  ShellRuntimeStatus,
  ToolDetectionResult,
  WslToolPaths
} from '../../../shared/types';

interface GeneralSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  /** Only the paths section is left on this component */
  section: 'paths';
}

type PathsTool = keyof WslToolPaths;

interface ToolsInfo {
  python: ToolDetectionResult;
  git: ToolDetectionResult;
  gh: ToolDetectionResult;
  glab: ToolDetectionResult;
  claude: ToolDetectionResult;
}

/** One row per tool: its native settings key and translation keys, and an example Linux path */
const PATH_TOOLS: Array<{
  tool: PathsTool;
  field: 'pythonPath' | 'gitPath' | 'githubCLIPath' | 'gitlabCLIPath' | 'claudePath';
  wslExample: string;
}> = [
  { tool: 'python', field: 'pythonPath', wslExample: '/usr/bin/python3' },
  { tool: 'git', field: 'gitPath', wslExample: '/usr/bin/git' },
  { tool: 'gh', field: 'githubCLIPath', wslExample: '/usr/bin/gh' },
  { tool: 'glab', field: 'gitlabCLIPath', wslExample: '/usr/bin/glab' },
  { tool: 'claude', field: 'claudePath', wslExample: '/usr/local/bin/claude' }
];

/**
 * Helper component to display auto-detected CLI tool information
 */
interface ToolDetectionDisplayProps {
  info: ToolDetectionResult | null;
  isLoading: boolean;
  /** Tools run inside WSL in this session */
  inWsl: boolean;
}

function ToolDetectionDisplay({ info, isLoading, inWsl }: ToolDetectionDisplayProps) {
  const { t } = useTranslation('settings');
  const className = 'text-xs text-(--nav-label-color)';

  if (isLoading) {
    return <div className={className}>{t('general.detecting')}</div>;
  }

  if (!info || !info.found) {
    return <div className={className}>{t(inWsl ? 'general.notDetectedWsl' : 'general.notDetected')}</div>;
  }

  const getSourceLabel = (source: ToolDetectionResult['source']): string => {
    const sourceMap: Record<ToolDetectionResult['source'], string> = {
      'user-config': t('general.sourceUserConfig'),
      'venv': t('general.sourceVenv'),
      'homebrew': t('general.sourceHomebrew'),
      'nvm': t('general.sourceNvm'),
      'system-path': t('general.sourceSystemPath'),
      'bundled': t('general.sourceBundled'),
      'wsl': t('general.sourceWsl'),
      'fallback': t('general.sourceFallback'),
    };
    return sourceMap[source] || source;
  };

  // One muted line: "Auto-detected: /usr/bin/git · Version 2.43.0 · System PATH"
  return (
    <div className={`${className} truncate`} title={info.path}>
      {t('general.detectedPath')}: <span className="font-mono">{info.path}</span>
      {info.version && ` · ${t('general.detectedVersion')} ${info.version}`}
      {` · ${getSourceLabel(info.source)}`}
    </div>
  );
}

/**
 * Paths settings (Developer page): CLI tool and framework paths. While the app runs its tools in
 * WSL (Settings > General > Shell), the page shows the tools found inside WSL and the inputs edit
 * the Linux paths (`wslToolPaths`), so the Windows paths stay as they are for PWSH.
 */
export function GeneralSettings({ settings, onSettingsChange }: GeneralSettingsProps) {
  const { t } = useTranslation('settings');
  const isOmp = useIsOmpBackend();
  // The Claude CLI path only matters to Claude Code (OMP's command is set under Agents)
  const pathTools = isOmp ? PATH_TOOLS.filter(({ tool }) => tool !== 'claude') : PATH_TOOLS;
  const [toolsInfo, setToolsInfo] = useState<ToolsInfo | null>(null);
  const [runtime, setRuntime] = useState<ShellRuntimeStatus | null>(null);
  const [isLoadingTools, setIsLoadingTools] = useState(false);

  // Detection runs once at app start in the main process and is reused there, so asking again
  // when the page opens doesn't detect again. The runtime status is read after the tools info,
  // which waits for WSL detection when WSL is configured.
  useEffect(() => {
    let cancelled = false;
    setIsLoadingTools(true);
    window.electronAPI
      .getCliToolsInfo()
      .then((result: { success: boolean; data?: ToolsInfo }) => {
        if (!cancelled && result.success && result.data) {
          setToolsInfo(result.data);
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to fetch CLI tools info:', error);
      })
      .then(() => window.electronAPI.getShellRuntimeStatus())
      .then((result) => {
        if (!cancelled && result?.success && result.data) {
          setRuntime(result.data);
        }
      })
      .catch(() => {
        // Without the status the page shows the native paths
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTools(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const inWsl = runtime?.supported === true && runtime.active === 'wsl';
  const wslToolPaths = settings.wslToolPaths ?? {};

  const setWslToolPath = (tool: PathsTool, value: string) => {
    const next: WslToolPaths = { ...wslToolPaths };
    if (value) {
      next[tool] = value;
    } else {
      delete next[tool];
    }
    onSettingsChange({ ...settings, wslToolPaths: next });
  };

  return (
    <SettingsSection
      title={t('general.paths')}
      description={t('general.pathsDescription')}
    >
      <SettingsRows>
        {pathTools.map(({ tool, field, wslExample }) => {
          const value = inWsl ? wslToolPaths[tool] ?? '' : settings[field] ?? '';
          const id = inWsl ? `wsl-${field}` : field;
          return (
            <SettingsRow
              key={field}
              label={t(`general.${field}`)}
              description={inWsl ? t('general.wslPathDescription') : t(`general.${field}Description`)}
              htmlFor={id}
              stacked
              footer={!value ? (
                <ToolDetectionDisplay
                  info={toolsInfo?.[tool] || null}
                  isLoading={isLoadingTools}
                  inWsl={inWsl}
                />
              ) : undefined}
            >
              <Input
                id={id}
                placeholder={inWsl
                  ? t('general.wslPathPlaceholder', { example: wslExample })
                  : t(`general.${field}Placeholder`)}
                className="w-full"
                value={value}
                onChange={(e) => inWsl
                  ? setWslToolPath(tool, e.target.value)
                  : onSettingsChange({ ...settings, [field]: e.target.value })}
              />
            </SettingsRow>
          );
        })}
      </SettingsRows>
    </SettingsSection>
  );
}
