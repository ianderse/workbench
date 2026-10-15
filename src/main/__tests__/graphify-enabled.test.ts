/**
 * A project's "Use Graphify" switch is on while its .workbench/knowledge folder exists:
 * switching it on creates the folder, switching it off removes it with the graph
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: vi.fn() }));

import { buildGraphifyIndex, hasGraphifyGraph, isGraphifyEnabled, setGraphifyEnabled } from '../graphify';

let project: string;
const knowledgeDir = () => path.join(project, '.workbench', 'knowledge');

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), 'graphify-enabled-'));
  mkdirSync(path.join(project, '.workbench', 'tasks'), { recursive: true });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('Use Graphify', () => {
  it('is off until the project has a .workbench/knowledge folder', async () => {
    expect(await isGraphifyEnabled(project)).toBe(false);
    mkdirSync(knowledgeDir());
    expect(await isGraphifyEnabled(project)).toBe(true);
  });

  it('switching it on creates the folder, switching it off removes it with the graph', async () => {
    await setGraphifyEnabled(project, true);
    expect(existsSync(knowledgeDir())).toBe(true);
    expect(await isGraphifyEnabled(project)).toBe(true);

    mkdirSync(path.join(knowledgeDir(), 'graphify-out'));
    writeFileSync(path.join(knowledgeDir(), 'graphify-out', 'graph.json'), '{}');
    expect(await hasGraphifyGraph(project)).toBe(true);

    await setGraphifyEnabled(project, false);
    expect(existsSync(knowledgeDir())).toBe(false);
    expect(await isGraphifyEnabled(project)).toBe(false);
    expect(await hasGraphifyGraph(project)).toBe(false);
    // The rest of the project's data stays
    expect(existsSync(path.join(project, '.workbench', 'tasks'))).toBe(true);
  });

  it("doesn't build a graph while it is off", async () => {
    await expect(buildGraphifyIndex(project)).rejects.toThrow();
    expect(existsSync(knowledgeDir())).toBe(false);
  });
});
