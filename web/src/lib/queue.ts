/**
 * localStorage-backed scenario queue. Multiple tabs read/write the same key
 * and listen for `storage` events to stay in sync.
 *
 * Auto-runner contract: a host page (e.g. /) polls the head item; whenever it
 * has no `runId` yet, it calls api.startRun() and stamps the runId. Whenever
 * the head item's runId reaches COMPLETED / FAILED / ABORTED, it pops the head
 * and the next iteration picks up the next pending item.
 */

import type { MatrixSubset } from './matrix';

export interface QueueItem {
  id: string;              // local uuid, stable across page loads
  scenarioId: string;
  scenarioName: string;
  matrix: MatrixSubset;
  expectedLoaderVersionId: string;
  expectedLoaderSha256: string;
  enqueuedAt: string;
  runId?: string;
  status?: 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'aborted';
}

const KEY = 'hsm-bmt-queue';

export function loadQueue(): QueueItem[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as QueueItem[];
  } catch {
    return [];
  }
}

export function saveQueue(items: QueueItem[]): void {
  window.localStorage.setItem(KEY, JSON.stringify(items));
  // Notify listeners in the same tab (storage event only fires across tabs)
  window.dispatchEvent(new CustomEvent('hsm-bmt-queue-changed'));
}

export function enqueue(item: Omit<QueueItem, 'id' | 'enqueuedAt' | 'status'>): QueueItem {
  const next: QueueItem = {
    ...item,
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    enqueuedAt: new Date().toISOString(),
    status: 'queued',
  };
  const items = loadQueue();
  items.push(next);
  saveQueue(items);
  return next;
}

export function enqueueMany(items: Array<Omit<QueueItem, 'id' | 'enqueuedAt' | 'status'>>): void {
  const all = loadQueue();
  for (const x of items) {
    all.push({
      ...x,
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${all.length}`,
      enqueuedAt: new Date().toISOString(),
      status: 'queued',
    });
  }
  saveQueue(all);
}

export function updateItem(id: string, patch: Partial<QueueItem>): void {
  const items = loadQueue().map((it) => (it.id === id ? { ...it, ...patch } : it));
  saveQueue(items);
}

export function removeItem(id: string): void {
  saveQueue(loadQueue().filter((it) => it.id !== id));
}

export function clearAll(): void {
  saveQueue([]);
}

export function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = () => cb();
  window.addEventListener('storage', handler);
  window.addEventListener('hsm-bmt-queue-changed', handler);
  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener('hsm-bmt-queue-changed', handler);
  };
}

const TERMINAL = new Set(['completed', 'failed', 'aborted']);
export const isTerminal = (status?: string): boolean =>
  !!status && TERMINAL.has(status.toLowerCase());
