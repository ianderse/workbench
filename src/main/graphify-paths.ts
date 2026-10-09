/**
 * Where Graphify keeps a project's memory graph, without the rest of the Graphify integration
 * (so the terminals can point Claude Code's /graphify command at it cheaply)
 */

import path from 'path';
import { promises as fs } from 'fs';

/** Where a project's memory graph is stored */
export function getGraphifyMemoryDir(projectPath: string): string {
  return path.join(projectPath, '.auto-claude', 'memory');
}

/** Graphify's output directory for a project (its GRAPHIFY_OUT) */
export function getGraphifyOutDir(projectPath: string): string {
  return path.join(getGraphifyMemoryDir(projectPath), 'graphify-out');
}

/** The graph file Graphify writes for a project */
export function getGraphifyGraphPath(projectPath: string): string {
  return path.join(getGraphifyOutDir(projectPath), 'graph.json');
}

/** Whether the project has a memory graph (.auto-claude/memory/graphify-out/graph.json) */
export async function hasGraphifyGraph(projectPath: string): Promise<boolean> {
  try {
    await fs.access(getGraphifyGraphPath(projectPath));
    return true;
  } catch {
    return false;
  }
}
