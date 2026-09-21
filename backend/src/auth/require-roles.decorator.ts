import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { REQUIRED_ROLES, RolesGuard } from './roles.guard';

/** Marks a handler as requiring a valid session plus one of these roles. */
export function RequireRoles(...roles: string[]) {
  return applyDecorators(SetMetadata(REQUIRED_ROLES, roles), UseGuards(RolesGuard));
}
