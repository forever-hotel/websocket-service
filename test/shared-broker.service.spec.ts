import { connect, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { SharedBroker } from '../src/shared-broker.service';
import { SharedGateway } from '../src/shared.gateway';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

function fixture() {
  const connectionEvents: Record<string, () => void> = {};
  const channelEvents: Record<string, () => void> = {};
  let receive!: (message: ConsumeMessage | null) => void;
  const channel = {
    on: jest.fn((event: string, listener: () => void) => {
      channelEvents[event] = listener;
    }),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn((_queue: string, listener: typeof receive) => {
      receive = listener;
      return Promise.resolve();
    }),
    ack: jest.fn(),
    nack: jest.fn()
  };
  const connection = {
    on: jest.fn((event: string, listener: () => void) => {
      connectionEvents[event] = listener;
    }),
    createChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined)
  };
  jest.mocked(connect).mockResolvedValue(connection as unknown as ChannelModel);
  const deliver = jest.fn();
  const broker = new SharedBroker({ deliver, setBrokerReady: jest.fn() } as unknown as SharedGateway);
  const message = (name = 'room.status.changed', extra: object = {}) =>
    ({
      content: Buffer.from(JSON.stringify({ subsystem: 'mad', name, privateData: 'never forward', ...extra })),
      fields: { routingKey: 'mad.' + name }
    }) as ConsumeMessage;
  return {
    broker,
    channel,
    connection,
    connectionEvents,
    channelEvents,
    deliver,
    message,
    receive: (value: ConsumeMessage | null) => receive(value)
  };
}

describe('standalone broker subscription', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses durable bounded transport and sends only invalidations or boolean health', async () => {
    const f = fixture();
    try {
      await f.broker.attach();
      expect(f.broker.ready).toBe(true);
      expect(f.channel.assertExchange).toHaveBeenCalledWith('hotel.realtime', 'topic', { durable: true });
      expect(f.channel.assertQueue).toHaveBeenCalledWith(
        'shared.websocket',
        expect.objectContaining({ durable: true })
      );
      const event = f.message();
      f.receive(event);
      expect(f.deliver).toHaveBeenLastCalledWith('mad', 'room.status.changed', { changed: true });
      expect(f.channel.ack).toHaveBeenCalledWith(event);
      f.receive(f.message('rooms.transport.status', { healthy: true }));
      expect(f.deliver).toHaveBeenLastCalledWith('mad', 'rooms.transport.status', { healthy: true });
      f.receive(f.message('rooms.transport.status', { healthy: 'untrusted' }));
      expect(f.deliver).toHaveBeenLastCalledWith('mad', 'rooms.transport.status', { healthy: false });
    } finally {
      await f.broker.onModuleDestroy();
    }
  });

  it('maps FDS/WMS changes to authorized MAD and FDS refresh events', async () => {
    const f = fixture();
    try {
      await f.broker.attach();
      const room = f.message('room.status.updated', { subsystem: 'fds' });
      room.fields.routingKey = 'fds.room.status.updated';
      f.receive(room);
      expect(f.deliver).toHaveBeenCalledWith('mad', 'room.status.changed', { changed: true });
      expect(f.deliver).toHaveBeenCalledWith('mad', 'analytics.changed', { changed: true });
      const task = f.message('task.completed', { subsystem: 'wkms' });
      task.fields.routingKey = 'wkms.task.completed';
      f.receive(task);
      expect(f.deliver).toHaveBeenCalledWith('fds', 'task.changed', { changed: true });
      expect(f.deliver).toHaveBeenCalledWith('mad', 'task.changed', { changed: true });
      expect(JSON.stringify(f.deliver.mock.calls)).not.toContain('never forward');
    } finally {
      await f.broker.onModuleDestroy();
    }
  });

  it.each(['malformed', 'oversized', 'routing', 'event', 'permission'])(
    'rejects %s broker data without requeueing',
    async invalid => {
      const f = fixture();
      try {
        await f.broker.attach();
        const event = f.message(invalid === 'event' ? 'unknown' : undefined);
        if (invalid === 'malformed') event.content = Buffer.from('{');
        if (invalid === 'oversized') event.content = Buffer.alloc(8193);
        if (invalid === 'routing') event.fields.routingKey = 'other.room.status.changed';
        if (invalid === 'permission')
          f.deliver.mockImplementation(() => {
            throw new Error('denied');
          });
        f.receive(event);
        expect(f.channel.nack).toHaveBeenCalledWith(event, false, false);
        expect(f.channel.ack).not.toHaveBeenCalled();
      } finally {
        await f.broker.onModuleDestroy();
      }
    }
  );

  it('marks errors unhealthy and schedules a single reconnect after connection loss', async () => {
    const f = fixture();
    try {
      await f.broker.attach();
      f.channelEvents.error();
      expect(f.broker.ready).toBe(false);
      f.connectionEvents.error();
      f.channelEvents.close();
      expect(f.connection.close).toHaveBeenCalled();
      f.connectionEvents.close();
      f.connectionEvents.close();
      await jest.advanceTimersByTimeAsync(3000);
      expect(connect).toHaveBeenCalledTimes(2);
      f.receive(null);
      expect(f.connection.close).toHaveBeenCalled();
    } finally {
      await f.broker.onModuleDestroy();
    }
  });

  it('retries unavailable brokers and stops retrying on shutdown', async () => {
    const f = fixture();
    jest.mocked(connect).mockRejectedValue(new Error('offline'));
    await f.broker.attach();
    expect(f.broker.ready).toBe(false);
    await f.broker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(3000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('closes a connection that arrives after shutdown', async () => {
    const f = fixture();
    await f.broker.onModuleDestroy();
    await f.broker.attach();
    expect(f.connection.close).toHaveBeenCalled();
    expect(f.connection.createChannel).not.toHaveBeenCalled();
  });

  it('starts the broker subscription from Nest lifecycle', () => {
    const f = fixture();
    const attach = jest.spyOn(f.broker, 'attach').mockResolvedValue();
    f.broker.onModuleInit();
    expect(attach).toHaveBeenCalledTimes(1);
  });
});
