import type { Server, Socket } from 'socket.io';
import { SharedGateway } from '../src/shared.gateway';
import { SharedAuthService } from '../src/shared-auth.service';

describe('FOSS guest stay isolation', () => {
  it('delivers private events only to the authenticated booking and room', async () => {
    const key = 'test-foss-relay-key-at-least-32-characters';
    const auth = {
      systems: { foss: { relayKey: key, origins: ['http://localhost:3004'] } },
      session: jest.fn(async (token: string) => ({
        sub: token,
        role: 'GUEST',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        channels: ['guest'],
        bookingId: token,
        roomNumber: token === 'stay-a' ? '101' : '102'
      }))
    };
    const gateway = new SharedGateway(auth as unknown as SharedAuthService);
    let middleware!: (socket: Socket, next: (error?: Error) => void) => void;
    let connection!: (socket: Socket) => void;
    gateway.afterInit({
      use: (fn: typeof middleware) => {
        middleware = fn;
      },
      on: (_: string, fn: typeof connection) => {
        connection = fn;
      },
      close: jest.fn()
    } as unknown as Server);
    const clients: { socket: Socket; emit: jest.Mock }[] = [];
    try {
      for (const token of ['stay-a', 'stay-b']) {
        const ticket = await gateway.ticket('foss', token, key);
        const emit = jest.fn();
        const socket = {
          handshake: { auth: { ticket: ticket.ticket }, headers: { origin: 'http://localhost:3004' } },
          emit,
          disconnect: jest.fn(),
          on: jest.fn()
        } as unknown as Socket;
        expect(await new Promise(resolve => middleware(socket, resolve))).toBeUndefined();
        connection(socket);
        emit.mockClear();
        clients.push({ socket, emit });
      }
      const event = { bookingId: 'stay-a', roomNumber: '101', eventId: 'event-a' };
      gateway.deliver('foss', 'guest.event', event);
      expect(clients[0].emit).toHaveBeenCalledWith('guest.event', event);
      expect(clients[1].emit).not.toHaveBeenCalled();
      clients[0].emit.mockClear();
      gateway.deliver('foss', 'guest.event', { ...event, roomNumber: '102' });
      expect(clients[0].emit).not.toHaveBeenCalled();
      expect(clients[1].emit).not.toHaveBeenCalled();
      expect(() => gateway.deliver('foss', 'guest.event', { changed: true })).toThrow();
      gateway.deliver('foss', 'guest.refresh', { secret: 'must never reach browsers' });
      expect(clients[1].emit).toHaveBeenCalledWith('guest.refresh', { changed: true });
      auth.session.mockRejectedValueOnce(new Error('checked out') as never);
      await gateway.revalidate();
      expect(clients[0].socket.disconnect).toHaveBeenCalledWith(true);
    } finally {
      gateway.onModuleDestroy();
    }
  });
});
