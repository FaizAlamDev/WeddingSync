import { parseDay } from '../format';

export interface ExportFamily {
  id: string;
  name: string;
  men: number | null;
  women: number | null;
}

export interface ExportGroup {
  eventId: string | null;
  name: string;
  date: string | null;
  families: ExportFamily[];
}

export interface ExportCounts {
  men: number | null;
  women: number | null;
  total: number | null;
}

export interface ExportModel {
  generatedAt: string;
  groups: ExportGroup[];
  familyCount: number;
}

export const NO_EVENT_GROUP = 'No event yet';

export const NOT_RECORDED = '—';

export function familyTotal(family: ExportFamily): number | null {
  if (family.men === null && family.women === null) return null;
  return (family.men ?? 0) + (family.women ?? 0);
}

export function groupCounts(group: ExportGroup): ExportCounts {
  let men: number | null = null;
  let women: number | null = null;
  for (const family of group.families) {
    if (family.men !== null) men = (men ?? 0) + family.men;
    if (family.women !== null) women = (women ?? 0) + family.women;
  }
  return {
    men,
    women,
    total: men === null && women === null ? null : (men ?? 0) + (women ?? 0),
  };
}

export function countCell(value: number | null): string | number {
  return value === null ? NOT_RECORDED : value;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatExportDay(value: string): string {
  const day = parseDay(value);
  if (Number.isNaN(day.getTime())) return value;
  return day.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
