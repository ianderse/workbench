/** Resolve review materials in the task's checkout, never a similarly named file in another project. */
import { open, readdir, realpath, stat } from 'fs/promises';
import path from 'path';
import type { Project, Task } from '../../shared/types';
import type { HumanReviewArtifact, HumanReviewPacket } from '../../shared/types/human-work';
import { findTaskWorktree, isPathWithinBase } from '../worktree-paths';

const image = /\.(png|webp|jpe?g|svg)$/i;
const readable = /\.(md|txt|json|png|webp|jpe?g|svg|html?)$/i;
export async function reviewArtifactPath(root: string, reference: string): Promise<string | undefined> {
  if (!reference || reference.length > 1000 || /[\0\r\n]|^[a-z]+:|^[/\\]/i.test(reference)) return undefined;
  const candidate = path.resolve(root, reference);
  if (!isPathWithinBase(candidate, root)) return undefined;
  try { const resolved = await realpath(candidate); return isPathWithinBase(resolved, root) ? resolved : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function textFile(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try { const buffer = Buffer.alloc(128_000); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead).toString('utf8'); }
  finally { await handle.close(); }
}
async function countImages(dir: string): Promise<number | undefined> {
  let visited = 0, count = 0, complete = true;
  const scan = async (folder: string, depth: number) => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (++visited > 500) { complete = false; return; }
      if (item.isFile() && image.test(item.name)) count++;
      else if (item.isDirectory()) { if (depth < 2) await scan(path.join(folder, item.name), depth + 1); else complete = false; }
    }
  };
  await scan(dir, 0); return complete ? count : undefined;
}
export async function getHumanReviewPacket(project: Project, task: Task): Promise<HumanReviewPacket> {
  const worktree = findTaskWorktree(project.path, task.specId);
  const root = await realpath(worktree ?? project.path);
  if (!isPathWithinBase(root, await realpath(project.path))) throw new Error('Task worktree is outside this project');
  const references = new Map<string, { label: string; kind: HumanReviewArtifact['kind'] }>();
  const add = (reference: string, label: string, kind: HumanReviewArtifact['kind']) => {
    const relative = path.normalize(reference.replace(/[#?].*$/, '').replace(/:\d+$/, '')).replace(/[\\/]+$/, '');
    if (relative && references.size < 128 && !references.has(relative) && relative !== '.' && !path.isAbsolute(relative) && !relative.startsWith('..') && !/^[a-z]+:|[\0\r\n]/i.test(relative)) references.set(relative, { label, kind });
  };
  const findings = task.claudeRun?.reviewVerdict?.failure?.openFindings ?? [];
  for (const finding of [...findings, ...(task.metadata?.humanWork?.items.map(item => item.finding) ?? [])]) if (finding.file) add(finding.file, path.basename(finding.file), 'report');
  const sources = [...references.keys()].slice(0, 4);
  let limitations: string | undefined;
  for (const file of sources) {
    const resolved = await reviewArtifactPath(root, file);
    if (!resolved || !/\.md$/i.test(file)) continue;
    const text = await textFile(resolved);
    const section = text.match(/^##\s+[^\n]*(?:limitations|known issues)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im)?.[1]?.trim();
    if (!limitations && section) limitations = section.slice(0, 1600);
    for (const match of text.matchAll(/!?\[([^\]]*)\]\(([^\s)]+)\)/g)) {
      const [, label, ref] = match;
      if (/^[a-z]+:|^#|^[/\\]/i.test(ref)) continue;
      const relative = path.join(path.dirname(file), ref);
      const kind = /protocol|recording|checklist/i.test(label + ref) ? 'protocol' : /gallery|comparison|matrix/i.test(label + ref) ? 'gallery' : /art[\\/]source|assets[\\/]/i.test(relative) ? 'asset' : 'other';
      if (match[0].startsWith('![')) add(path.dirname(relative), path.basename(path.dirname(relative)), 'gallery');
      else add(relative, label || path.basename(relative), kind);
      if (kind === 'gallery' && /\.json$/i.test(relative)) add(path.dirname(relative), path.basename(path.dirname(relative)), 'gallery');
      if (/art[\\/]source/.test(relative)) add('art/source/generated', 'art/source/generated', 'asset');
    }
  }
  if ([...references.keys()].some(ref => /art[\\/]source/.test(ref))) add('art/source/generated', 'art/source/generated', 'asset');
  // Useful links first; do not bury the protocol under individual screenshots.
  const galleryRank = (ref: string) => (/gallery|comparison/i.test(ref) ? 0 : 100) + (path.extname(ref) ? 50 : 0) + ref.split(/[\\/]/).length;
  const ranked = [...references.entries()].sort((a, b) => ['report', 'protocol', 'gallery', 'asset', 'other'].indexOf(a[1].kind) - ['report', 'protocol', 'gallery', 'asset', 'other'].indexOf(b[1].kind)
    || (a[1].kind === 'gallery' ? galleryRank(a[0]) - galleryRank(b[0]) : 0));
  const artifacts: HumanReviewArtifact[] = [];
  const counts = { report: 0, protocol: 0, gallery: 0, asset: 0, other: 0 };
  const caps = { report: 2, protocol: 3, gallery: 3, asset: 5, other: 3 };
  for (const [relative, info] of ranked.filter(([, info]) => counts[info.kind]++ < caps[info.kind])) {
    const resolved = await reviewArtifactPath(root, relative);
    const details = resolved ? await stat(resolved) : undefined;
    if (details?.isFile() && !readable.test(relative)) continue;
    artifacts.push({ path: relative, ...info, available: !!details, ...(details?.isDirectory() ? { directory: true, imageCount: await countImages(resolved!) } : {}) });
  }
  return { root, location: worktree ? 'worktree' : 'project', artifacts, ...(limitations ? { limitations } : {}) };
}
