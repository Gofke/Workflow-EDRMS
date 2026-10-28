import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
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

    // Phase 3: a role that must use two-step verification may reach only the
    // screens that set it up until it has done so.
    if (request.session.mfaSetupRequired && !user.mfaEnabled) {
      const path = request.originalUrl ?? request.url ?? '';
      const allowed = ['/api/auth/', '/api/security/mfa', '/api/settings/public', '/api/settings/client'];
      if (!allowed.some((prefix) => path.startsWith(prefix))) {
        throw new ForbiddenException('Set up two-step verification before continuing.');
      }
    } else if (request.session.mfaSetupRequired && user.mfaEnabled) {
      request.session.mfaSetupRequired = false;
    }
    return true;
  }
}
