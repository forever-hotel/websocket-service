import type { Server, Socket } from 'socket.io';
import { SharedGateway } from '../src/shared.gateway';
import { SharedAuthService } from '../src/shared-auth.service';

const key = 'shared-gateway-test-key-at-least-32';

function setup() {
  const session = jest.fn().mockResolvedValue({
    sub: 'manager',
    role: 'MANAGER',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    channels: ['rooms', 'analytics']
  });
  const auth = {
    systems: {
      mad: { relayKey: key, origins: ['http://localhost:3000'] },
      fds: { relayKey: key, origins: ['http://localhost:3000'] }
    },
    session
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
  const emit = jest.fn(),
    disconnect = jest.fn();
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const socket = {
    handshake: { auth: { ticket: '' }, headers: { origin: 'http://localhost:3000' } },
    emit,
    disconnect,
    on: (name: string, handler: (...args: unknown[]) => void) => {
      handlers[name] = handler;
    }
  } as unknown as Socket;
  const authorize = () => new Promise<Error | undefined>(resolve => middleware(socket, resolve));

  return { gateway, socket, emit, disconnect, session, handlers, authorize, connection };
}
describe('shared socket authentication and subscription isolation', () => {
  it('uses owner authentication, one-use tickets and permitted subsystem channels', async () => {
    const t = setup();

    try {
      await expect(t.gateway.ticket('mad', 'private', 'incorrect')).rejects.toMatchObject({ status: 401 });
      t.socket.handshake.auth.ticket = (await t.gateway.ticket('mad', 'private', key)).ticket;
      expect(await t.authorize()).toBeUndefined();
      t.connection(t.socket);
      expect(await t.authorize()).toBeInstanceOf(Error);
      t.emit.mockClear();
      t.gateway.deliver('fds', 'room.status.changed', { changed: true });
      t.gateway.deliver('mad', 'kitchen.order.changed', { changed: true });
      expect(t.emit).not.toHaveBeenCalled();
      t.gateway.deliver('mad', 'room.status.changed', { changed: true });
      expect(t.emit).toHaveBeenCalledWith('room.status.changed', { changed: true });
      const ack = jest.fn();

      t.handlers.subscribe(['stock'], ack);
      expect(ack).toHaveBeenCalledWith({ ok: false });
      t.session.mockRejectedValue(new Error('revoked'));
      await t.gateway.revalidate();
      expect(t.disconnect).toHaveBeenCalledWith(true);
    } finally {
      t.gateway.onModuleDestroy();
    }
  });
  it('rejects expired tickets and wrong origins', async () => {
    const t = setup();
    const clock = jest.spyOn(Date, 'now');

    try {
      const now = Date.now();

      t.socket.handshake.auth.ticket = (await t.gateway.ticket('mad', 'private', key)).ticket;
      clock.mockReturnValue(now + 31000);
      expect(await t.authorize()).toBeInstanceOf(Error);
      clock.mockRestore();
      t.socket.handshake.auth.ticket = (await t.gateway.ticket('mad', 'private', key)).ticket;
      t.socket.handshake.headers.origin = 'http://attacker.invalid';
      expect(await t.authorize()).toBeInstanceOf(Error);
    } finally {
      clock.mockRestore();
      t.gateway.onModuleDestroy();
    }
  });
});
