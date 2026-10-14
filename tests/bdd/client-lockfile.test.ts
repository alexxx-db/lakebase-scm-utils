// The scaffold must ship a COMMITTED client/package-lock.json that resolves from
// the public npm registry. These pin the two load-bearing pieces without hitting
// the network: the registry host-swap (pure, integrity-preserving) and the
// ensureClientLockfile guards (no-op without a client package.json; normalizes an
// existing lock in place; non-fatal). The actual `npm install --package-lock-only`
// resolve is network-bound and covered by the live create path, not here.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizeLockfileRegistry,
  ensureClientLockfile,
} from "../../scripts/lakebase/client-lockfile.js";

describe("normalizeLockfileRegistry (pure host-swap, integrity untouched)", () => {
  it("swaps every Databricks-proxy resolved host to the public registry", () => {
    const lock = JSON.stringify(
      {
        packages: {
          "node_modules/react": {
            resolved: "https://npm-proxy.cloud.databricks.com/react/-/react-18.3.1.tgz",
            integrity: "sha512-aaa",
          },
          "node_modules/vite": {
            resolved: "https://npm-proxy.cloud.databricks.com/vite/-/vite-5.0.0.tgz",
            integrity: "sha512-bbb",
          },
        },
      },
      null,
      2,
    );
    const { text, swaps } = normalizeLockfileRegistry(lock);
    expect(swaps).toBe(2);
    expect(text).not.toContain("npm-proxy.cloud.databricks.com");
    expect(text).toContain("https://registry.npmjs.org/react/-/react-18.3.1.tgz");
    // integrity hashes are preserved verbatim (passthrough mirror of same tarballs)
    expect(text).toContain("sha512-aaa");
    expect(text).toContain("sha512-bbb");
  });

  it("is a no-op (0 swaps) on an already-public lockfile", () => {
    const lock = '"resolved": "https://registry.npmjs.org/react/-/react-18.3.1.tgz"';
    const { text, swaps } = normalizeLockfileRegistry(lock);
    expect(swaps).toBe(0);
    expect(text).toBe(lock);
  });
});

describe("ensureClientLockfile (guards; non-fatal)", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-lock-"));
  });
  afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  it("is a no-op when there is no client package.json (non-UI project)", async () => {
    const r = await ensureClientLockfile({ projectDir });
    expect(r.generated).toBe(false);
    expect(r.reason).toMatch(/no client package\.json/);
  });
});
