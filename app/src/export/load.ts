import { listEventLinks, listEvents, listGuests } from '../db/queries';
import { NO_EVENT_GROUP, type ExportFamily, type ExportGroup, type ExportModel } from './model';

export async function loadExportModel(): Promise<ExportModel> {
  const [guests, events, links] = await Promise.all([
    listGuests(),
    listEvents(),
    listEventLinks(),
  ]);

  const liveEvents = new Set(events.map((event) => event.id));
  const eventsByGuest = new Map<string, string[]>();
  for (const link of links) {
    if (!liveEvents.has(link.event_id)) continue;
    const attending = eventsByGuest.get(link.guest_id);
    if (attending) attending.push(link.event_id);
    else eventsByGuest.set(link.guest_id, [link.event_id]);
  }

  const groups: ExportGroup[] = events.map((event) => ({
    eventId: event.id,
    name: event.name,
    date: event.event_date,
    families: [],
  }));
  const byEvent = new Map(groups.map((group) => [group.eventId, group]));
  const unclaimed: ExportFamily[] = [];

  for (const guest of guests) {
    const family: ExportFamily = {
      id: guest.id,
      name: guest.name,
      men: guest.male_count,
      women: guest.female_count,
    };

    const attending = eventsByGuest.get(guest.id) ?? [];
    if (attending.length === 0) {
      unclaimed.push(family);
      continue;
    }
    for (const eventId of attending) {
      byEvent.get(eventId)?.families.push(family);
    }
  }

  if (unclaimed.length > 0) {
    groups.push({ eventId: null, name: NO_EVENT_GROUP, date: null, families: unclaimed });
  }

  return {
    generatedAt: new Date().toISOString(),
    groups,
    familyCount: guests.length,
  };
}
