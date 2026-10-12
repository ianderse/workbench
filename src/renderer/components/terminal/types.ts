import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import type { Task } from '../../../shared/types';

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
