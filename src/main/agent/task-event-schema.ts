import { z } from 'zod';

const TaskEventSchema = z.object({
  type: z.string(),
  taskId: z.string(),
  specId: z.string(),
  projectId: z.string(),
  timestamp: z.string(),
  eventId: z.string(),
  sequence: z.number().int().min(0)
}).passthrough();

export type TaskEventPayload = z.infer<typeof TaskEventSchema>;