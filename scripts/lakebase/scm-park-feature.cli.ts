#!/usr/bin/env node
// CLI: park the in-flight feature claim (free it, KEEP the branch) and reset to scaffold-complete.
// The resume-later counterpart to abandon. phase B+.

import * as path from "node:path";
import { isCliEntry } from "../util/cli-entry.js";
import { ScmReleaseError } from "./scm-release-claim.js";
import {
  parkFeatureBranch,
  type ParkFeatureResult,
} from "./scm-park-feature.js";

interface ParsedArgs {
  projectDir?: string;
  switchTo?: string;
  force?: boolean;
  json?: boolean;
  pretty?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--project-dir":
      case "--cwd":
        out.projectDir = argv[++i];
        break;
      case "--switch-to":
        out.switchTo = argv[++i];
        break;
      case "--force":
        out.force = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--pretty":
        out.pretty = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
    }
  }
  return out;
}

const HELP = `lakebase-scm-park-feature (phase B+)

Release a feature claim but KEEP its paired branch: switch HEAD to the parent
tier, reset workflow-state to scaffold-complete, leave the Lakebase + git
branch intact. Frees the single SCM claim so another feature can be claimed
and driven; resume the parked feature later with
'lakebase-scm-claim-feature-branch <feature>' (it reuses the kept branch).

Usage:
  lakebase-scm-park-feature [flags]

Flags:
  --project-dir <dir>   Project root (default: cwd)
  --switch-to <branch>  Branch to checkout after releasing (default: parent_branch)
  --force               Allow park even with a dirty working tree
                        (edits are kept but stranded on the feature branch)
  --json                Machine-readable JSON output
  --pretty              Pretty-print JSON (only with --json)
  -h, --help            Show this help

Exit codes:
  0 = parked (claim freed, branch kept, state reset to scaffold-complete)
  1 = no state file
  2 = precondition refused (wrong state, dirty tree without --force, missing fields)
  3 = substrate failure
`;

interface ParkReport {
  ok: boolean;
  result?: ParkFeatureResult;
  error?: { code: string; message: string };
}

function renderHuman(report: ParkReport): string {
  if (!report.ok) {
    return `lakebase-scm-park-feature: ${report.error?.code}\n\n  ${report.error?.message}`;
  }
  const r = report.result!;
  const lines: string[] = ["Feature parked (branch kept):"];
  lines.push(`  state          : ${r.state.state}`);
  lines.push(`  parked_feature : ${r.parkedFeatureId}`);
  lines.push(`  kept_branch    : ${r.keptBranch}`);
  lines.push(`  switched_to    : ${r.switchedTo}`);
  lines.push("");
  lines.push(`  resume with    : lakebase-scm-claim-feature-branch ${r.parkedFeatureId}`);
  if (r.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

function exitCodeForError(err: Error): number {
  if (err instanceof ScmReleaseError) {
    if (err.code === "no-state-file") return 1;
    return 2;
  }
  return 3;
}

export async function runScmParkFeatureCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const projectDir = path.resolve(args.projectDir ?? process.cwd());
  try {
    const result = await parkFeatureBranch({
      projectDir,
      switchTo: args.switchTo,
      force: args.force,
    });
    const report: ParkReport = { ok: true, result };
    if (args.json) {
      const indent = args.pretty ? 2 : 0;
      process.stdout.write(`${JSON.stringify(report, null, indent)}\n`);
    } else {
      process.stdout.write(`${renderHuman(report)}\n`);
    }
    return 0;
  } catch (e) {
    const err = e as Error;
    const code = err instanceof ScmReleaseError ? err.code : "substrate-failure";
    const report: ParkReport = { ok: false, error: { code, message: err.message } };
    if (args.json) {
      const indent = args.pretty ? 2 : 0;
      process.stdout.write(`${JSON.stringify(report, null, indent)}\n`);
    } else {
      process.stderr.write(`${renderHuman(report)}\n`);
    }
    return exitCodeForError(err);
  }
}

if (isCliEntry(import.meta.url)) {
  void runScmParkFeatureCli(process.argv.slice(2)).then((c) => process.exit(c));
}
