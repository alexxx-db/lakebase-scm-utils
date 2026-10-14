// Generate + normalize the client's package-lock.json at scaffold time, so a
// scaffolded UI project ships a COMMITTED lockfile that resolves from the
// public npm registry.
//
// WHY: createProject writes the client template + wires Playwright but never
// runs `npm install` in client/, so no package-lock.json exists at the initial
// commit. The user had to generate it by hand (README: `cd client && npm
// install`), and when they did it on the Databricks network the lock pinned
// npm-proxy.cloud.databricks.com in its `resolved` URLs — which hangs a cold
// install off-network (the lockfile-registry-guard hazard: the proxy host
// resolves but never accepts a TCP connection off the Databricks network).
//
// WHAT: `npm install --package-lock-only` resolves the dep tree and writes
// client/package-lock.json WITHOUT installing node_modules (fast, no tarball
// downloads), then we host-swap any Databricks-proxy `resolved` host to
// registry.npmjs.org (integrity hashes are unchanged — the proxy is a
// passthrough mirror of the same tarballs). The scaffold's `git add -A` initial
// commit then picks the normalized lock up for free.
//
// Non-fatal: a resolve failure (offline, registry down) is a warning, not a
// create abort — the user can still `cd client && npm install` as before.

import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "../util/exec.js";
import { withProxyEnv } from "../util/proxy-env.js";

/** The Databricks npm proxy host a cold off-network install hangs on. */
const PROXY_HOST = "npm-proxy.cloud.databricks.com";
/** The public registry every tracked lockfile must resolve from. */
const PUBLIC_HOST = "registry.npmjs.org";

export interface EnsureClientLockfileArgs {
  /** The project root (the client dir lives at <projectDir>/<clientDir>). */
  projectDir: string;
  /** The client dir name under projectDir. Default "client". */
  clientDir?: string;
}

export interface EnsureClientLockfileResult {
  /** True when a package-lock.json exists in the client dir after this ran. */
  generated: boolean;
  /** Count of proxy-host `resolved` URLs rewritten to the public registry. */
  swaps: number;
  /** Why it did not run / generate (no client package.json, exec error). */
  reason?: string;
}

/**
 * Host-swap any Databricks-proxy `resolved` URL to the public registry. A pure
 * string substitution — integrity hashes are left untouched because the proxy
 * is a passthrough mirror of the same tarballs. Returns the rewritten text and
 * the number of swaps.
 */
export function normalizeLockfileRegistry(lockText: string): { text: string; swaps: number } {
  let swaps = 0;
  const text = lockText.replace(new RegExp(PROXY_HOST.replace(/\./g, "\\."), "g"), () => {
    swaps++;
    return PUBLIC_HOST;
  });
  return { text, swaps };
}

/**
 * For a UI project, generate client/package-lock.json (lock only, no install)
 * and normalize its registry host. Idempotent, non-fatal: callers push the
 * reason onto their warnings and continue.
 */
export async function ensureClientLockfile(
  args: EnsureClientLockfileArgs,
): Promise<EnsureClientLockfileResult> {
  const clientDir = path.join(args.projectDir, args.clientDir ?? "client");
  const pkg = path.join(clientDir, "package.json");
  if (!fs.existsSync(pkg)) {
    return { generated: false, swaps: 0, reason: "no client package.json" };
  }
  const lockPath = path.join(clientDir, "package-lock.json");
  try {
    // --package-lock-only resolves the dep tree + writes the lock, skipping
    // node_modules (no tarball downloads), so the scaffold stays fast.
    await exec("npm install --package-lock-only", {
      cwd: clientDir,
      env: withProxyEnv(),
      timeout: 180_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { generated: fs.existsSync(lockPath), swaps: 0, reason: `npm resolve failed: ${msg}` };
  }
  if (!fs.existsSync(lockPath)) {
    return { generated: false, swaps: 0, reason: "npm wrote no package-lock.json" };
  }
  // Normalize proxy -> public registry so a cold off-network install never hangs.
  try {
    const { text, swaps } = normalizeLockfileRegistry(fs.readFileSync(lockPath, "utf8"));
    if (swaps > 0) fs.writeFileSync(lockPath, text);
    return { generated: true, swaps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { generated: true, swaps: 0, reason: `lock normalize failed: ${msg}` };
  }
}
