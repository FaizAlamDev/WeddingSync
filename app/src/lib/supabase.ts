import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabaseUrl, supabaseAnonKey, isConfigured } from '../config';

export const supabase: SupabaseClient = createClient(
  isConfigured ? supabaseUrl : 'https://placeholder.invalid',
  isConfigured ? supabaseAnonKey : 'placeholder-key',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);

export async function ensureSession(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;

  if (data.session?.user) return data.session.user.id;

  const { data: signedIn, error: signInError } = await supabase.auth.signInAnonymously();
  if (signInError) throw signInError;
  if (!signedIn.user) throw new Error('Anonymous sign-in returned no user');

  return signedIn.user.id;
}

export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

export async function claimProfile(displayName: string): Promise<void> {
  const uid = await ensureSession();

  const { error } = await supabase
    .from('profiles')
    .upsert({ id: uid, display_name: displayName }, { onConflict: 'id' });

  if (error) throw error;
}
