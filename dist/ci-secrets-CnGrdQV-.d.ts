/** The repo Actions secrets CI needs to provision a per-PR Lakebase branch. Missing ANY of
 *  these leaves CI unable to produce a DATABASE_URL, so the test step aborts — the failure
 *  that otherwise only surfaces at promotion, an entire feature after creation. */
declare const REQUIRED_CI_SECRETS: readonly ["DATABRICKS_HOST", "LAKEBASE_PROJECT_ID", "DATABRICKS_TOKEN"];
/** The canonical CI-token lifetime: 90 days. Durable so a CI rerun / downstream migrate that
 *  fires long after the push still authenticates (the ~1h OAuth session expiry bug, FEIP-8020). */
declare const CI_TOKEN_LIFETIME_SECONDS = 7776000;
/** Default margin: re-mint when the live CI token expires within this window of now, so the
 *  about-to-fire CI run gets a token that comfortably outlives it (and a 24h bootstrap token
 *  is upgraded to the durable one at the first preflight). */
declare const CI_TOKEN_REMINT_MARGIN_SECONDS = 86400;
/** The ONE CI-token comment, project-scoped so it is matchable in `databricks tokens list`
 *  (the expiry probe) and distinct per repo. `ownerRepo` is `owner/name`; the repo NAME is used
 *  (matching the scaffolded create-token-and-sync-secrets.sh convention). */
declare function ciTokenComment(ownerRepo: string): string;
/** Which required CI secrets are NOT present on the repo (empty = fully provisioned). Used to
 *  VERIFY a sync landed — a `databricks tokens create` or `gh secret set` that fails must be
 *  caught here, not swallowed, so CI-auth is never silently absent. NOTE: this checks the secret
 *  NAME exists, not whether the token behind it is still valid — expiry is {@link ciTokenExpiry}. */
declare function missingCiSecrets(ownerRepo: string): Promise<string[]>;
interface SyncCiSecretsArgs {
    /** Project root (used to resolve ownerRepo from `git remote` when not given,
     *  and as the cwd for the `databricks tokens create` call). */
    projectDir: string;
    /** Workspace host (DATABRICKS_HOST secret). Required. */
    databricksHost: string;
    /** Lakebase project id (LAKEBASE_PROJECT_ID secret). Required. */
    lakebaseProjectId: string;
    /** Token comment for `databricks tokens create`. Default: the canonical {@link ciTokenComment}. */
    comment?: string;
    /** Token lifetime in seconds. Default: {@link CI_TOKEN_LIFETIME_SECONDS} (90 days). */
    lifetimeSeconds?: number;
    /** Override the auto-detected ownerRepo (defaults to origin remote). */
    ownerRepo?: string;
}
/** Synchronize Databricks + Lakebase CI secrets to the repo's Actions secrets. Mints a fresh
 *  canonical CI credential; a dropped mint is fail-soft (HOST/PROJECT_ID still ship) — the caller
 *  verifies via {@link missingCiSecrets} and surfaces the gap. */
declare function syncCiSecrets(args: SyncCiSecretsArgs): Promise<void>;
interface CiTokenExpiryArgs {
    /** Project root (cwd for the CLI call + .env-based profile resolution). */
    projectDir: string;
    /** Workspace host the tokens live on. */
    databricksHost: string;
    /** ownerRepo (`owner/name`) — selects the canonical comment to match. */
    ownerRepo: string;
}
/** The latest expiry (epoch ms) of a LIVE canonical CI token for this repo, or null if none.
 *  `databricks tokens list` returns ONLY valid (unexpired) tokens, so an expired one simply does
 *  not appear → null. A no-expiry token (expiry_time -1) reads as Infinity. Fail-soft: any CLI /
 *  parse error returns null (→ the preflight re-mints, the safe direction). */
declare function ciTokenExpiry(args: CiTokenExpiryArgs): Promise<number | null>;
interface EnsureCiSecretsFreshArgs {
    projectDir: string;
    databricksHost: string;
    lakebaseProjectId: string;
    /** Override the auto-detected ownerRepo (defaults to origin remote). */
    ownerRepo?: string;
    /** Re-mint when the live token expires within this window. Default: {@link CI_TOKEN_REMINT_MARGIN_SECONDS}. */
    marginSeconds?: number;
    /** Injected clock (ms) for tests. Defaults to Date.now. */
    now?: () => number;
}
interface CiFreshnessResult {
    action: "ok" | "provisioned" | "reminted" | "skipped" | "failed";
    reason: string;
}
/** The expiry-aware preflight: ensure the repo's CI auth is CURRENT before a CI-triggering action
 *  (prepare-pr, scm-merge). Re-mints the canonical token when a required secret is missing, when
 *  no live canonical token exists (expired / never minted), or when the live token expires within
 *  the margin. A fresh token is left untouched. Throws only if a needed re-mint's sync throws;
 *  the caller runs it fail-soft (CI would fail anyway, so a mint failure is a loud warning). */
declare function ensureCiSecretsFresh(args: EnsureCiSecretsFreshArgs): Promise<CiFreshnessResult>;
/** The fail-soft entry both CI-dispatch seams (prepare-pr, scm-merge) use: resolve host +
 *  project-id from the project's `.env`, run {@link ensureCiSecretsFresh}, and NEVER throw —
 *  CI auth must never block opening a PR or promoting. Returns a `skipped` result when `.env`
 *  lacks the inputs (e.g. the pre-push hook will still refresh on the push) and a `failed` result
 *  when a needed re-mint's sync throws (surfaced as a loud note, not a block). */
declare function ensureCiSecretsFreshFromEnv(projectDir: string, opts?: {
    ownerRepo?: string;
    marginSeconds?: number;
}): Promise<CiFreshnessResult>;

export { CI_TOKEN_LIFETIME_SECONDS as C, type EnsureCiSecretsFreshArgs as E, REQUIRED_CI_SECRETS as R, type SyncCiSecretsArgs as S, CI_TOKEN_REMINT_MARGIN_SECONDS as a, type CiFreshnessResult as b, type CiTokenExpiryArgs as c, ciTokenComment as d, ciTokenExpiry as e, ensureCiSecretsFresh as f, ensureCiSecretsFreshFromEnv as g, missingCiSecrets as m, syncCiSecrets as s };
