import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { SessionGuard } from './session.guard';
import { AuthService } from './auth.service';

export const REQUIRED_ROLES = 'required_roles';

/**
 * Requires one of the named functional roles in addition to a valid session.
 *
 * The session is established first, so an unauthenticated caller receives 401
 * and an authenticated caller lacking the role receives 403. Neither response
 * says which role would have been sufficient: a refusal must not disclose who
 * does hold the capability.
 *
 * Holding a role is necessary, never sufficient on its own. FR-SEC-003 requires
 * scope, record relationship, sensitivity, delegation and workflow state to be
 * evaluated too. Those apply to business records, which arrive in a later
 * version; this guard is the role component only and must not be mistaken for
 * the whole evaluation.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const sessionValid = await new SessionGuard(this.authService).canActivate(context);
    if (!sessionValid) return false;

    const required = this.reflector.get<string[]>(REQUIRED_ROLES, context.getHandler()) ?? [];
    if (required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const held = (request.authenticatedUser?.roles ?? []).map(
      (r: { code: string; name: string }) => r.code,
    );

    if (!required.some((role) => held.includes(role))) {
      throw new ForbiddenException('You are not permitted to perform this action.');
    }
    return true;
  }
}
