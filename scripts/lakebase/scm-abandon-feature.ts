// SCM workflow abandon (phase B+): unwind a feature claim.
//
// Transitions feature-claimed -> scaffold-complete. Best-effort cleanup
// of the paired Lakebase + git pair via deletePairedBranch, then resets
// the workflow-state row so the next claim can proceed. Refuses on a
// dirty working tree by default (uncommitted work would be lost when
// the branch is deleted) unless --force.
//
// The substrate primitive (deletePairedBranch) is non-throwing and
// returns per-side success flags; this helper records those as
// warnings rather than failing the transition, so a partial cleanup
// (e.g. Lakebase already deleted by an out-of-band script) still
// completes the state reset.

import { deletePairedBranch } from "./paired-branch.js";
import { type ScmWorkflowState } from "./scm-workflow-state.js";
import {
  ScmReleaseError,
  prepareClaimRelease,
  resetToScaffoldComplete,
} from "./scm-release-claim.js";

export { ScmReleaseError };

/** Back-compat alias: abandon historically threw its own error class. It is now a subclass of the
 *  shared `ScmReleaseError` so existing `instanceof ScmAbandonError` checks still narrow, while the
 *  shared release core (which both abandon and park use) throws the base. */
export class ScmAbandonError extends ScmReleaseError {}

export interface AbandonFeatureArgs {
  projectDir: string;
  /** Override the workflow's recorded instance. */
  instance?: string;
  /**
   * Skip the dirty-working-tree refusal. Uncommitted edits on the
   * feature branch are lost when the git branch is deleted; the
   * default refusal protects against that.
   */
  force?: boolean;
  /**
   * Switch HEAD to this branch before deleting the feature branch.
   * Defaults to the workflow row's parent_branch.
   */
  switchTo?: string;
}

export interface AbandonFeatureResult {
  state: ScmWorkflowState;
  lakebaseDeleted: boolean;
  gitLocalDeleted: boolean;
  gitRemoteDeleted: boolean;
  warnings: string[];
}

export async function abandonFeatureBranch(
  args: AbandonFeatureArgs,
): Promise<AbandonFeatureResult> {
  // Shared preamble: validate the claim is releasable + switch HEAD off the feature branch.
  const { current, warnings } = await prepareClaimRelease(
    { projectDir: args.projectDir, force: args.force, switchTo: args.switchTo },
    "abandon",
  );

  // Abandon's distinguishing step: tear down the paired Lakebase + git branch.
  const del = await deletePairedBranch({
    instance: args.instance ?? current.project_id,
    branch: current.branch,
    cwd: args.projectDir,
  });
  warnings.push(...del.warnings);

  const reset: ScmWorkflowState = resetToScaffoldComplete(args.projectDir, current);

  return {
    state: reset,
    lakebaseDeleted: del.lakebaseDeleted,
    gitLocalDeleted: del.gitLocalDeleted,
    gitRemoteDeleted: del.gitRemoteDeleted,
    warnings,
  };
}
