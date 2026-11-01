export const REALTIME_EXCHANGE = 'hotel.realtime';
export const channels = ['analytics', 'kitchen', 'rooms', 'tasks', 'stock', 'notifications'] as const;
export type LiveChannel = (typeof channels)[number];
export const eventChannels: Record<string, LiveChannel> = {
  'analytics.changed': 'analytics',
  'analytics.transport.status': 'analytics',
  'food.analytics.changed': 'kitchen',
  'kitchen.order.changed': 'kitchen',
  'transport.status': 'kitchen',
  'room.status.changed': 'rooms',
  'rooms.transport.status': 'rooms',
  'task.changed': 'tasks',
  'tasks.transport.status': 'tasks',
  'stock.alert.changed': 'stock',
  'stock.transport.status': 'stock',
  'notifications.changed': 'notifications',
  'notifications.transport.status': 'notifications'
};
export interface Subsystem {
  authUrl: string;
  relayKey: string;
  origins: string[];
  roles: Record<string, LiveChannel[]>;
}
export type Subsystems = Record<string, Subsystem>;

export function loadSubsystems(raw = process.env.WEBSOCKET_SUBSYSTEMS_JSON): Subsystems {
  const parsed: unknown = JSON.parse(raw ?? '{}');

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid subsystem registry');
  const result: Subsystems = {};

  for (const [id, entry] of Object.entries(parsed)) {
    if (!['mad', 'hw', 'fds', 'foss', 'kms', 'wkms'].includes(id) || !entry || typeof entry !== 'object')
      throw new Error('Invalid subsystem');
    const value = entry as Subsystem;
    const url = new URL(value.authUrl);

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      typeof value.relayKey !== 'string' ||
      value.relayKey.length < 32 ||
      !Array.isArray(value.origins) ||
      !value.origins.length ||
      value.origins.some(origin => new URL(origin).origin !== origin) ||
      !value.roles ||
      typeof value.roles !== 'object' ||
      !Object.values(value.roles).length ||
      Object.values(value.roles).some(
        list => !Array.isArray(list) || !list.length || list.some(channel => !channels.includes(channel))
      )
    )
      throw new Error('Invalid subsystem permissions');
    result[id] = value;
  }
  if (!Object.keys(result).length) throw new Error('Configure at least one subsystem');
  return result;
}
