import { SharedController } from '../src/shared.controller';
import { SharedGateway } from '../src/shared.gateway';
import { SharedBroker } from '../src/shared-broker.service';

describe('shared service HTTP contract', () => {
  const ticket = jest.fn().mockResolvedValue({ ticket: 'opaque', expiresIn: 30 });
  const broker = { ready: false };
  const controller = new SharedController({ ticket } as unknown as SharedGateway, broker as SharedBroker);

  it('fails readiness until the broker subscription is ready', () => {
    expect(() => controller.ready()).toThrow();
    broker.ready = true;
    expect(controller.ready()).toEqual({ status: 'ok', service: 'shared-websocket' });
  });

  it('passes the owner JWT and private relay credential to ticket validation', async () => {
    await controller.ticket('mad', 'Bearer private-token', 'relay-key');
    expect(ticket).toHaveBeenLastCalledWith('mad', 'private-token', 'relay-key');
    await controller.ticket('mad');
    expect(ticket).toHaveBeenLastCalledWith('mad', '', '');
  });
});
