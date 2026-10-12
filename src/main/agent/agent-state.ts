/**
 * Profile assignment for a task
 */
interface TaskProfileAssignment {
  profileId: string;
  profileName: string;
  reason: 'proactive' | 'reactive' | 'manual';
  sessionId?: string;
}

interface RunningTask {
  taskId: string;
  projectId?: string;
  startedAt: Date;
}

/**
 * Running tasks and their Claude profile assignments
 */
export class AgentState {
  private running: Map<string, RunningTask> = new Map();

  // Queue routing state (rate limit recovery)
  private taskProfileAssignments: Map<string, TaskProfileAssignment> = new Map();

  /** Mark a task as running */
  addRunning(taskId: string, projectId?: string): void {
    this.running.set(taskId, { taskId, projectId, startedAt: new Date() });
  }

  /** Mark a task as no longer running */
  removeRunning(taskId: string): boolean {
    return this.running.delete(taskId);
  }

  /** Check if a task is running */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** All running task IDs */
  getRunningTaskIds(): string[] {
    return Array.from(this.running.keys());
  }

  /** Clear all state (for testing or cleanup) */
  clear(): void {
    this.running.clear();
    this.taskProfileAssignments.clear();
  }

  // ============================================
  // Queue Routing Methods (Rate Limit Recovery)
  // ============================================

  /** Running tasks grouped by profile */
  getRunningTasksByProfile(): { byProfile: Record<string, string[]>; totalRunning: number } {
    const byProfile: Record<string, string[]> = {};
    let totalRunning = 0;

    for (const [taskId] of this.running) {
      const assignment = this.taskProfileAssignments.get(taskId);
      const profileId = assignment?.profileId || 'default';
      if (!byProfile[profileId]) {
        byProfile[profileId] = [];
      }
      byProfile[profileId].push(taskId);
      totalRunning++;
    }

    return { byProfile, totalRunning };
  }

  /** Assign a profile to a task */
  assignProfileToTask(
    taskId: string,
    profileId: string,
    profileName: string,
    reason: 'proactive' | 'reactive' | 'manual'
  ): void {
    const existing = this.taskProfileAssignments.get(taskId);
    this.taskProfileAssignments.set(taskId, {
      profileId,
      profileName,
      reason,
      sessionId: existing?.sessionId // Preserve session ID if exists
    });
  }

  /** Profile assignment of a task */
  getTaskProfileAssignment(taskId: string): TaskProfileAssignment | undefined {
    return this.taskProfileAssignments.get(taskId);
  }

  /**
   * Update the Claude Code session ID for a task
   *
   * @param profileInfo - Optional profile info when creating a new assignment
   */
  updateTaskSession(
    taskId: string,
    sessionId: string,
    profileInfo?: { profileId: string; profileName: string }
  ): void {
    const assignment = this.taskProfileAssignments.get(taskId);
    if (assignment) {
      assignment.sessionId = sessionId;
    } else {
      this.taskProfileAssignments.set(taskId, {
        profileId: profileInfo?.profileId ?? 'unknown',
        profileName: profileInfo?.profileName ?? 'Unknown',
        reason: 'proactive',
        sessionId
      });
    }
  }

  /** Claude Code session ID of a task */
  getTaskSessionId(taskId: string): string | undefined {
    return this.taskProfileAssignments.get(taskId)?.sessionId;
  }

  /** Clear the profile assignment of a task */
  clearTaskProfileAssignment(taskId: string): void {
    this.taskProfileAssignments.delete(taskId);
  }
}
