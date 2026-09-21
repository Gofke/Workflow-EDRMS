import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { SessionGuard } from '../auth/session.guard';
import { DelegationService } from './delegation.service';

export const OWN_ROLES = 'own_roles';
export const DELEGATED_ACTION = 'delegated_action';

/**
 * Permits an action to a user who holds the role themselves, OR to a user
 * currently holding delegated authority for it.
 *
 * This is the mechanism FR-DEL-005 requires: support staff may perform an
 * assignment or due-date action on behalf of a principal only where the
 * delegation exists. Without one, they are refused exactly as before.
 *
 * When authority comes from a delegation, the represented authority is attached
 * to the request so the action records both parties (FR-DEL-003). A role holder
 * acting in their own right carries no represented authority, and none is
 * invented for them.
 */
@Injectable()
export class DelegatedAuthorityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly delegations: DelegationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const sessionValid = await new SessionGuard(this.authService).canActivate(context);
    if (!sessionValid) return false;

    const request = context.switchToHttp().getRequest<Request>();
    const ownRoles = this.reflector.get<string[]>(OWN_ROLES, context.getHandler()) ?? [];
    const action = this.reflector.get<string>(DELEGATED_ACTION, context.getHandler());
    const held = (request.authenticatedUser?.roles ?? []).map(
      (r: { code: string; name: string }) => r.code,
    );

    if (ownRoles.some((role) => held.includes(role))) return true;

    const authority = action
      ? await this.delegations.authorityFor(request.authenticatedUser?.accountId as string, action)
      : null;
    if (authority) {
      request.representedAuthority = authority;
      return true;
    }

    // The refusal does not say who could do it, nor that a delegation would
    // help — a denial should not map out the authority structure.
    throw new ForbiddenException('You are not permitted to perform this action.');
  }
}

/** Requires one of these roles, or an active delegation for this action. */
export function RequireRolesOrDelegation(action: string, ...roles: string[]) {
  return applyDecorators(
    SetMetadata(OWN_ROLES, roles),
    SetMetadata(DELEGATED_ACTION, action),
    UseGuards(DelegatedAuthorityGuard),
  );
}
