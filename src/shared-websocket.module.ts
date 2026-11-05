import { Module } from '@nestjs/common';
import { SharedController } from './shared.controller';
import { SharedAuthService } from './shared-auth.service';
import { SharedGateway } from './shared.gateway';
import { SharedBroker } from './shared-broker.service';

@Module({ controllers: [SharedController], providers: [SharedAuthService, SharedGateway, SharedBroker] })
export class SharedWebsocketModule {}
