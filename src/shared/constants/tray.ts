/**
 * System tray (background mode) constants.
 * Labels are keyed by app language (main-process menus can't use react-i18next).
 *
 * With more than one project window open, "Show App" is replaced by one entry per window,
 * labelled with the project it shows.
 */

export interface TrayMenuLabels {
  tooltip: string;
  showApp: string;
  /** e.g. "Max plan"; `{{plan}}` is the capitalized subscription type */
  plan: string;
  /** Current 5-hour session usage */
  usage: string;
  /** Label of a window that shows no project yet (multi-window menu) */
  noProject: string;
  quit: string;
}

export const TRAY_MENU_LABELS: Record<string, TrayMenuLabels> = {
  en: {
    tooltip: 'Workbench',
    showApp: 'Show App',
    plan: '{{plan}} plan',
    usage: 'Usage: {{percent}}%',
    noProject: 'No project',
    quit: 'Quit'
  }
};
