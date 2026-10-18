/**
 * Shape of a `task-event` payload: the fields every event carries, plus whatever
 * the emitting phase adds on top.
 */
export interface TaskEventPayload {
  type: string;
  taskId: string;
  specId: string;
  projectId: string;
  timestamp: string;
  eventId: string;
  sequence: number;
  [key: string]: unknown;
}
