/**
 * DEC-13 — the delegation capability matrix. OPEN.
 *
 * Which roles may delegate, which actions may be delegated, and the longest
 * period a delegation may run for are all configuration. The defaults are
 * deliberately narrow: the roles that already hold the authority may delegate
 * it, and only the two actions the build actually has.
 *
 * This is a placeholder, not a recommendation. Narrow was chosen because a
 * delegation granted in a pilot cannot be un-granted from history later.
 */
export interface DelegationConfig {
  rolesThatMayDelegate: string[];
  delegatableActions: string[];
  maxDurationDays: number;
}

export function loadDelegationConfig(): DelegationConfig {
  return {
    rolesThatMayDelegate: (process.env.DELEGATION_GRANTING_ROLES ??
      'MINISTER,DIRECTEUR,ONDER_DIRECTEUR')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
    delegatableActions: (process.env.DELEGATABLE_ACTIONS ??
      'ASSIGN_RESPONSIBILITY,SET_DUE_DATE')
      .split(',')
      .map((action) => action.trim())
      .filter(Boolean),
    maxDurationDays: Number(process.env.DELEGATION_MAX_DURATION_DAYS ?? 90),
  };
}
