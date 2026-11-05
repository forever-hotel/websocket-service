import { Injectable, UnauthorizedException } from '@nestjs/common';
import { loadSubsystems, type LiveChannel } from './contracts';

export interface LiveSession {
  sub: string;
  role: string;
  expiresAt: number;
  channels: LiveChannel[];
  bookingId?: string;
  roomNumber?: string;
}

@Injectable()
export class SharedAuthService {
  readonly systems = loadSubsystems();

  async session(token: string, subsystem: string): Promise<LiveSession> {
    const system = this.systems[subsystem];

    if (!system || !token || token.length > 8192) throw new UnauthorizedException();
    try {
      const response = await fetch(system.authUrl, {
        headers: { authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(4000),
        redirect: 'error'
      });

      if (!response.ok) throw new Error();
      const body = (await response.json()) as {
        sub?: unknown;
        role?: unknown;
        expiresAt?: unknown;
        passwordChangeRequired?: unknown;
        bookingId?: unknown;
        roomNumber?: unknown;
      };

      if (
        typeof body.sub !== 'string' ||
        !body.sub ||
        typeof body.role !== 'string' ||
        !Object.hasOwn(system.roles, body.role) ||
        typeof body.expiresAt !== 'number' ||
        !Number.isSafeInteger(body.expiresAt) ||
        body.expiresAt * 1000 <= Date.now() ||
        body.passwordChangeRequired !== false
      )
        throw new Error();
      if (
        subsystem === 'foss' &&
        (body.role !== 'GUEST' ||
          typeof body.bookingId !== 'string' ||
          !body.bookingId ||
          typeof body.roomNumber !== 'string' ||
          !body.roomNumber)
      )
        throw new Error();
      return {
        sub: body.sub,
        role: body.role,
        expiresAt: body.expiresAt,
        channels: system.roles[body.role],
        ...(subsystem === 'foss' ? { bookingId: body.bookingId as string, roomNumber: body.roomNumber as string } : {})
      };
    } catch {
      throw new UnauthorizedException();
    }
  }
}
