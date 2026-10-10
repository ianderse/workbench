/**
 * TaskEditDialog - Dialog for editing task details
 *
 * Edits the task's description, reference images and MCP connectors (the title is kept). Model,
 * effort and planning are decided by the Claude Code triage run when the task starts.
 *
 * Uses the shared TaskModalLayout and TaskFormFields (same look as the creation dialog) and
 * saves via persistUpdateTask (updates store + spec files). Closes without saving when nothing
 * changed.
 */
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { TaskModalLayout } from './task-form/TaskModalLayout';
import { TaskFormFields } from './task-form/TaskFormFields';
import { persistUpdateTask } from '../stores/task-store';
import { useProjectStore } from '../stores/project-store';
import type { Task, TaskMetadata, ImageAttachment } from '../../shared/types';
import { useSettingsStore } from '../stores/settings-store';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';

/**
 * Props for the TaskEditDialog component
 */
interface TaskEditDialogProps {
  /** The task to edit */
  task: Task;
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when the dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** Optional callback when task is successfully saved */
  onSaved?: () => void;
}

export function TaskEditDialog({ task, open, onOpenChange, onSaved }: TaskEditDialogProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { settings } = useSettingsStore();

  // Get project path for loading image thumbnails from disk
  const projects = useProjectStore((state) => state.projects);
  const projectPath = useMemo(() => {
    const project = projects.find(p => p.id === task.projectId);
    return project?.path;
  }, [projects, task.projectId]);

  // Form state
  const [description, setDescription] = useState(task.description);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Image attachments
  const [images, setImages] = useState<ImageAttachment[]>(task.metadata?.attachedImages || []);

  // MCP connectors: the task's own choice, or the Connectors defaults for tasks created before
  // connectors were per task. Saving changes only this task
  const taskConnectors = task.metadata?.mcpConnectors ?? getDefaultMcpConnectorIds(settings.mcpConnectors);
  const [mcpConnectors, setMcpConnectors] = useState<string[]>(taskConnectors);

  // Reset form when task changes or dialog opens
  useEffect(() => {
    if (open) {
      setDescription(task.description);
      setImages(task.metadata?.attachedImages || []);
      setMcpConnectors(task.metadata?.mcpConnectors ?? getDefaultMcpConnectorIds(settings.mcpConnectors));
      setError(null);
    }
  }, [open, task, settings.mcpConnectors]);

  const handleSave = async () => {
    // Validate input
    if (!description.trim()) {
      setError(t('tasks:form.errors.descriptionRequired'));
      return;
    }

    // Check if anything changed
    const trimmedDescription = description.trim();
    const hasChanges =
      trimmedDescription !== task.description ||
      [...mcpConnectors].sort().join(',') !== [...taskConnectors].sort().join(',') ||
      JSON.stringify(images) !== JSON.stringify(task.metadata?.attachedImages || []);

    if (!hasChanges) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    setError(null);

    const metadataUpdates: Partial<TaskMetadata> = {
      // Always set attachedImages to persist removal when all images are deleted
      attachedImages: images,
      mcpConnectors
    };

    const success = await persistUpdateTask(task.id, {
      description: trimmedDescription,
      metadata: metadataUpdates
    });

    if (success) {
      onOpenChange(false);
      onSaved?.();
    } else {
      setError(t('tasks:edit.errors.updateFailed'));
    }

    setIsSaving(false);
  };

  const isValid = description.trim().length > 0;

  return (
    <TaskModalLayout
      open={open}
      onOpenChange={onOpenChange}
      title={t('tasks:edit.title')}
      description={t('tasks:edit.description')}
      disabled={isSaving}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('common:buttons.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving || !isValid}>
            {isSaving ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('common:buttons.saving')}
              </>
            ) : (
              t('tasks:edit.saveChanges')
            )}
          </Button>
        </div>
      }
    >
      <TaskFormFields
        projectPath={projectPath}
        specId={task.specId}
        description={description}
        onDescriptionChange={setDescription}
        images={images}
        onImagesChange={setImages}
        mcpConnectors={mcpConnectors}
        onMcpConnectorsChange={setMcpConnectors}
        disabled={isSaving}
        error={error}
        onError={setError}
        idPrefix="edit"
      />
    </TaskModalLayout>
  );
}
