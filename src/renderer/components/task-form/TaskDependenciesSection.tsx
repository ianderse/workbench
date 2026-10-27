import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../../shared/types';
import { isUnstartedDependent } from '../../../shared/utils/dependents-wait';
import { resolveTaskDependencies, wouldCreateDependencyCycle } from '../../../shared/utils/task-dependencies';
import { taskNumber } from '../../../shared/utils/queue-grooming';
import { SettingsSection } from '../settings/SettingsSection';
import { Input } from '../ui/input';

interface TaskDependenciesSectionProps {
  task: Task;
  tasks: readonly Task[];
  value: string[];
  onChange: (refs: string[]) => void;
  autonomous?: boolean;
  disabled?: boolean;
}

/** Edits the same dependency list used by automatic task creation and queue promotion. */
export function TaskDependenciesSection({ task, tasks, value, onChange, autonomous = false, disabled = false }: TaskDependenciesSectionProps) {
  const { t } = useTranslation(['tasks']);
  const [search, setSearch] = useState('');
  const helpId = useId();
  const editable = isUnstartedDependent(task);
  const projectTasks = tasks.filter((ticket) => ticket.projectId === task.projectId);
  const selected = resolveTaskDependencies(projectTasks, { ...task, metadata: { ...task.metadata, dependsOnTaskIds: value } }, autonomous);
  const candidates = projectTasks
    .filter((ticket) => ticket.id !== task.id && !ticket.metadata?.archivedAt && ticket.status !== 'done')
    .filter((ticket) => !value.includes(ticket.id) && !value.includes(ticket.specId))
    .map((ticket) => ({ ref: ticket.id, number: taskNumber(ticket.id), title: ticket.title, state: resolveTaskDependencies(projectTasks, { ...task, metadata: { dependsOnTaskIds: [ticket.id] } }, autonomous)[0].state }));
  const query = search.trim().toLowerCase().replace(/^#/, '');
  const choices = [...selected, ...candidates]
    .filter((dep) => `${dep.number} ${dep.title}`.toLowerCase().includes(query))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

  return (
    <SettingsSection title={t('tasks:metadata.reliesOn')}>
      <p id={helpId} className="mb-3 text-xs text-(--nav-label-color)">
        {t(editable ? 'tasks:dependencyEditor.help' : 'tasks:dependencyEditor.notEditable')}
      </p>
      <Input
        type="search"
        aria-label={t('tasks:dependencyEditor.search')}
        aria-describedby={helpId}
        placeholder={t('tasks:dependencyEditor.search')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={disabled}
        className="mb-2 h-8"
      />
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {choices.map((dep) => {
          const checked = value.includes(dep.ref);
          const cycle = !checked && wouldCreateDependencyCycle(projectTasks, task, dep.ref);
          return (
            <label key={dep.ref} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-nav-hover has-disabled:opacity-60">
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                checked={checked}
                disabled={disabled || !editable || cycle}
                onChange={(event) => onChange(event.target.checked ? [...value, dep.ref] : value.filter((ref) => ref !== dep.ref))}
              />
              <span className="min-w-0 flex-1 wrap-anywhere">#{dep.number}{dep.title && ` ${dep.title}`}</span>
              <span className="shrink-0 text-xs text-(--nav-label-color)">
                {t(cycle ? 'tasks:dependencyEditor.cycle' : `tasks:metadata.reliesOnState.${dep.state}`)}
              </span>
            </label>
          );
        })}
        {choices.length === 0 && <p className="py-2 text-sm text-(--nav-label-color)">{t('tasks:dependencyEditor.empty')}</p>}
      </div>
    </SettingsSection>
  );
}
