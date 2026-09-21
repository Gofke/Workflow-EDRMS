import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';

/**
 * Rejects any request without a valid session before the handler runs.
 *
 * Security is evaluated before anything is exposed (FR-SEC-006). V0.1.1 has no
 * business records yet, so this guard proves only the authentication boundary;
 * record-level and sensitivity evaluation is a later step.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const accountId = request.session?.accountId;

    if (!accountId) {
      throw new UnauthorizedException('You are not signed in.');
    }

    const user = await this.authService.loadAuthenticatedUser(accountId);
    if (!user) {
      // The account was disabled or removed during the session's lifetime.
      request.session.destroy(() => undefined);
      throw new UnauthorizedException('Your session is no longer valid.');
    }

    request.authenticatedUser = user;
    return true;
  }
}
