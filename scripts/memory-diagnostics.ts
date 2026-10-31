/** Read-only local audit. Node 24+ strips the module's erasable TypeScript. */
import { readProjectMemoryDiagnostics } from '../src/main/self-improve/memory-diagnostics.ts';

const projectPath = process.argv[2];
if (!projectPath || process.argv.length > 4) {
  process.stderr.write('Usage: node scripts/memory-diagnostics.ts <project-path> [max-tasks]\n');
  process.exitCode = 2;
} else {
  const maxTasks = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
  if (maxTasks !== undefined && (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 500)) {
    process.stderr.write('max-tasks must be an integer from 1 to 500.\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(await readProjectMemoryDiagnostics({ projectPath, maxTasks }), null, 2) + '\n'); }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Memory diagnostics failed'}\n`); process.exitCode = 1; }
  }
}
