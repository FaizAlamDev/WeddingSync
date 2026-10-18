import { create } from 'zustand';

import {
  syncNow,
  outboxStats,
  retryFailed,
  discardFailed,
  repairPendingChanges,
  type SyncResult,
} from '../db/sync';

type Phase = 'idle' | 'syncing' | 'error';

interface SyncState {
  phase: Phase;
  lastSyncedAt: string | null;
  pending: number;
  failed: number;
  lastOutboxError: string | null;
  lastCounts: { pushed: number; pulled: number } | null;
  epoch: number;
  error: string | null;

  run: () => Promise<void>;
  retry: () => Promise<void>;
  discard: () => Promise<void>;
  refreshPending: () => Promise<void>;
}

export const useSync = create<SyncState>((set, get) => ({
  phase: 'idle',
  lastSyncedAt: null,
  pending: 0,
  failed: 0,
  lastOutboxError: null,
  lastCounts: null,
  epoch: 0,
  error: null,

  async run() {
    if (get().phase === 'syncing') return;

    set({ phase: 'syncing', error: null });

    let repaired = 0;
    try {
      repaired = await repairPendingChanges();
    } catch (e) {
      set((s) => ({
        phase: 'error',
        error: e instanceof Error ? e.message : String(e),
        epoch: s.epoch + 1,
      }));
      await get().refreshPending();
      return;
    }

    const result: SyncResult = await syncNow();

    if (result.error) {
      set((s) => ({
        phase: 'error',
        error: result.error,
        epoch: s.epoch + 1,
      }));
      await get().refreshPending();
      return;
    }

    set((s) => ({
      phase: 'idle',
      lastSyncedAt: new Date().toISOString(),
      lastCounts: {
        pushed: result.pushed + repaired,
        pulled: result.pulled,
      },
      error: null,
      epoch: s.epoch + 1,
    }));
    await get().refreshPending();
  },

  async retry() {
    await retryFailed();
    await get().run();
  },

  async discard() {
    await discardFailed();
    await get().refreshPending();
  },

  async refreshPending() {
    const stats = await outboxStats();
    set({
      pending: stats.pending,
      failed: stats.failed,
      lastOutboxError: stats.lastError,
    });
  },
}));

export function describeSync(s: SyncState): {
  text: string;
  tone: 'ok' | 'busy' | 'warn' | 'error';
} {
  if (s.phase === 'syncing') return { text: 'Syncing…', tone: 'busy' };

  if (s.failed > 0) {
    return {
      text:
        s.failed === 1
          ? '1 change could not be uploaded'
          : `${s.failed} changes could not be uploaded`,
      tone: 'error',
    };
  }

  if (s.phase === 'error') {
    return { text: `Not syncing — ${s.error ?? 'connection problem'}`, tone: 'error' };
  }

  if (s.pending > 0) {
    return {
      text:
        s.pending === 1
          ? '1 change waiting to upload'
          : `${s.pending} changes waiting to upload`,
      tone: 'warn',
    };
  }

  if (!s.lastSyncedAt) return { text: 'Not synced yet', tone: 'warn' };

  return { text: `Synced ${relative(s.lastSyncedAt)}`, tone: 'ok' };
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return 'over a week ago';
}
