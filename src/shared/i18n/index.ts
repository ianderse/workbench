import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Import English translation resources
import enCommon from './locales/en/common.json';
import enNavigation from './locales/en/navigation.json';
import enSettings from './locales/en/settings.json';
import enTasks from './locales/en/tasks.json';
import enWelcome from './locales/en/welcome.json';
import enDialogs from './locales/en/dialogs.json';
import enTaskReview from './locales/en/taskReview.json';
import enTerminal from './locales/en/terminal.json';
import enErrors from './locales/en/errors.json';
import enUsage from './locales/en/usage.json';
import enMemory from './locales/en/memory.json';


const defaultNS = 'common';

const resources = {
  en: {
    common: enCommon,
    navigation: enNavigation,
    settings: enSettings,
    tasks: enTasks,
    welcome: enWelcome,
    dialogs: enDialogs,
    taskReview: enTaskReview,
    terminal: enTerminal,
    errors: enErrors,
    usage: enUsage,
    memory: enMemory
  }
} as const;

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'en',
    fallbackLng: 'en',
    defaultNS,
    ns: ['common', 'navigation', 'settings', 'tasks', 'welcome', 'dialogs', 'taskReview', 'terminal', 'errors', 'usage', 'memory'],
    interpolation: {
      escapeValue: false, // React already escapes values
      // Agent backend names, available to every string as {{agent}} / {{agentCli}} (see setAgentBackendNames)
      defaultVariables: { agent: 'Claude', agentCli: 'Claude Code' }
    },
    react: {
      useSuspense: false // Disable suspense for Electron compatibility
    }
  });

/**
 * Point {{agent}} / {{agentCli}} at the active agent backend and re-render translated components
 * (react-i18next re-renders on languageChanged).
 */
export function setAgentBackendNames(kind: 'claude' | 'omp' | undefined): void {
  const vars = kind === 'omp' ? { agent: 'OMP', agentCli: 'OMP' } : { agent: 'Claude', agentCli: 'Claude Code' };
  const current = i18n.options.interpolation?.defaultVariables as { agent?: string } | undefined;
  if (current?.agent === vars.agent) return;
  i18n.options.interpolation = { ...i18n.options.interpolation, defaultVariables: vars };
  i18n.emit('languageChanged', i18n.language);
}

/** @internal The configured instance, for tests (the app loads this module for its side effects) */
export default i18n;
