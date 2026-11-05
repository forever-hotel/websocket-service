import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { SharedGateway } from '../src/shared.gateway';
import { SharedController } from '../src/shared.controller';
import { SharedBroker } from '../src/shared-broker.service';
import { SharedAuthService } from '../src/shared-auth.service';

// Real HTTP ticket issuance and Socket.IO handshakes; database/broker are isolated fakes.
describe('shared socket service integration', () => {
  let app: INestApplication;
  let gateway: SharedGateway;
  let base: string;
  const clients: Socket[] = [];
  const key = 'integration-private-relay-key-at-least-32';
  const origin = 'http://localhost:3001';
  const revoked = new Set<string>();
  const auth = {
    systems: {
      fds: { relayKey: key, origins: [origin] },
      wkms: { relayKey: key, origins: [origin] }
    },
    session: jest.fn(async (token: string, subsystem: string) => {
      if (token !== subsystem + '-token' || revoked.has(token)) throw new Error('Unauthorized');
      return {
        sub: token,
        role: subsystem === 'fds' ? 'RECEPTIONIST' : 'WORKER',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        channels: subsystem === 'fds' ? ['rooms'] : ['tasks']
      };
    })
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SharedController],
      providers: [
        SharedGateway,
        { provide: SharedAuthService, useValue: auth },
        { provide: SharedBroker, useValue: { ready: true } }
      ]
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    gateway = app.get(SharedGateway);
    gateway.setBrokerReady(true);
  });
  afterAll(async () => {
    for (const socket of clients) socket.disconnect();
    await app.close();
  });
  async function ticket(subsystem: string) {
    const response = await fetch(base + '/internal/tickets/' + subsystem, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + subsystem + '-token', 'x-relay-key': key }
    });
    expect(response.status).toBe(201);
    return (await response.json()).ticket as string;
  }
  function socket(ticket: string) {
    const client = io(base, {
      auth: { ticket },
      extraHeaders: { origin },
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false
    });
    clients.push(client);
    return client;
  }
  function connect(client: Socket) {
    return new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
      client.connect();
    });
  }
  it('delivers only permitted invalidations, rejects replay and disconnects revoked sessions', async () => {
    const oneUse = await ticket('fds');
    const receptionist = socket(oneUse);
    await connect(receptionist);
    const worker = socket(await ticket('wkms'));
    await connect(worker);
    await expect(connect(socket(oneUse))).rejects.toThrow('UNAUTHENTICATED');
    const received = new Promise<unknown>(resolve => receptionist.once('room.status.updated', resolve));
    const workerRoomEvent = jest.fn();
    worker.on('room.status.updated', workerRoomEvent);
    gateway.deliver('fds', 'room.status.updated', { changed: true });
    expect(await received).toEqual({ changed: true });
    expect(workerRoomEvent).not.toHaveBeenCalled();
    const denied = await new Promise<{ ok: boolean }>(resolve => worker.emit('subscribe', ['rooms'], resolve));
    expect(denied).toEqual({ ok: false });
    const disconnected = new Promise<void>(resolve => worker.once('disconnect', () => resolve()));
    revoked.add('wkms-token');
    await gateway.revalidate();
    await disconnected;
    expect(worker.connected).toBe(false);
  });
});
