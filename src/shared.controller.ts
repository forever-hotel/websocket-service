import { Controller, Get, Headers, Param, Post, ServiceUnavailableException } from '@nestjs/common';
import { SharedGateway } from './shared.gateway';
import { SharedBroker } from './shared-broker.service';

@Controller()
export class SharedController {
  constructor(
    private readonly gateway: SharedGateway,
    private readonly broker: SharedBroker
  ) {}

  @Get('health/ready') ready() {
    if (!this.broker.ready) throw new ServiceUnavailableException();
    return { status: 'ok', service: 'shared-websocket' };
  }

  @Post('internal/tickets/:subsystem') ticket(
    @Param('subsystem') subsystem: string,
    @Headers('authorization') authorization = '',
    @Headers('x-relay-key') key = ''
  ) {
    return this.gateway.ticket(subsystem, authorization.startsWith('Bearer ') ? authorization.slice(7) : '', key);
  }
}
