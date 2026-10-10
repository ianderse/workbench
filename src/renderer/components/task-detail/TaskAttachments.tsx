import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon } from 'lucide-react';
import { ImagePreviewModal } from '../task-form/ImagePreviewModal';
import { useProjectStore } from '../../stores/project-store';
import type { ImageAttachment, Task } from '../../../shared/types';

interface TaskAttachmentsProps {
  task: Task;
  images: ImageAttachment[];
}

/**
 * Read-only reference images of a task (same thumbnails as the task form); click to preview.
 * Thumbnails missing from the task metadata are loaded from the spec folder.
 */
export function TaskAttachments({ task, images }: TaskAttachmentsProps) {
  const { t } = useTranslation(['tasks']);
  const [preview, setPreview] = useState<ImageAttachment | null>(null);
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const projects = useProjectStore((state) => state.projects);
  const projectPath = useMemo(
    () => projects.find((p) => p.id === task.projectId)?.path,
    [projects, task.projectId]
  );

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    const missing = images.filter((img) => img.path && !img.thumbnail);
    void (async () => {
      const next: Record<string, string> = {};
      for (const image of missing) {
        try {
          const result = await window.electronAPI.loadImageThumbnail(projectPath, task.specId, image.path!);
          if (result.success && result.data) next[image.id] = result.data;
        } catch {
          // A missing image keeps its placeholder
        }
      }
      if (!cancelled && Object.keys(next).length > 0) setLoaded((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [images, projectPath, task.specId]);

  const withThumbnails = images.map((img) => (img.thumbnail || !loaded[img.id] ? img : { ...img, thumbnail: loaded[img.id] }));

  return (
    <div className="space-y-2">
      <div className="text-sm text-foreground">{t('tasks:detail.attachments')}</div>
      <div className="flex flex-wrap items-center gap-3">
        {withThumbnails.map((image) => (
          <button
            key={image.id}
            type="button"
            onClick={() => setPreview(image)}
            title={image.filename}
            className="block h-14 w-14 cursor-zoom-in overflow-hidden rounded-lg border border-border focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
            aria-label={t('tasks:referenceImages.preview', { filename: image.filename })}
          >
            {image.thumbnail ? (
              <img src={image.thumbnail} alt={image.filename} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center bg-segment-track">
                <ImageIcon className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
              </span>
            )}
          </button>
        ))}
      </div>
      <ImagePreviewModal open={preview !== null} onOpenChange={(open) => !open && setPreview(null)} image={preview} />
    </div>
  );
}
