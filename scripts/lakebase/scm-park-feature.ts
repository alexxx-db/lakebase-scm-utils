// SCM workflow park (phase B+): release a feature claim WITHOUT tearing down the branch.
//
// Transitions feature-claimed -> scaffold-complete and switches HEAD to the parent tier, but — unlike
// abandon — KEEPS the paired Lakebase + git branch intact. This frees the single SCM claim so another
// feature can be claimed and driven, while the parked feature's work sits safely on its branch. The
// claim model makes RESUMING free: `lakebase-scm-claim-feature-branch <same-feature>` re-claims from
// scaffold-complete and `createFeaturePairedBranch` reuses the existing paired branch as-is (DB and
// all), picking the feature back up where it stopped.
//
// Use when a feature is built but NOT yet deployed/merged and you want to shelve it and go work on
// another. (Abandon is the throwaway counterpart: it deletes the branch.) Refuses on a dirty working
// tree by default (switching HEAD would strand uncommitted edits) unless --force.
//
// The preamble (precondition + dirty-guard + HEAD switch) and the scaffold-complete reset are the
// shared release core in scm-release-claim.ts, so park and abandon cannot drift.

import { type ScmWorkflowState } from "./scm-workflow-state.js";
import {
  ScmReleaseError,
  prepareClaimRelease,
  resetToScaffoldComplete,
} from "./scm-release-claim.js";

export { ScmReleaseError };

export interface ParkFeatureArgs {
  /** Project root (must contain .lakebase/workflow-state.json + .git/). */
  projectDir: string;
  /**
   * Skip the dirty-working-tree refusal. Uncommitted edits are NOT lost (the branch is kept), but
   * switching HEAD off the feature branch would leave them stranded on it, so the default refuses.
   */
  force?: boolean;
  /**
   * Switch HEAD to this branch after releasing the claim. Defaults to the workflow row's
   * parent_branch (the tier the feature forked from).
   */
  switchTo?: string;
}

export interface ParkFeatureResult {
  state: ScmWorkflowState;
  /** The branch left intact (git name) — resume with `lakebase-scm-claim-feature-branch`. */
  keptBranch: string;
  /** The feature id that was parked (for logging / the consort bookkeeping repoint). */
  parkedFeatureId: string;
  switchedTo: string;
  warnings: string[];
}

export async function parkFeatureBranch(
  args: ParkFeatureArgs,
): Promise<ParkFeatureResult> {
  // Shared preamble: validate the claim is releasable + switch HEAD off the feature branch.
  const { current, switchTo, warnings } = await prepareClaimRelease(
    { projectDir: args.projectDir, force: args.force, switchTo: args.switchTo },
    "park",
  );

  // Park's distinguishing (non-)step: the paired branch is DELIBERATELY left in place — this is the
  // whole point. Just reset the claim row so the next feature can be claimed.
  const reset = resetToScaffoldComplete(args.projectDir, current);

  return {
    state: reset,
    keptBranch: current.branch,
    parkedFeatureId: current.feature_id,
    switchedTo: switchTo,
    warnings,
  };
}
