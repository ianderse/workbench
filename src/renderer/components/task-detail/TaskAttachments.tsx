import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../ui/collapsible';
import { ImagePreviewModal } from '../task-form/ImagePreviewModal';
import { AttachmentTile } from '../task-form/AttachmentTile';
import { useAttachmentThumbnails } from '../task-form/useAttachmentThumbnails';
import { useProjectStore } from '../../stores/project-store';
import { cn } from '../../lib/utils';
import type { ImageAttachment, Task } from '../../../shared/types';

interface TaskAttachmentsProps {
  task: Task;
  attachments: ImageAttachment[];
}

/**
 * The files attached to a task's description, as a collapsible "Attachments" section like Logs:
 * images as thumbnails that open a preview, other files by name (same tiles as the task form).
 */
export function TaskAttachments({ task, attachments }: TaskAttachmentsProps) {
  const { t } = useTranslation(['tasks']);
  const [isExpanded, setIsExpanded] = useState(false);
  const [preview, setPreview] = useState<ImageAttachment | null>(null);
  const projects = useProjectStore((state) => state.projects);
  const projectPath = useMemo(
    () => projects.find((p) => p.id === task.projectId)?.path,
    [projects, task.projectId]
  );
  const thumbnails = useAttachmentThumbnails(projectPath, task.specId, attachments);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        {/* Same ghost trigger as the Logs section */}
        <button
          type="button"
          className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left outline-none transition-colors hover:bg-nav-hover focus-visible:shadow-(--shadow-focus) data-[state=open]:bg-nav-hover"
        >
          <span className="text-sm text-foreground">{t('tasks:detail.attachments')}</span>
          <span className="text-xs text-(--nav-label-color) tabular-nums">
            {t('tasks:detail.attachmentCount', { count: attachments.length })}
          </span>
          <ChevronDown
            className={cn(
              'ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              isExpanded && 'rotate-180'
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-wrap items-center gap-3 px-3 py-3">
          {attachments.map((attachment) => (
            <AttachmentTile key={attachment.id} attachment={attachment} thumbnail={thumbnails[attachment.id]} onPreview={setPreview} />
          ))}
        </div>
      </CollapsibleContent>
      <ImagePreviewModal open={preview !== null} onOpenChange={(open) => !open && setPreview(null)} image={preview} />
    </Collapsible>
  );
}
