import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { claimProfile, ensureSession, currentUserId } from '../lib/supabase';
import { familyMembers } from '../config';

const STORAGE_KEY = 'weddingsync.currentUser';

interface SessionState {
  userId: string | null;
  displayName: string | null;
  ready: boolean;
  error: string | null;
  bootstrap: () => Promise<void>;
  pickName: (name: string) => Promise<boolean>;
  switchPerson: () => void;
  clearError: () => void;
}

export const useSession = create<SessionState>((set, get) => ({
  userId: null,
  displayName: null,
  ready: false,
  error: null,

  async bootstrap() {
    try {
      const [stored, uid] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY),
        currentUserId(),
      ]);
      set({
        displayName: stored,
        userId: uid,
        ready: true,
      });
    } catch (e) {
      set({
        ready: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  async pickName(name) {
    set({ error: null });
    try {
      const uid = await ensureSession();
      await claimProfile(name);
      await AsyncStorage.setItem(STORAGE_KEY, name);
      set({ userId: uid, displayName: name });
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  switchPerson() {
    void AsyncStorage.removeItem(STORAGE_KEY);
    set({ displayName: null, error: null });
  },

  clearError() {
    set({ error: null });
  },
}));

export const availableNames = familyMembers;
