import type { CSSProperties } from 'react';
import { cn } from '../../lib/utils';
import { AgentNodeIcon } from '../icons/app-icons';

interface AgentLoaderProps {
  /** Width and height of the agent, in px */
  size?: number;
  /** Read out by screen readers; without it the loader is decoration and the caller labels the area */
  label?: string;
  className?: string;
}

/**
 * The app's loader: the live agent's pentagon node bouncing in place like jelly (squashing on the
 * floor, stretching as it flies) and taking the next of the live agent view's colors (orange,
 * blue, pink) each time it hits the floor, its shadow below in the same color. For anyone who
 * asked for reduced motion it stays put and only changes color. Styles in globals.css.
 */
export function AgentLoader({ size = 24, label, className }: AgentLoaderProps) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('agent-loader', className)}
      style={{ '--agent-loader-size': `${size}px` } as CSSProperties}
    >
      <span className="agent-loader-body">
        <AgentNodeIcon style={{ width: size, height: size }} />
      </span>
      <span className="agent-loader-shadow" />
    </span>
  );
}
