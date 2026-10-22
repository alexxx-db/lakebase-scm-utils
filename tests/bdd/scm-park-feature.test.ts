// Unit tests for scm-park-feature (phase B+): release a claim but KEEP the branch.
// The distinguishing contract vs abandon is that deletePairedBranch is NEVER called — the parked
// feature's branch survives so a later re-claim can resume it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mockDeletePaired = vi.fn();
const mockIsDirty = vi.fn();
const mockGetCurrentBranch = vi.fn();
const mockExec = vi.fn();

vi.mock("../../scripts/lakebase/paired-branch.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../scripts/lakebase/paired-branch.js")
  >("../../scripts/lakebase/paired-branch.js");
  return {
    ...actual,
    deletePairedBranch: (...args: unknown[]) => mockDeletePaired(...args),
  };
});
vi.mock("../../scripts/git/inspect.js", () => ({
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
  getRepoRoot: vi.fn(),
}));
vi.mock("../../scripts/git/status.js", () => ({
  isDirty: (...args: unknown[]) => mockIsDirty(...args),
  hasUpstream: vi.fn(),
  getAheadBehind: vi.fn(),
}));
vi.mock("../../scripts/util/exec.js", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  shq: (s: string) => `'${s}'`,
}));

const park = await import("../../scripts/lakebase/scm-park-feature.js");
const state = await import("../../scripts/lakebase/scm-workflow-state.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-park-"));
  mockDeletePaired.mockReset();
  mockIsDirty.mockReset();
  mockGetCurrentBranch.mockReset();
  mockExec.mockReset();
  mockIsDirty.mockResolvedValue(false);
  mockGetCurrentBranch.mockResolvedValue("feature/x");
  mockExec.mockResolvedValue("");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedClaim(): void {
  state.writeWorkflowState(tmpDir, {
    version: 1,
    state: "feature-claimed",
    tier_topology: 2,
    project_id: "p",
    feature_id: "F6-split-tracking-code",
    branch: "feature/x",
    parent_branch: "staging",
    lakebase_branch_uid: "br-x",
    claimed_at: "2026-05-01T00:00:00Z",
  });
}

describe("parkFeatureBranch", () => {
  it("refuses when no state file", async () => {
    await expect(park.parkFeatureBranch({ projectDir: tmpDir })).rejects.toMatchObject({
      code: "no-state-file",
    });
  });

  it("refuses when not at feature-claimed", async () => {
    state.writeWorkflowState(tmpDir, {
      version: 1,
      state: "scaffold-complete",
      tier_topology: 2,
      project_id: "p",
    });
    await expect(park.parkFeatureBranch({ projectDir: tmpDir })).rejects.toMatchObject({
      code: "bad-precondition",
    });
  });

  it("refuses on dirty working tree without --force", async () => {
    seedClaim();
    mockIsDirty.mockResolvedValue(true);
    await expect(park.parkFeatureBranch({ projectDir: tmpDir })).rejects.toMatchObject({
      code: "dirty-working-tree",
    });
  });

  it("NEVER deletes the paired branch (the whole point) + resets state, keeping the branch", async () => {
    seedClaim();
    const result = await park.parkFeatureBranch({ projectDir: tmpDir });
    expect(mockDeletePaired).not.toHaveBeenCalled();
    expect(result.state.state).toBe("scaffold-complete");
    expect(result.state.feature_id).toBeUndefined();
    expect(result.keptBranch).toBe("feature/x");
    expect(result.parkedFeatureId).toBe("F6-split-tracking-code");
    // the row on disk is reset so the next claim can proceed
    expect(state.readWorkflowState(tmpDir)?.state).toBe("scaffold-complete");
  });

  it("switches HEAD to parent_branch before resetting", async () => {
    seedClaim();
    mockGetCurrentBranch.mockResolvedValue("feature/x");
    const result = await park.parkFeatureBranch({ projectDir: tmpDir });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("git checkout"),
      expect.objectContaining({ cwd: tmpDir }),
    );
    expect(mockExec.mock.calls[0][0]).toContain('"staging"');
    expect(result.switchedTo).toBe("staging");
  });

  it("--switch-to overrides parent_branch", async () => {
    seedClaim();
    await park.parkFeatureBranch({ projectDir: tmpDir, switchTo: "main" });
    expect(mockExec.mock.calls[0][0]).toContain('"main"');
  });

  it("--force overrides dirty check (branch still kept)", async () => {
    seedClaim();
    mockIsDirty.mockResolvedValue(true);
    const result = await park.parkFeatureBranch({ projectDir: tmpDir, force: true });
    expect(result.state.state).toBe("scaffold-complete");
    expect(mockDeletePaired).not.toHaveBeenCalled();
  });
});
