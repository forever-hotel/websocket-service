import { SharedAuthService } from '../src/shared-auth.service';
import { loadSubsystems } from '../src/contracts';

const key = 'test-relay-key-with-at-least-32-characters';
const system = {
  authUrl: 'http://gateway.test/auth/session',
  relayKey: key,
  origins: ['http://localhost:3000'],
  roles: { MANAGER: ['rooms'] }
};
describe('Shared subsystem registry and authentication', () => {
  const original = process.env.WEBSOCKET_SUBSYSTEMS_JSON,
    originalFetch = global.fetch;

  beforeEach(() => {
    process.env.WEBSOCKET_SUBSYSTEMS_JSON = JSON.stringify({ mad: system });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (original === undefined) delete process.env.WEBSOCKET_SUBSYSTEMS_JSON;
    else process.env.WEBSOCKET_SUBSYSTEMS_JSON = original;
  });
  it('accepts explicit valid subsystem permissions', () => {
    expect(loadSubsystems(JSON.stringify({ mad: system })).mad.relayKey).toBe(key);
  });
  it('requires a booking and room from the authenticated FOSS guest session', async () => {
    process.env.WEBSOCKET_SUBSYSTEMS_JSON = JSON.stringify({ foss: { ...system, roles: { GUEST: ['guest'] } } });
    const body = {
      sub: 'session',
      role: 'GUEST',
      bookingId: 'booking',
      roomNumber: '101',
      expiresAt: 4102444800,
      passwordChangeRequired: false
    };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await new SharedAuthService().session('private', 'foss')).toMatchObject({
      bookingId: 'booking',
      roomNumber: '101',
      channels: ['guest']
    });
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ ...body, bookingId: undefined })));
    await expect(new SharedAuthService().session('private', 'foss')).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    'null',
    '[]',
    '{}',
    '{"invalid":{}}',
    JSON.stringify({ mad: null }),
    JSON.stringify({ mad: { ...system, authUrl: 'ftp://host' } }),
    JSON.stringify({ mad: { ...system, relayKey: 'short' } }),
    JSON.stringify({ mad: { ...system, origins: [] } }),
    JSON.stringify({ mad: { ...system, origins: ['http://host/path'] } }),
    JSON.stringify({ mad: { ...system, roles: {} } }),
    JSON.stringify({ mad: { ...system, roles: { MANAGER: ['unknown'] } } })
  ])('rejects unsafe registry: %s', raw => {
    expect(() => loadSubsystems(raw)).toThrow();
  });
  it('validates a central session and returns only allowed channels', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ sub: 'staff', role: 'MANAGER', expiresAt: 4102444800, passwordChangeRequired: false })
        )
      );
    expect(await new SharedAuthService().session('private', 'mad')).toEqual({
      sub: 'staff',
      role: 'MANAGER',
      expiresAt: 4102444800,
      channels: ['rooms']
    });
  });
  it.each([
    { sub: 'staff', role: 'WORKER', expiresAt: 4102444800, passwordChangeRequired: false },
    { sub: 'staff', role: 'MANAGER', expiresAt: 1, passwordChangeRequired: false },
    { sub: 'staff', role: 'MANAGER', expiresAt: 4102444800, passwordChangeRequired: true },
    {}
  ])('fails closed for denied or invalid central sessions', async body => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(new SharedAuthService().session('private', 'mad')).rejects.toMatchObject({ status: 401 });
  });
  it('rejects unknown subsystem, missing token and transport errors', async () => {
    const auth = new SharedAuthService();

    await expect(auth.session('private', 'unknown')).rejects.toMatchObject({ status: 401 });
    await expect(auth.session('', 'mad')).rejects.toMatchObject({ status: 401 });
    global.fetch = jest.fn().mockRejectedValue(new Error('private'));
    await expect(auth.session('private', 'mad')).rejects.toMatchObject({ status: 401 });
    global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(auth.session('private', 'mad')).rejects.toMatchObject({ status: 401 });
  });
});
