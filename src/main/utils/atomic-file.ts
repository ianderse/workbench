import { writeFileSync, renameSync, unlinkSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

/**
 * Synchronous variant of writeFileAtomic.
 *
 * Write data to file atomically using temp file and rename.
 * Uses randomBytes for collision-safe temp file naming.
 *
 * NOTE: Unlike writeFileAtomic, this function does NOT create parent directories.
 * The caller must ensure the target directory exists.
 *
 * @param filepath - Target file path
 * @param data - Data to write (string or Buffer)
 * @param encoding - File encoding (default: 'utf-8')
 */
export function writeFileAtomicSync(
  filepath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf-8'
): void {
  const absolutePath = path.resolve(filepath);
  const dir = path.dirname(absolutePath);
  const tempSuffix = randomBytes(8).toString('hex');
  const tempPath = path.join(dir, `.${path.basename(absolutePath)}.tmp.${tempSuffix}`);
  try {
    writeFileSync(tempPath, data, encoding);
    renameSync(tempPath, absolutePath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* ignore cleanup */ }
    throw err;
  }
}

