import * as fs from 'fs'
import { isWindows } from '../../../platform'

const NEWLINE = 0x0a

/**
 * Read bytes [offset, end) of a file and return only the complete lines in it,
 * plus the byte offset just past the last newline. A trailing partial line
 * (one the writer hasn't finished flushing yet) is left unread, so the next
 * read starting at `nextOffset` picks it up whole. Splitting on the raw bytes
 * also keeps multi-byte UTF-8 characters from being cut in half.
 */
export function readCompleteLines(filePath: string, offset: number, end: number): { lines: string[]; nextOffset: number } {
  if (end <= offset) return { lines: [], nextOffset: offset }
  const fd = fs.openSync(filePath, 'r')
  let buffer: Buffer
  try {
    buffer = Buffer.alloc(end - offset)
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset)
    buffer = buffer.subarray(0, bytesRead)
  } finally {
    fs.closeSync(fd)
  }
  const lastNewline = buffer.lastIndexOf(NEWLINE)
  if (lastNewline === -1) return { lines: [], nextOffset: offset }
  const lines = buffer.subarray(0, lastNewline).toString('utf-8').split(/\r?\n/).filter(Boolean)
  return { lines, nextOffset: offset + lastNewline + 1 }
}

/**
 * Read the complete lines appended to a file since byte offset `lastSize`.
 * `newSize` is the offset to resume from next time; it stops before any
 * trailing partial line. Handles truncation (file shrunk) by resetting to 0.
 */
export function readNewFileLines(
  filePath: string,
  lastSize: number,
): { lines: string[]; newSize: number } | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch { return null /* expected if file was removed */ }

  if (stat.size < lastSize) {
    // File was truncated — start over
    return { lines: [], newSize: 0 }
  }
  if (stat.size === lastSize) return null

  let read: ReturnType<typeof readCompleteLines>
  try {
    read = readCompleteLines(filePath, lastSize, stat.size)
  } catch { return null /* removed or unreadable since the stat; the next read retries */ }
  if (read.nextOffset === lastSize) return null
  return { lines: read.lines, newSize: read.nextOffset }
}

/** Case-fold a path string for comparison on Windows, where the filesystem is
 *  case-insensitive and tools disagree on drive-letter case (`c:\...` vs
 *  `C:\...`). Identity elsewhere. */
export function foldPathCase(p: string): string {
  return isWindows() ? p.toLowerCase() : p
}
