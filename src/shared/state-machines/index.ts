export { taskMachine } from './task-machine';
export type {  TaskEvent } from './task-machine';
export {
  XSTATE_SETTLED_STATES,
  XSTATE_ACTIVE_STATES,
  XSTATE_TO_PHASE,
  mapStateToLegacy,
} from './task-state-utils';
;

export { terminalMachine } from './terminal-machine';
export type {  TerminalEvent } from './terminal-machine';
