export function describeCounts(
  maleCount: number | null,
  femaleCount: number | null
): string {
  const parts: string[] = [];
  if (maleCount !== null) {
    parts.push(`${maleCount} ${maleCount === 1 ? 'man' : 'men'}`);
  }
  if (femaleCount !== null) {
    parts.push(`${femaleCount} ${femaleCount === 1 ? 'woman' : 'women'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Not counted';
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseDay(value: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) {
    return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  }
  return new Date(value);
}

export function formatDay(value: string): string {
  const d = parseDay(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function isOverdue(value: string, now: number = Date.now()): boolean {
  const d = parseDay(value);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() + DAY_MS <= now;
}
