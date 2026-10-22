// Shared core for the two ways to RELEASE an in-flight feature claim back to scaffold-complete:
//   - abandon (scm-abandon-feature): free the claim AND tear down the paired branch.
//   - park    (scm-park-feature):    free the claim but KEEP the paired branch, so the feature can
//                                     be resumed later (a re-claim reuses the existing branch as-is).
//
// Both share the exact same preamble — read state, require feature-claimed, require the claim's
// invariants, refuse a dirty tree (switching HEAD or deleting the branch would strand uncommitted
// work) unless --force, then switch HEAD off the feature branch — and the exact same tail: reset the
// workflow-state row to a bare scaffold-complete. The ONLY difference is whether the paired branch is
// deleted in between. Factored here so the two commands cannot drift (DRY); each command owns only its
// middle step and its own CLI surface.

import { getCurrentBranch } from "../git/inspect.js";
import { isDirty } from "../git/status.js";
import { exec } from "../util/exec.js";
import {
  readWorkflowState,
  writeWorkflowState,
  type ScmWorkflowState,
} from "./scm-workflow-state.js";

export type ScmReleaseErrorCode =
  | "no-state-file"
  | "bad-precondition"
  | "dirty-working-tree"
  | "missing-claim-fields";

/** The shared error for a claim release. `abandon` keeps its own `ScmAbandonError` as a subclass for
 *  back-compat; CLIs that map codes to exit statuses check `instanceof ScmReleaseError` (the base). */
export class ScmReleaseError extends Error {
  constructor(
    message: string,
    public readonly code: ScmReleaseErrorCode,
  ) {
    super(message);
    this.name = "ScmReleaseError";
  }
}

export interface ReleaseClaimArgs {
  /** Project root (must contain .lakebase/workflow-state.json + .git/). */
  projectDir: string;
  /** Skip the dirty-working-tree refusal. */
  force?: boolean;
  /** Branch to checkout before releasing. Defaults to the workflow row's parent_branch. */
  switchTo?: string;
}

/** A feature-claimed row with its claim invariants proven present, plus the resolved HEAD target. */
export interface PreparedRelease {
  current: ScmWorkflowState & {
    feature_id: string;
    branch: string;
    parent_branch: string;
    lakebase_branch_uid: string;
  };
  switchTo: string;
  warnings: string[];
}

/**
 * The shared preamble for abandon + park: validate the claim is releasable and switch HEAD off the
 * feature branch so the next step (delete, or just reset) is safe. `verb` ("abandon" | "park") only
 * shapes the human-facing refusal messages. Throws `ScmReleaseError` on any precondition failure.
 */
export async function prepareClaimRelease(
  args: ReleaseClaimArgs,
  verb: "abandon" | "park",
): Promise<PreparedRelease> {
  const current = readWorkflowState(args.projectDir);
  if (!current) {
    throw new ScmReleaseError(
      `No SCM workflow state found at ${args.projectDir}/.lakebase/workflow-state.json.`,
      "no-state-file",
    );
  }
  if (current.state !== "feature-claimed") {
    throw new ScmReleaseError(
      `${verb} refuses state "${current.state}". Only feature-claimed is ${verb}able; later states must complete or be reverted via gh.`,
      "bad-precondition",
    );
  }
  if (
    !current.feature_id ||
    !current.branch ||
    !current.parent_branch ||
    !current.lakebase_branch_uid
  ) {
    throw new ScmReleaseError(
      `feature-claimed row is missing required invariants. Cannot ${verb} safely; consider re-adopting state first.`,
      "missing-claim-fields",
    );
  }

  if (!args.force) {
    const dirty = await isDirty({ cwd: args.projectDir });
    if (dirty) {
      throw new ScmReleaseError(
        `Working tree has uncommitted changes; refusing to ${verb} (switching HEAD off the feature branch would strand them). Commit / stash / discard first, or pass --force.`,
        "dirty-working-tree",
      );
    }
  }

  const switchTo = args.switchTo ?? current.parent_branch;
  const warnings: string[] = [];

  // Switch HEAD off the feature branch first: abandon needs it so the local git branch can be
  // deleted (delete skips a checked-out branch); park needs it so the tree sits on the tier, ready
  // for the next claim. Best-effort — a checkout failure is a warning, not a hard stop.
  const headBranch = await getCurrentBranch({ cwd: args.projectDir });
  if (headBranch === current.branch) {
    try {
      await exec(`git checkout ${JSON.stringify(switchTo)}`, {
        cwd: args.projectDir,
        timeout: 10_000,
      });
    } catch (err) {
      warnings.push(
        `git checkout ${switchTo} failed: ${err instanceof Error ? err.message : String(err)}. Local branch state may be left on the feature branch.`,
      );
    }
  }

  return { current: current as PreparedRelease["current"], switchTo, warnings };
}

/**
 * Reset the workflow-state row to a bare scaffold-complete (no feature in flight), preserving only
 * the project-scoped facts (tier topology, project id). The shared tail of both abandon and park:
 * after this the next claim can proceed.
 */
export function resetToScaffoldComplete(
  projectDir: string,
  current: ScmWorkflowState,
): ScmWorkflowState {
  const reset: ScmWorkflowState = {
    $schema: current.$schema,
    version: 1,
    state: "scaffold-complete",
    tier_topology: current.tier_topology,
    project_id: current.project_id,
  };
  writeWorkflowState(projectDir, reset);
  return reset;
}
