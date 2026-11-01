import { Injectable, OnModuleDestroy, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayInit } from '@nestjs/websockets';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { SharedAuthService, type LiveSession } from './shared-auth.service';
import { eventChannels, type LiveChannel } from './contracts';

interface Client {
  token: string;
  subsystem: string;
  session: LiveSession;
  channels: LiveChannel[];
}

@Injectable()
@WebSocketGateway({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  serveClient: false,
  maxHttpBufferSize: 8192,
  cors: { origin: false }
})
export class SharedGateway implements OnGatewayInit, OnModuleDestroy {
  private server?: Server;
  private tickets = new Map<string, { token: string; subsystem: string; session: LiveSession; expires: number }>();
  private clients = new Map<Socket, Client>();
  private status = new Map<string, { data: unknown; at: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;

  constructor(private readonly auth: SharedAuthService) {}

  async ticket(subsystem: string, token: string, key: string) {
    const expected = this.auth.systems[subsystem]?.relayKey;

    if (
      !expected ||
      typeof key !== 'string' ||
      Buffer.byteLength(key) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
    )
      throw new UnauthorizedException();
    const now = Date.now();

    for (const [id, item] of this.tickets) if (item.expires <= now) this.tickets.delete(id);
    if (this.tickets.size >= 2000) throw new ServiceUnavailableException();
    const session = await this.auth.session(token, subsystem);
    const ticket = randomBytes(32).toString('base64url');

    this.tickets.set(ticket, { token, subsystem, session, expires: now + 30000 });
    return { ticket, expiresIn: 30 };
  }

  afterInit(server: Server) {
    this.server = server;
    server.use((socket, next) => {
      const input: unknown = socket.handshake.auth;
      const ticket = input && typeof input === 'object' ? (input as { ticket?: unknown }).ticket : undefined;
      const entry = typeof ticket === 'string' && /^[\w-]{43}$/.test(ticket) ? this.tickets.get(ticket) : undefined;

      if (typeof ticket === 'string') this.tickets.delete(ticket);
      if (
        !entry ||
        entry.expires <= Date.now() ||
        !this.auth.systems[entry.subsystem].origins.includes(socket.handshake.headers.origin ?? '')
      )
        return next(new Error('UNAUTHENTICATED'));
      void this.auth.session(entry.token, entry.subsystem).then(
        session => {
          this.clients.set(socket, {
            token: entry.token,
            subsystem: entry.subsystem,
            session,
            channels: [...session.channels]
          });
          next();
        },
        () => next(new Error('UNAUTHENTICATED'))
      );
    });
    server.on('connection', socket => {
      const client = this.clients.get(socket);

      if (!client) return socket.disconnect(true);
      for (const [name, channel] of Object.entries(eventChannels)) {
        if (!name.endsWith('transport.status') || !client.channels.includes(channel)) continue;
        const saved = this.status.get(client.subsystem + ':' + name);

        socket.emit(name, saved && Date.now() - saved.at < 15000 ? saved.data : { healthy: false });
      }
      socket.on('subscribe', (requested: unknown, acknowledge?: (result: { ok: boolean }) => void) => {
        const current = this.clients.get(socket);

        if (
          !current ||
          !Array.isArray(requested) ||
          requested.length > 6 ||
          requested.some(channel => !current.session.channels.includes(channel as LiveChannel))
        ) {
          if (typeof acknowledge === 'function') acknowledge({ ok: false });
          return;
        }
        current.channels = [...new Set(requested)] as LiveChannel[];
        if (typeof acknowledge === 'function') acknowledge({ ok: true });
      });
      socket.on('disconnect', () => this.clients.delete(socket));
    });
    this.timer = setInterval(() => {
      void this.revalidate();
    }, 5000);
    this.timer.unref();
  }

  async revalidate() {
    if (this.checking) return;
    this.checking = true;
    try {
      const sessions = new Map<string, Promise<LiveSession>>();

      await Promise.all(
        [...this.clients].map(async ([socket, client]) => {
          const id = client.subsystem + ':' + client.token;

          try {
            if (!sessions.has(id)) sessions.set(id, this.auth.session(client.token, client.subsystem));
            const session = await sessions.get(id)!;

            client.session = session;
            client.channels = client.channels.filter(channel => session.channels.includes(channel));
          } catch {
            this.clients.delete(socket);
            socket.disconnect(true);
          }
        })
      );
      for (const [key, status] of this.status)
        if (Date.now() - status.at >= 15000) {
          const separator = key.indexOf(':');

          this.deliver(key.slice(0, separator), key.slice(separator + 1), { healthy: false });
        }
    } finally {
      this.checking = false;
    }
  }

  deliver(subsystem: string, name: string, data: unknown) {
    const channel = eventChannels[name];

    if (!channel || !this.auth.systems[subsystem]) throw new Error('Unknown realtime channel');
    if (name.endsWith('transport.status')) this.status.set(subsystem + ':' + name, { data, at: Date.now() });
    for (const [socket, client] of this.clients) {
      if (
        client.subsystem === subsystem &&
        client.channels.includes(channel) &&
        client.session.expiresAt * 1000 > Date.now()
      )
        socket.emit(name, data);
    }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    this.tickets.clear();
    for (const socket of this.clients.keys()) socket.disconnect(true);
    this.clients.clear();
    void this.server?.close();
  }
}
