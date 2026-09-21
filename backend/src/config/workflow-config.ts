/**
 * Workflow parameters.
 *
 * DEC-15 — whether Reject is enabled, and with what required reason. OPEN, so
 * Reject is not built at all: FR-WFL-010 makes it conditional on Product
 * Authority explicitly enabling it, and building it behind a flag would decide
 * the question by default. Approve and Return for Correction are the PoC
 * demonstration path.
 *
 * Approval delegation is off by default. FR-WFL-006 allows an approval to
 * record represented authority where acting on behalf is explicitly permitted,
 * and "explicitly" is the operative word: approval authority is the last thing
 * that should spread by default.
 */
export interface WorkflowConfig {
  approvalDelegationEnabled: boolean;
}

export function loadWorkflowConfig(): WorkflowConfig {
  return {
    approvalDelegationEnabled: process.env.WORKFLOW_APPROVAL_DELEGATION === 'true',
  };
}
