import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { connect, type ChannelModel } from 'amqplib';
import { SharedGateway } from './shared.gateway';
import { eventChannels, REALTIME_EXCHANGE } from './contracts';

@Injectable()
export class SharedBroker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SharedBroker.name);
  private connection?: ChannelModel;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  ready = false;

  constructor(private readonly gateway: SharedGateway) {}

  onModuleInit() {
    void this.attach();
  }

  async attach() {
    try {
      const connection = await connect(process.env.RABBITMQ_URL ?? '', { timeout: 5000 });

      if (this.stopped) {
        await connection.close();
        return;
      }
      this.connection = connection;
      connection.on('error', () => {
        this.logger.warn({ event: 'broker_connection_error' });
        this.ready = false;
        this.gateway.setBrokerReady(false);
      });
      connection.on('close', () => {
        this.ready = false;
        this.gateway.setBrokerReady(false);
        this.schedule();
      });
      const channel = await connection.createChannel();

      channel.on('error', () => {
        this.logger.warn({ event: 'broker_channel_error' });
        this.ready = false;
        this.gateway.setBrokerReady(false);
      });
      channel.on('close', () => {
        this.ready = false;
        this.gateway.setBrokerReady(false);
        void connection.close().catch(() => undefined);
      });
      await channel.assertExchange(REALTIME_EXCHANGE, 'topic', { durable: true });
      await channel.assertQueue('shared.websocket', {
        durable: true,
        arguments: { 'x-message-ttl': 60000, 'x-max-length': 10000 }
      });
      await channel.bindQueue('shared.websocket', REALTIME_EXCHANGE, '#');
      await channel.prefetch(50);
      await channel.consume('shared.websocket', message => {
        if (!message) {
          void connection.close().catch(() => undefined);
          return;
        }
        try {
          if (message.content.length > 8192) throw new Error();
          const event = JSON.parse(message.content.toString()) as {
            subsystem: string;
            name: string;
            healthy?: boolean;
            data?: unknown;
          };

          if (!eventChannels[event.name] || message.fields.routingKey !== event.subsystem + '.' + event.name)
            throw new Error();
          // Only safe invalidations/status are sent, never producer payloads or personal data.
          this.gateway.deliver(
            event.subsystem,
            event.name,
            event.subsystem === 'foss' && event.name === 'guest.event'
              ? event.data
              : event.name.endsWith('transport.status')
                ? { healthy: event.healthy === true }
                : { changed: true }
          );
          // Cross-system invalidations still re-fetch through each owner's authorized REST API.
          if (event.subsystem === 'fds' && event.name === 'room.status.updated') {
            this.deliverIfConfigured('mad', 'room.status.changed', { changed: true });
            this.deliverIfConfigured('mad', 'analytics.changed', { changed: true });
          }
          if (event.subsystem === 'wkms' && event.name.startsWith('task.')) {
            this.deliverIfConfigured('foss', 'guest.refresh', { changed: true });
            this.deliverIfConfigured('mad', 'task.changed', { changed: true });
            this.deliverIfConfigured('fds', 'task.changed', { changed: true });
          }
          if (event.subsystem === 'mad' && event.name === 'notifications.changed')
            this.deliverIfConfigured('foss', 'guest.refresh', { changed: true });
          channel.ack(message);
        } catch {
          channel.nack(message, false, false);
        }
      });
      this.logger.log({ event: 'broker_connected' });
      this.ready = true;
      this.gateway.setBrokerReady(true);
    } catch {
      this.logger.warn({ event: 'broker_connection_unavailable', retryMs: 3000 });
      this.ready = false;
      this.gateway.setBrokerReady(false);
      await this.connection?.close().catch(() => undefined);
      this.schedule();
    }
  }

  private deliverIfConfigured(subsystem: string, name: string, data: unknown) {
    try {
      this.gateway.deliver(subsystem, name, data);
    } catch {
      /* Optional subsystem is not configured. */
    }
  }

  private schedule() {
    if (!this.stopped && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.attach();
      }, 3000);
      this.timer.unref();
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.connection?.close().catch(() => undefined);
  }
}
