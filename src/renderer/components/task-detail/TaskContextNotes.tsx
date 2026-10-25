import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { taskNumber } from '../../../shared/utils/queue-grooming';
import { loadTasks } from '../../stores/task-store';
import type { Task } from '../../../shared/types';

interface TaskContextNotesProps {
  task: Task;
}

/**
 * The notes added to this ticket after other tasks merged (queue grooming). The text is also part
 * of the description; Undo takes a note out of both.
 */
export function TaskContextNotes({ task }: TaskContextNotesProps) {
  const { t } = useTranslation('tasks');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notes = task.metadata?.contextNotes;
  if (!notes || notes.length === 0) return null;

  const undo = async (noteId: string) => {
    setBusyId(noteId);
    setError(null);
    try {
      const result = await window.electronAPI.undoContextNote(task.projectId, task.id, noteId);
      if (!result.success) setError(t('queueGrooming.undoFailed', { error: result.error ?? '' }));
      else await loadTasks(task.projectId);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label={t('queueGrooming.notesTitle')} className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground">{t('queueGrooming.notesTitle')}</h3>
      <p className="mt-0.5 text-xs text-(--nav-label-color)">{t('queueGrooming.notesDescription')}</p>
      <ul className="mt-2 space-y-2">
        {notes.map((note) => (
          <li key={note.id} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-(--nav-label-color)">{t('queueGrooming.noteFrom', { number: taskNumber(note.fromTaskId) })}</p>
              <p className="text-sm text-foreground wrap-anywhere">{note.note}</p>
            </div>
            <Button size="sm" variant="ghost" disabled={busyId === note.id} onClick={() => void undo(note.id)}>
              {t('queueGrooming.undo')}
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
