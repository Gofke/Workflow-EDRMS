import { Request } from 'express';
import { AuthenticatedUser } from '../auth/dto';
import { Actor } from '../records/registration.service';

/**
 * The actor of a request, always taken from the session — never from anything
 * the client sends. Where authority came from a delegation, the represented
 * authority travels with it (FR-DEL-003).
 */
export function actorFrom(request: Request): Actor {
  const user = request.authenticatedUser;
  const represented = request.representedAuthority;
  return {
    accountId: user?.accountId as string,
    description: user ? `${user.personName} (${user.email})` : 'unknown',
    onBehalfOfAccountId: represented?.principalAccountId,
    representedAuthority: represented?.principalDescription,
  };
}

export function userFrom(request: Request): AuthenticatedUser {
  return request.authenticatedUser as AuthenticatedUser;
}

/** The business roles: everyone whose work is the ministry's records. */
export const BUSINESS_ROLES = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER', 'RECORDS_MANAGER'];
/** Decision-makers. Preparation never grants this. */
export const DECISION_ROLES = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'];
/** Who may see management reporting across the ministry. */
export const MANAGEMENT_ROLES = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'];

/** Plain dd-mm-yyyy for messages a person reads. */
export function readableDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value.length === 10 ? `${value}T00:00:00Z` : value) : value;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

/** Today's date (yyyy-mm-dd) in Suriname time, which is UTC−3 all year. */
export function todayInSuriname(now = new Date()): string {
  const shifted = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
