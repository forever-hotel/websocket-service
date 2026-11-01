import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { connect, type ChannelModel } from 'amqplib';
import { SharedGateway } from './shared.gateway';
import { eventChannels, REALTIME_EXCHANGE } from './contracts';

@Injectable()
export class SharedBroker implements OnModuleInit, OnModuleDestroy {
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
        this.ready = false;
      });
      connection.on('close', () => {
        this.ready = false;
        this.schedule();
      });
      const channel = await connection.createChannel();

      channel.on('error', () => {
        this.ready = false;
      });
      channel.on('close', () => {
        this.ready = false;
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
          };

          if (!eventChannels[event.name] || message.fields.routingKey !== event.subsystem + '.' + event.name)
            throw new Error();
          // Only safe invalidations/status are sent, never producer payloads or personal data.
          this.gateway.deliver(
            event.subsystem,
            event.name,
            event.name.endsWith('transport.status') ? { healthy: event.healthy === true } : { changed: true }
          );
          channel.ack(message);
        } catch {
          channel.nack(message, false, false);
        }
      });
      this.ready = true;
    } catch {
      this.ready = false;
      await this.connection?.close().catch(() => undefined);
      this.schedule();
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
