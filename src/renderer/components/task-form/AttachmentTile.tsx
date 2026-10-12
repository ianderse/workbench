import { FileText, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ImageAttachment } from '../../../shared/types';
import { isImageAttachment } from './useAttachmentThumbnails';

interface AttachmentTileProps {
  attachment: ImageAttachment;
  /** Thumbnail loaded separately (saved attachments are stored without one) */
  thumbnail?: string;
  /** Open the image preview */
  onPreview: (attachment: ImageAttachment) => void;
}

/** A task attachment: images as a thumbnail that opens the preview, other files as a named chip */
export function AttachmentTile({ attachment, thumbnail, onPreview }: AttachmentTileProps) {
  const { t } = useTranslation('tasks');
  const shown = attachment.thumbnail || thumbnail;

  if (!isImageAttachment(attachment)) {
    return (
      <div
        title={attachment.filename}
        className="flex h-14 max-w-56 items-center gap-2 overflow-hidden rounded-lg border border-border bg-muted px-3"
      >
        <FileText className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="min-w-0 truncate text-xs text-foreground">{attachment.filename}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onPreview(shown ? { ...attachment, thumbnail: shown } : attachment)}
      title={attachment.filename}
      className="block h-14 w-14 cursor-zoom-in overflow-hidden rounded-lg border border-border focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
      aria-label={t('attachments.preview', { filename: attachment.filename })}
    >
      {shown ? (
        <img src={shown} alt={attachment.filename} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-segment-track">
          <ImageIcon className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
        </span>
      )}
    </button>
  );
}
