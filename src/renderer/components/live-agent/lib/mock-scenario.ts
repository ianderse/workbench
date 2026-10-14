import type { GraphEvent } from './agent-types'

// ─── Rich Mock Scenario ──────────────────────────────────────────────────────
// Demonstrates a full agent session: user prompt → research → parallel subagents
// → implementation → testing with error recovery → completion

const SCENARIO: GraphEvent[] = [
  // ── Agent Spawn & User Prompt ─────────────────────────────────────────────
  { time: 0.0, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
  { time: 0.2, type: 'message', payload: { agent: 'orchestrator' } },
  { time: 1.0, type: 'message', payload: { agent: 'orchestrator' } },

  // ── Phase 1: Codebase Exploration ─────────────────────────────────────────
  { time: 4.0, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Glob' } },
  { time: 4.3, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Glob' } },

  { time: 4.5, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read' } },
  { time: 4.8, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Read' } },

  { time: 5.0, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read' } },
  { time: 5.3, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Read' } },

  { time: 5.5, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Grep' } },
  { time: 5.8, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Grep' } },

  // ── Phase 2: Planning (thinking — deciding on approach) ───────────────────
  { time: 8.0, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'TodoWrite' } },
  { time: 8.2, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'TodoWrite' } },

  // ── Phase 3: Parallel Research via Subagents (thinking — planning delegation)
  { time: 10.2, type: 'agent_spawn', payload: { name: 'explore-agent', parent: 'orchestrator' } },
  { time: 10.2, type: 'agent_spawn', payload: { name: 'research-agent', parent: 'orchestrator' } },

  // explore-agent: reads model file (thinks ~2s first)
  { time: 12.0, type: 'tool_call_start', payload: { agent: 'explore-agent', tool: 'Read' } },
  { time: 12.3, type: 'tool_call_end', payload: { agent: 'explore-agent', tool: 'Read' } },

  // explore-agent: reads config (immediate)
  { time: 12.5, type: 'tool_call_start', payload: { agent: 'explore-agent', tool: 'Read' } },
  { time: 12.8, type: 'tool_call_end', payload: { agent: 'explore-agent', tool: 'Read' } },

  // explore-agent: grep for error handling (immediate)
  { time: 13.0, type: 'tool_call_start', payload: { agent: 'explore-agent', tool: 'Grep' } },
  { time: 13.3, type: 'tool_call_end', payload: { agent: 'explore-agent', tool: 'Grep' } },
  { time: 14.0, type: 'agent_complete', payload: { name: 'explore-agent' } },

  // research-agent: web search (thinks ~2s first; slow: network)
  { time: 12.5, type: 'tool_call_start', payload: { agent: 'research-agent', tool: 'WebSearch' } },
  { time: 15.0, type: 'tool_call_end', payload: { agent: 'research-agent', tool: 'WebSearch' } },

  // research-agent: fetches Stripe docs (immediate — slow: network)
  { time: 15.2, type: 'tool_call_start', payload: { agent: 'research-agent', tool: 'WebFetch' } },
  { time: 18.2, type: 'tool_call_end', payload: { agent: 'research-agent', tool: 'WebFetch' } },

  // research-agent: second search for PayPal (immediate — slow: network)
  { time: 18.4, type: 'tool_call_start', payload: { agent: 'research-agent', tool: 'WebSearch' } },
  { time: 20.7, type: 'tool_call_end', payload: { agent: 'research-agent', tool: 'WebSearch' } },
  { time: 21.5, type: 'agent_complete', payload: { name: 'research-agent' } },

  // ── Phase 4: Implementation (thinking — planning implementation) ──────────
  { time: 22.5, type: 'message', payload: { agent: 'orchestrator' } },

  // Install dependencies (slow: real process)
  { time: 24.0, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Bash' } },
  { time: 29.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Bash' } },

  // Write Stripe adapter (immediate)
  { time: 29.2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Write' } },
  { time: 29.5, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Write' } },

  // Write PayPal adapter (immediate)
  { time: 29.7, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Write' } },
  { time: 30.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Write' } },

  // Write unified gateway (immediate)
  { time: 30.2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Write' } },
  { time: 30.5, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Write' } },

  // Refactor existing payment service (immediate)
  { time: 30.7, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Edit' } },
  { time: 31.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Edit' } },

  // Write webhook handler (immediate)
  { time: 31.2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Write' } },
  { time: 31.5, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Write' } },

  // Edit routes to add webhook endpoints (immediate)
  { time: 31.7, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Edit' } },
  { time: 32.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Edit' } },

  // ── Phase 5: Testing ──────────────────────────────────────────────────────
  { time: 33.8, type: 'agent_spawn', payload: { name: 'test-runner', parent: 'orchestrator' } },

  // Write test files (thinks ~2s first, then chain immediately)
  { time: 35.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Write' } },
  { time: 35.8, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Write' } },

  { time: 36.0, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Write' } },
  { time: 36.3, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Write' } },

  { time: 36.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Write' } },
  { time: 36.8, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Write' } },

  // Run tests — first attempt (immediate — slow: real process)
  { time: 37.0, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Bash' } },
  { time: 41.5, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Bash', isError: true } },

  // Thinking — analyzing error
  { time: 42.0, type: 'message', payload: { agent: 'test-runner' } },

  // Fix: add test setup
  { time: 43.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Write' } },
  { time: 43.8, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Write' } },

  { time: 44.0, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Edit' } },
  { time: 44.3, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Edit' } },

  // Run tests — second attempt (immediate — slow: real process)
  { time: 44.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Bash' } },
  { time: 49.0, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Bash', isError: true } },

  // Fix: correct error classification
  { time: 51.0, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Edit' } },
  { time: 51.3, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Edit' } },

  // Run tests — third attempt (immediate — slow: real process)
  { time: 51.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Bash' } },
  { time: 56.0, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Bash' } },

  { time: 56.5, type: 'agent_complete', payload: { name: 'test-runner' } },

  // ── Phase 6: Final Verification ───────────────────────────────────────────
  { time: 58.5, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Bash' } },
  { time: 62.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Bash' } },

  { time: 62.2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'TodoWrite' } },
  { time: 62.4, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'TodoWrite' } },

  { time: 65.0, type: 'agent_complete', payload: { name: 'orchestrator' } },
]

// Sorted by time (stable, so same-time events keep their order): playback
// stops at the first event that isn't due yet
export const MOCK_SCENARIO: GraphEvent[] = SCENARIO.slice().sort((a, b) => a.time - b.time)
