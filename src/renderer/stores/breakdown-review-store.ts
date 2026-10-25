/**
 * A Break into tasks proposal the user chose to review (from the Queue updates panel): the task
 * dialog opens on its review step with it, then clears it.
 */
import { create } from 'zustand';
import type { TaskBreakdown } from '../../shared/types/task-breakdown';

export interface PendingBreakdownReview {
  projectId: string;
  /** The stored proposal; dismissed once the tickets are created or discarded */
  proposalId: string;
  prompt: string;
  breakdown: TaskBreakdown;
}

interface BreakdownReviewState {
  pending: PendingBreakdownReview | null;
  request: (pending: PendingBreakdownReview) => void;
  clear: () => void;
}

export const useBreakdownReviewStore = create<BreakdownReviewState>((set) => ({
  pending: null,
  request: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
}));
