import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { AgentOutlineIcon } from '../icons/app-icons';
import { DIALOG_CLOSE_ICON_STROKE } from '../ui/dialog-styles';
import { getTaskSessionBlocker } from '../../../shared/utils/claude-run';
import { useProjectStore } from '../../stores/project-store';
import { getTaskSessionRequest, useTerminalStore } from '../../stores/terminal-store';
import type { Task } from '../../../shared/types';

/**
 * "Open agent" button in the task dialog: opens the task's Claude Code session in a new agent
 * window of its project (Agents page). While the task runs, the window follows the session
 * read-only and resumes it once the task stops. Hidden until the task has a session; disabled
 * when the project has no room for another window (the tooltip says why).
 */
export function TaskOpenAgentButton({ task }: { task: Task }) {
  const { t } = useTranslation(['tasks']);
  const projectPath = useProjectStore((state) => state.projects.find((p) => p.id === task.projectId)?.path);
  const canAddWindow = useTerminalStore((state) => (projectPath ? state.canAddTerminal(projectPath) : false));

  const blocker = getTaskSessionBlocker(task);
  // Nothing to open until Claude Code has started a session for the task
  if (blocker === 'noSession') return null;
  const reason = !projectPath
    ? t('tasks:claudeRun.session.noProject')
    : !canAddWindow
      ? t('tasks:claudeRun.session.noRoom')
      : null;
  const label = t('tasks:claudeRun.session.openAgent');

  const handleOpen = () => {
    if (!projectPath || reason) return;
    const request = getTaskSessionRequest(task, projectPath);
    if (request) useTerminalStore.getState().openTaskSession(request);
  };

  return (
    // A disabled button gets no pointer events, so the tooltip text sits on a wrapper
    <span title={reason ?? undefined} className="inline-flex">
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleOpen} disabled={!!reason}>
        <AgentOutlineIcon className="h-[18px] w-[18px]" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
        {label}
      </Button>
    </span>
  );
}
