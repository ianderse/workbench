import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Image as ImageIcon, Loader2, Plus, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import {
  generateImageId,
  blobToBase64,
  createThumbnail,
  isValidImageMimeType,
  resolveFilename
} from '../../ImageUpload';
import { cn } from '../../../lib/utils';
import type { ImageAttachment } from '../../../../shared/types';
import {
  MAX_IMAGES_PER_TASK,
  ALLOWED_IMAGE_TYPES_DISPLAY
} from '../../../../shared/constants';

interface QAFeedbackSectionProps {
  feedback: string;
  isSubmitting: boolean;
  onFeedbackChange: (value: string) => void;
  onReject: () => void;
  /** Image attachments for visual feedback - optional for backward compatibility */
  images?: ImageAttachment[];
  /** Callback when images change - optional for backward compatibility */
  onImagesChange?: (images: ImageAttachment[]) => void;
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * "Request changes" composer, styled like the chat composer on the Claude page: the feedback
 * field with attached images, a "+" button to add images (paste and drop work too), and a send
 * button. Enter sends, Shift+Enter adds a line. Claude Code applies the request in the task's
 * session, assessing it first and validating afterwards.
 */
export function QAFeedbackSection({
  feedback,
  isSubmitting,
  onFeedbackChange,
  onReject,
  images = [],
  onImagesChange
}: QAFeedbackSectionProps) {
  const { t } = useTranslation('tasks');
  const imageUploadEnabled = !!onImagesChange;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Grow the field with its content (capped by max-h, then it scrolls)
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [feedback]);

  /** Turn image files (picked, pasted or dropped) into attachments */
  const addImageFiles = useCallback(async (files: File[], source: 'paste' | 'file') => {
    if (!onImagesChange || files.length === 0) return;
    const remainingSlots = MAX_IMAGES_PER_TASK - images.length;
    if (remainingSlots <= 0) {
      setError(t('feedback.maxImagesError', { count: MAX_IMAGES_PER_TASK }));
      return;
    }
    setError(null);

    const newImages: ImageAttachment[] = [];
    const existingFilenames = images.map((img) => img.filename);
    for (const file of files.slice(0, remainingSlots)) {
      if (!isValidImageMimeType(file.type)) {
        setError(t('feedback.invalidTypeError', { types: ALLOWED_IMAGE_TYPES_DISPLAY }));
        continue;
      }
      try {
        const dataUrl = await blobToBase64(file);
        const thumbnail = await createThumbnail(dataUrl);
        const extension = MIME_TO_EXTENSION[file.type] || file.type.split('/')[1] || 'png';
        const baseFilename = source === 'file' && file.name ? file.name : `screenshot-${Date.now()}.${extension}`;
        newImages.push({
          id: generateImageId(),
          filename: resolveFilename(baseFilename, [...existingFilenames, ...newImages.map((img) => img.filename)]),
          mimeType: file.type,
          size: file.size,
          data: dataUrl.split(',')[1], // base64 without the data URL prefix
          thumbnail
        });
      } catch (err) {
        console.error('[QAFeedbackSection] Failed to process image:', err);
        setError(t('feedback.processingError'));
      }
    }
    if (newImages.length > 0) onImagesChange([...images, ...newImages]);
  }, [images, onImagesChange, t]);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onImagesChange) return;
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return; // plain text paste
    e.preventDefault();
    void addImageFiles(files, 'paste');
  }, [addImageFiles, onImagesChange]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!imageUploadEnabled) return;
    e.preventDefault();
    setIsDragOver(true);
  }, [imageUploadEnabled]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!imageUploadEnabled || isSubmitting) return;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'));
    void addImageFiles(files, 'file');
  }, [addImageFiles, imageUploadEnabled, isSubmitting]);

  const handleRemoveImage = useCallback((imageId: string) => {
    onImagesChange?.(images.filter((img) => img.id !== imageId));
    setError(null);
  }, [images, onImagesChange]);

  // Text or images can be sent
  const canSubmit = (!!feedback.trim() || images.length > 0) && !isSubmitting;

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSubmit) onReject();
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm text-foreground">{t('feedback.requestChanges')}</h3>
      <p className="mb-3 text-sm text-(--nav-label-color)">{t('feedback.description')}</p>

      <div
        className={cn(
          'relative rounded-(--radius-composer) bg-card',
          'shadow-[0_4px_20px_rgba(0,0,0,0.075),0_0_0_1px_var(--input)]',
          'transition-shadow duration-150 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.1),0_0_0_1px_var(--input)]'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Attached images */}
        {images.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
            {images.map((image) => (
              <div key={image.id} className="group relative" title={image.filename}>
                <div className="h-14 w-14 overflow-hidden rounded-lg border border-border">
                  {image.thumbnail ? (
                    <img src={image.thumbnail} alt={image.filename} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-muted">
                      <ImageIcon className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
                    </div>
                  )}
                </div>
                {!isSubmitting && (
                  <button
                    type="button"
                    onClick={() => handleRemoveImage(image.id)}
                    className="absolute right-0 top-0 flex h-4 w-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                    title={t('feedback.removeImage')}
                    aria-label={t('feedback.removeImage')}
                  >
                    <X className="h-2.5 w-2.5" strokeWidth={2.5} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={feedback}
          onChange={(e) => onFeedbackChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t('feedback.placeholder')}
          aria-label={t('feedback.requestChanges')}
          spellCheck
          disabled={isSubmitting}
          className={cn(
            'block max-h-72 min-h-[3rem] w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pt-4 pb-1',
            'text-[0.9375rem] leading-relaxed text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60'
          )}
        />

        {/* Toolbar: attach on the left, send on the right */}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          <div className="flex items-center gap-0.5">
            {imageUploadEnabled && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void addImageFiles(files, 'file');
                  }}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isSubmitting || images.length >= MAX_IMAGES_PER_TASK}
                      aria-label={t('feedback.addImages')}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('feedback.addImages')}</TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
          {/* Send appears once there is something to send */}
          {isSubmitting ? (
            <span className="flex h-8 w-8 items-center justify-center text-muted-foreground" aria-label={t('feedback.submitting')}>
              <Loader2 className="h-4 w-4 animate-spin" />
            </span>
          ) : canSubmit ? (
            <button
              type="button"
              onClick={onReject}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90"
              aria-label={t('feedback.send')}
              title={t('feedback.send')}
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
            </button>
          ) : null}
        </div>

        {/* Drag-over overlay */}
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-(--radius-composer) border-2 border-dashed border-primary bg-primary/5">
            <span className="text-sm font-medium text-primary">{t('feedback.dropImages')}</span>
          </div>
        )}
      </div>

      {error && <p className="mt-2 px-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
