/**
 * Insights attachments → Claude Code message content
 *
 * Converts files attached in the Insights composer (base64 payloads) into Anthropic content
 * blocks for Claude Code's stream-json input: images become image blocks, PDFs become document
 * blocks, and text/code files are inlined as text. Other binary files are referenced by name only.
 */

import type { ImageAttachment } from '../../shared/types';

/** Image types Claude accepts */
const VISION_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Non-`text/*` MIME types that are still plain text */
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-httpd-php',
  'image/svg+xml',
]);

/** Inlined text is capped so a single large file can't exhaust the context window */
export const MAX_INLINE_TEXT_CHARS = 200_000;

/** How many leading bytes are scanned for NUL bytes when sniffing unknown types */
const BINARY_SNIFF_BYTES = 8192;

export type InsightsContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; title?: string };

function looksLikeText(buffer: Buffer, mimeType: string): boolean {
  if (mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(mimeType)) return true;
  // Unknown or generic types (e.g. source files the OS has no MIME type for): sniff for binary content
  if (mimeType === '' || mimeType === 'application/octet-stream') {
    return !buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  }
  return false;
}

/** Content blocks for the attachments sent with a message */
export function buildAttachmentBlocks(attachments: ImageAttachment[] | undefined): InsightsContentBlock[] {
  if (!attachments || attachments.length === 0) return [];

  const blocks: InsightsContentBlock[] = [];
  for (const attachment of attachments) {
    if (!attachment.data) continue;
    const mimeType = attachment.mimeType || 'application/octet-stream';

    if (VISION_IMAGE_TYPES.has(mimeType)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: attachment.data } });
      continue;
    }

    if (mimeType === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: mimeType, data: attachment.data },
        title: attachment.filename,
      });
      continue;
    }

    const buffer = Buffer.from(attachment.data, 'base64');
    if (looksLikeText(buffer, mimeType)) {
      let text = buffer.toString('utf8');
      const truncated = text.length > MAX_INLINE_TEXT_CHARS;
      if (truncated) text = text.slice(0, MAX_INLINE_TEXT_CHARS);
      blocks.push({
        type: 'text',
        text: `<attached_file name="${attachment.filename}"${truncated ? ' truncated="true"' : ''}>\n${text}\n</attached_file>`,
      });
      continue;
    }

    blocks.push({
      type: 'text',
      text: `[Attached binary file "${attachment.filename}" (${mimeType}, ${attachment.size} bytes): its contents cannot be read]`,
    });
  }
  return blocks;
}

/** The user message for a turn: the prompt followed by its attachments */
export function buildMessageContent(prompt: string, attachments?: ImageAttachment[]): InsightsContentBlock[] {
  return [{ type: 'text', text: prompt }, ...buildAttachmentBlocks(attachments)];
}
