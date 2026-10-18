/**
 * App configuration, read once at startup.
 *
 * EXPO_PUBLIC_* variables are inlined into the JS bundle by Metro at
 * build time. That is expected and correct for the Supabase anon key --
 * it is public by design and RLS is what protects the data. Never add a
 * secret key here.
 */

const rawUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const rawKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** Values that are still the placeholder text from .env.example. */
function isPlaceholder(value: string): boolean {
  const v = value.trim().toUpperCase();
  return (
    v === '' ||
    v.startsWith('YOUR-') ||
    v.includes('YOUR-PROJECT-REF') ||
    v.includes('PLACEHOLDER')
  );
}

export const supabaseUrl = rawUrl.trim().replace(/\/+$/, '');
export const supabaseAnonKey = rawKey.trim();

export const isConfigured = !isPlaceholder(supabaseUrl) && !isPlaceholder(supabaseAnonKey);

/**
 * Family members who may pick a name. Kept in sync with the
 * `family_members` table; this list is the offline fallback so the picker
 * renders with no connectivity. See 007_family_members.sql.
 */
export const familyMembers: string[] = String(process.env.EXPO_PUBLIC_FAMILY_MEMBERS ?? '')
  .split(',')
  .map((n: string) => n.trim())
  .filter(Boolean);

/** Present when the user needs to see setup instructions instead of the app. */
export const configError: string | null = !isConfigured
  ? 'Supabase is not configured. Copy app/.env.example to app/.env and fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.'
  : familyMembers.length === 0
    ? 'No family members configured. Set EXPO_PUBLIC_FAMILY_MEMBERS in app/.env as a comma-separated list.'
    : null;