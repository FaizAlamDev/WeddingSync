import { listEventLinks, listEvents, listGuests, type EventLinkRow } from '../db/queries';
import { NO_EVENT_GROUP, type ExportFamily, type ExportGroup, type ExportModel } from './model';

export async function loadExportModel(): Promise<ExportModel> {
  const [guests, events, links] = await Promise.all([
    listGuests(),
    listEvents(),
    listEventLinks(),
  ]);

  const liveEvents = new Set(events.map((event) => event.id));
  const linksByGuest = new Map<string, EventLinkRow[]>();
  for (const link of links) {
    if (!liveEvents.has(link.event_id)) continue;
    const attending = linksByGuest.get(link.guest_id);
    if (attending) attending.push(link);
    else linksByGuest.set(link.guest_id, [link]);
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
    const attending = linksByGuest.get(guest.id) ?? [];
    if (attending.length === 0) {
      unclaimed.push({
        id: guest.id,
        name: guest.name,
        men: guest.male_count,
        women: guest.female_count,
      });
      continue;
    }

    for (const link of attending) {
      byEvent.get(link.event_id)?.families.push({
        id: guest.id,
        name: guest.name,
        men: link.male_count ?? guest.male_count,
        women: link.female_count ?? guest.female_count,
      });
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
