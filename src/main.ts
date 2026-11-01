import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SharedWebsocketModule } from './shared-websocket.module';

async function bootstrap() {
  const app = await NestFactory.create(SharedWebsocketModule);

  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4700), '0.0.0.0');
}
void bootstrap();
