/** Durable references used by phase-boundary recovery; raw task/session state stays intact. */
export interface PhaseHandoffReceipt {
  version: 1;
  id: string;
  boundaryKey: string;
  path: string;
  digest: string;
  createdAt: string;
  nextPhase: string;
  reason: string;
  priorSessionId?: string;
  gitFingerprint: string;
  manifestPath: string;
}

export interface SessionEpoch {
  id: string;
  boundaryKey: string;
  reason: string;
  priorSessionId?: string;
  sessionId?: string;
  backend?: 'claude' | 'omp';
  runtime?: 'native' | 'wsl';
  /** Explicit fresh-context requests already consumed, retained across later automatic epochs. */
  manualRequestIds?: string[];
  state: 'prepared' | 'acknowledged' | 'running';
  handoff: PhaseHandoffReceipt;
  createdAt: string;
  updatedAt: string;
}

export interface PhaseProgressEvidence {
  repositoryFingerprint: string;
  failedChecks: string[];
  openFindings: string[];
}

export interface PhaseProgressState {
  version: 1;
  lastEvaluatedPhaseKey?: string;
  evaluatedPhaseKeys: string[];
  lastEvidence?: PhaseProgressEvidence;
  lastValidationSignature?: string;
  consecutiveNoProgress: number;
  freshContextRecoveries: number;
  fallbackRecoveries: number;
  escalationKey?: string;
  updatedAt: string;
}

/** A recovery changes only the next ordinary phase; it never grants another review round. */
export interface PhaseRecoveryIntent {
  id: string;
  action: 'fresh-context' | 'configured-fallback' | 'stalled';
  state: 'pending' | 'applied' | 'failed';
  sourcePhaseKey: string;
  targetPhase?: string;
  model?: string;
  error?: string;
}
