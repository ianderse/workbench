import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import type { Task, ExecutionPhase } from '../../../shared/types';
import { Circle, Search, Code2, Wrench, CheckCircle2, AlertCircle, PauseCircle, KeyRound } from 'lucide-react';

export interface TerminalProps {
  id: string;
  cwd?: string;
  projectPath?: string;
  isActive: boolean;
  onClose: () => void;
  onActivate: () => void;
  tasks?: Task[];
  onNewTaskClick?: () => void;
  terminalCount?: number;
  /** Drag handle listeners from useSortable for terminal reordering */
  dragHandleListeners?: SyntheticListenerMap;
  /** Whether this terminal is currently being dragged */
  isDragging?: boolean;
  /** Whether the terminal is expanded to full view */
  isExpanded?: boolean;
  /** Callback to toggle expanded state */
  onToggleExpand?: () => void;
}

export const PHASE_CONFIG: Record<ExecutionPhase, { label: string; color: string; icon: React.ElementType }> = {
  idle: { label: 'Ready', color: 'bg-muted text-muted-foreground', icon: Circle },
  planning: { label: 'Planning', color: 'bg-info/20 text-info', icon: Search },
  coding: { label: 'Coding', color: 'bg-primary/20 text-primary', icon: Code2 },
  rate_limit_paused: { label: 'Rate Limited', color: 'bg-orange-500/20 text-orange-400', icon: PauseCircle },
  auth_failure_paused: { label: 'Auth Required', color: 'bg-red-500/20 text-red-400', icon: KeyRound },
  qa_review: { label: 'QA Review', color: 'bg-warning/20 text-warning', icon: Search },
  qa_fixing: { label: 'Fixing', color: 'bg-warning/20 text-warning', icon: Wrench },
  complete: { label: 'Complete', color: 'bg-success/20 text-success', icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'bg-destructive/20 text-destructive', icon: AlertCircle },
};
