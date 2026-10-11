/**
 * types.test.ts — Verify type exports and nativePlugin compile correctly.
 * Runtime smoke tests for type-level constructs.
 */

import { describe, it, expect } from 'vitest';
import {
  type Memory,
  type MemoryType,
  type MemorySource,
  type UniversalPhase,
  type WorkUnitRef,
  type MemoryRecordEntry
} from '../types';

describe('Type shape validation (compile-time checks)', () => {
  it('MemoryType values are assignable', () => {
    const types: MemoryType[] = [
      'gotcha',
      'decision',
      'preference',
      'pattern',
      'requirement',
      'error_pattern',
      'module_insight',
      'prefetch_pattern',
      'work_state',
      'causal_dependency',
      'task_calibration',
      'e2e_observation',
      'dead_end',
      'work_unit_outcome',
      'workflow_recipe',
      'context_cost',
    ];
    expect(types).toHaveLength(16);
  });

  it('MemorySource values are assignable', () => {
    const sources: MemorySource[] = [
      'agent_explicit',
      'observer_inferred',
      'qa_auto',
      'mcp_auto',
      'commit_auto',
      'user_taught',
    ];
    expect(sources).toHaveLength(6);
  });

  it('UniversalPhase values are assignable', () => {
    const phases: UniversalPhase[] = [
      'define',
      'implement',
      'validate',
      'refine',
      'explore',
      'reflect',
    ];
    expect(phases).toHaveLength(6);
  });

  it('Memory interface can be constructed', () => {
    const memory: Memory = {
      id: 'test-id',
      type: 'gotcha',
      content: 'Test content',
      confidence: 0.9,
      tags: ['typescript', 'electron'],
      relatedFiles: ['src/main/index.ts'],
      relatedModules: ['main'],
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
      scope: 'global',
      source: 'user_taught',
      sessionId: 'session-001',
      provenanceSessionIds: [],
      projectId: 'test-project',
    };
    expect(memory.type).toBe('gotcha');
    expect(memory.source).toBe('user_taught');
  });

  it('MemoryRecordEntry can be constructed', () => {
    const entry: MemoryRecordEntry = {
      type: 'error_pattern',
      content: 'This error occurs when...',
      projectId: 'my-project',
      confidence: 0.85,
      source: 'qa_auto',
    };
    expect(entry.type).toBe('error_pattern');
  });

  it('WorkUnitRef can be constructed', () => {
    const ref: WorkUnitRef = {
      methodology: 'native',
      hierarchy: ['spec_042'],
      label: 'Spec 042',
    };
    expect(ref.methodology).toBe('native');
  });
});
