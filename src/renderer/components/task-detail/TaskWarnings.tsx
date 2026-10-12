import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';

interface TaskWarningsProps {
  taskProgress: { completed: number; total: number };
  onResume: () => void;
}

/**
 * Incomplete task notice (claude.ai info box with the action on the right). Stuck tasks have no
 * notice: their label says Stuck and the footer's Retry starts them over.
 */
export function TaskWarnings({ taskProgress, onResume }: TaskWarningsProps) {
  const { t } = useTranslation(['tasks']);

  return (
    <div className="flex items-center gap-4 rounded-xl bg-segment-track px-4 py-3 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground">{t('tasks:warnings.incompleteTitle')}</p>
        <p className="text-(--nav-label-color)">
          {t('tasks:warnings.incompleteDescription', {
            completed: taskProgress.completed,
            total: taskProgress.total
          })}
        </p>
      </div>
      <Button size="sm" onClick={onResume} className="shrink-0">
        {t('tasks:warnings.resume')}
      </Button>
    </div>
  );
}
