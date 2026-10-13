import { useEffect, useRef, useState } from 'react';
import type { ImageAttachment } from '../../../shared/types';

/** Whether an attachment is an image (shown as a thumbnail rather than a file) */
export function isImageAttachment(attachment: ImageAttachment): boolean {
  if (attachment.mimeType) return attachment.mimeType.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(attachment.filename);
}

/**
 * Thumbnails of a task's saved image attachments (stored without one), loaded from its spec
 * folder. They are kept here by attachment id, for display only, so they never end up in the
 * task's metadata and survive the attachment list being reset (e.g. the edit dialog reopening).
 */
export function useAttachmentThumbnails(
  projectPath: string | undefined,
  specId: string | undefined,
  attachments: ImageAttachment[]
): Record<string, string> {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());

  const missing = attachments
    .filter((attachment) => attachment.path && !attachment.thumbnail && isImageAttachment(attachment))
    .map((attachment) => `${attachment.id}\n${attachment.path}`)
    .join('\0');

  useEffect(() => {
    if (!projectPath || !specId || !missing) return;
    const toLoad = missing
      .split('\0')
      .map((entry) => entry.split('\n') as [string, string])
      .filter(([id]) => !requested.current.has(id));
    for (const [id] of toLoad) requested.current.add(id);
    void (async () => {
      for (const [id, imagePath] of toLoad) {
        try {
          const result = await window.electronAPI.loadImageThumbnail(projectPath, specId, imagePath);
          if (result.success && result.data) setThumbnails((previous) => ({ ...previous, [id]: result.data! }));
        } catch {
          // A missing image keeps its placeholder
        }
      }
    })();
  }, [projectPath, specId, missing]);

  return thumbnails;
}
