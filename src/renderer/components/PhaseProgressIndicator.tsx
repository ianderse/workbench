import { motion, AnimatePresence } from 'motion/react';
import { memo, useRef, useState, useEffect } from 'react';
import { cn } from '../lib/utils';
import type { ExecutionPhase, Subtask } from '../../shared/types';

interface PhaseProgressIndicatorProps {
  phase?: ExecutionPhase;
  subtasks: Subtask[];
  isStuck?: boolean;
  isRunning?: boolean;
  className?: string;
}

// Bar fill: neutral like the settings dialog's progress bars (the status line names the phase)
const FILL_CLASS = 'bg-foreground/70';

/**
 * Progress bar that adapts based on execution phase:
 * - Planning/Validation: Shows an animated activity bar
 * - Coding: Shows subtask-based progress
 * - Stuck: Shows warning state with interrupted animation
 *
 * Performance: Uses IntersectionObserver to pause animations when not visible
 */
export const PhaseProgressIndicator = memo(function PhaseProgressIndicator({
  phase: rawPhase,
  subtasks,
  isStuck = false,
  isRunning = false,
  className,
}: PhaseProgressIndicatorProps) {
  const phase = rawPhase || 'idle';
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true);
  const prevVisibleRef = useRef(true);

  // Use IntersectionObserver to pause animations when component is not visible
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const nowVisible = entry.isIntersecting;

        if (prevVisibleRef.current !== nowVisible && window.DEBUG) {
          console.log(`[PhaseProgress] Visibility changed: ${prevVisibleRef.current} -> ${nowVisible}, animations ${nowVisible ? 'resumed' : 'paused'}`);
        }

        prevVisibleRef.current = nowVisible;
        setIsVisible(nowVisible);
      },
      { threshold: 0.1 }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Only animate when visible and running
  const shouldAnimate = isVisible && isRunning && !isStuck;

  // Calculate subtask-based progress (for coding phase)
  const completedSubtasks = subtasks.filter((c) => c.status === 'completed').length;
  const totalSubtasks = subtasks.length;
  const subtaskProgress = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

  // Determine if we should show indeterminate (activity) vs determinate (%) progress
  const isIndeterminatePhase = phase === 'planning' || phase === 'qa_review' || phase === 'qa_fixing';
  // Show subtask progress whenever subtasks exist (stops pulsing animation when spec completes)
  const showSubtaskProgress = totalSubtasks > 0;

  return (
    <div ref={containerRef} className={className}>
      {/* Progress bar */}
      <div
        className={cn(
          'relative h-1 w-full overflow-hidden rounded-full',
          isStuck ? 'bg-(--error)/20' : 'bg-segment-track'
        )}
      >
        <AnimatePresence mode="wait">
          {isStuck ? (
            // Stuck/Interrupted state - pulsing warning bar (only animate when visible)
            <motion.div
              key="stuck"
              className="absolute inset-0 bg-(--error)/50"
              initial={{ opacity: 0 }}
              animate={isVisible ? { opacity: [0.3, 0.6, 0.3] } : { opacity: 0.45 }}
              transition={isVisible ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : undefined}
            />
          ) : showSubtaskProgress ? (
            // Determinate progress for coding phase
            <motion.div
              key="determinate"
              className={cn('h-full rounded-full', FILL_CLASS)}
              initial={{ width: 0 }}
              animate={{ width: `${subtaskProgress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          ) : shouldAnimate && isIndeterminatePhase ? (
            // Indeterminate animated progress for planning/validation (only when visible)
            <motion.div
              key="indeterminate"
              className={cn('absolute h-full w-1/3 rounded-full', FILL_CLASS)}
              animate={{
                x: ['-100%', '400%'],
              }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            />
          ) : isRunning && isIndeterminatePhase && !isVisible ? (
            // Static placeholder when not visible but running
            <motion.div
              key="indeterminate-static"
              className={cn('absolute h-full w-1/3 rounded-full left-1/3', FILL_CLASS)}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
});
