/**
 * Image attachment helpers (ids, file types, thumbnails, duplicate names) used by the task form,
 * the Claude page and Request changes; uploads themselves go through useImageUpload
 */
import { ALLOWED_IMAGE_TYPES } from '../../shared/constants';

/**
 * Generate a unique ID for images
 */
export function generateImageId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check if a file is a valid image type
 */
export function isValidImageType(file: File): boolean {
  return ALLOWED_IMAGE_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_TYPES)[number]);
}

/**
 * Check if a MIME type is a valid image type
 */
export function isValidImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(mimeType as (typeof ALLOWED_IMAGE_TYPES)[number]);
}

/**
 * Convert a File to base64 data URL
 */
export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Convert a Blob to base64 data URL
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Create a thumbnail from an image data URL
 */
export async function createThumbnail(dataUrl: string, maxSize = 200): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      // Scale down to maxSize while maintaining aspect ratio
      if (width > height) {
        if (width > maxSize) {
          height = (height * maxSize) / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width = (width * maxSize) / height;
          height = maxSize;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve(dataUrl); // Return original if thumbnail fails
    img.src = dataUrl;
  });
}

/**
 * Resolve duplicate filenames by adding timestamp
 */
export function resolveFilename(filename: string, existingFiles: string[]): string {
  if (!existingFiles.includes(filename)) {
    return filename;
  }

  const lastDot = filename.lastIndexOf('.');
  const name = lastDot !== -1 ? filename.substring(0, lastDot) : filename;
  const ext = lastDot !== -1 ? filename.substring(lastDot) : '';
  const timestamp = Date.now();

  return `${name}-${timestamp}${ext}`;
}
