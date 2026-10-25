import { useTranslation } from 'react-i18next';
import { taskNumber } from '../../../shared/utils/queue-grooming';
import type { Task } from '../../../shared/types';

interface TaskFollowUpLabelProps {
  task: Task;
}

/** Where a follow-up ticket came from: the review item of another task (and that it needs a decision) */
export function TaskFollowUpLabel({ task }: TaskFollowUpLabelProps) {
  const { t } = useTranslation('tasks');
  const from = task.metadata?.followUpFrom;
  if (!from) return null;
  const key = from.needsDecision ? 'queueGrooming.followUpDetailDecisionLabel' : 'queueGrooming.followUpDetailLabel';
  return (
    <p className="text-xs font-medium text-(--nav-label-color) wrap-anywhere">
      {t(key, { number: taskNumber(from.taskId), item: from.item })}
    </p>
  );
}
