/**
 * Queue column order
 *
 * The board keeps each column's order in the renderer; it sends the Queue column's saved order
 * here so the main-process queue starts the task at the top of the column first. Kept on disk
 * (`<userData>/config/queue-order.json`, keyed by project id) so it applies right after startup.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

class TaskQueueOrderStore {
  private orders: Record<string, string[]> | null = null;

  private get file(): string {
    return path.join(app.getPath('userData'), 'config', 'queue-order.json');
  }

  private load(): Record<string, string[]> {
    if (this.orders) return this.orders;
    try {
      const parsed = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf-8')) : {};
      this.orders = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      this.orders = {};
    }
    return this.orders!;
  }

  /** Saved order (task ids) of a project's Queue column */
  get(projectId: string): string[] {
    const order = this.load()[projectId];
    return Array.isArray(order) ? order : [];
  }

  set(projectId: string, order: string[]): void {
    const orders = this.load();
    const clean = order.filter((id) => typeof id === 'string');
    if (JSON.stringify(orders[projectId] ?? []) === JSON.stringify(clean)) return;
    orders[projectId] = clean;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(orders), 'utf-8');
    } catch (error) {
      console.warn('[TaskQueueOrder] Failed to save the queue order:', error);
    }
  }
}

export const taskQueueOrder = new TaskQueueOrderStore();
