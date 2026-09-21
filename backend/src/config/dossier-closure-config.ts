/**
 * Who may close and reopen a dossier. OPEN — FS-03 lists "dossier close/reopen
 * authority" as Delivery 1 configuration, and FS-01 §14 item 7 as a decision
 * still to be made.
 *
 * The default is the three decision-making roles, the same people who may
 * finalise and reopen the processing of a matter. Support staff prepare work;
 * closing the file on it is a decision. This is a placeholder, not a proposal:
 * narrow because a closure granted in the pilot cannot be un-granted from
 * history later.
 *
 * Not delegatable. DEC-13 governs delegation and its defaults do not include
 * closure; adding it would decide that question too.
 */
export interface DossierClosureConfig {
  rolesThatMayClose: string[];
}

export function loadDossierClosureConfig(): DossierClosureConfig {
  return {
    rolesThatMayClose: (process.env.DOSSIER_CLOSURE_ROLES ?? 'MINISTER,DIRECTEUR,ONDER_DIRECTEUR')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  };
}
