// GitHub repo CRUD via Octokit. Narrow surface ported from
// src/services/githubService.ts – only the methods create-project needs.
// All Octokit instances resolve their token through the unified seam
// (scripts/github/auth.ts).

import { Octokit, RequestError } from "octokit";
import { resolveGitHubToken, GITHUB_SCOPES } from "./auth.js";
import { parseOwnerRepo, formatOwnerRepo } from "../util/parse-owner-repo.js";

export class GitHubRepoError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubRepoError";
    this.status = status;
  }
}

interface OctokitContext {
  octokit: Octokit;
  /** Cached login of the authenticated user (avoids re-fetching for createRepo). */
  loginPromise?: Promise<string>;
}

async function newContext(): Promise<OctokitContext> {
  const token = await resolveGitHubToken();
  return { octokit: new Octokit({ auth: token }) };
}

function wrap(err: unknown, context: string): never {
  if (err instanceof RequestError) {
    throw new GitHubRepoError(`${context}: ${err.message}`, err.status);
  }
  if (err instanceof Error) {
    throw new GitHubRepoError(`${context}: ${err.message}`);
  }
  throw new GitHubRepoError(context);
}

async function getLogin(ctx: OctokitContext): Promise<string> {
  if (!ctx.loginPromise) {
    ctx.loginPromise = ctx.octokit.rest.users
      .getAuthenticated()
      .then(({ data }) => data.login);
  }
  return ctx.loginPromise;
}

/** Returns the GitHub login of the currently authenticated user. */
export async function getCurrentUser(): Promise<string> {
  try {
    const ctx = await newContext();
    return await getLogin(ctx);
  } catch (err) {
    wrap(err, "GitHub authentication failed");
  }
}

export interface GitHubScopeStatus {
  /** Granted OAuth scopes, or null when the token exposes NONE — a fine-grained
   *  PAT or GitHub App token carries no OAuth scope header; its permissions
   *  aren't a scope set, so callers MUST treat null as "unknown", never a miss. */
  granted: string[] | null;
  /** Required scopes absent from `granted` (empty when `granted` is null). */
  missing: string[];
}

/**
 * Read the authenticated token's granted OAuth scopes from the GitHub API
 * `x-oauth-scopes` response header and diff them against `required`. A classic
 * OAuth/PAT token returns a (possibly empty) comma-separated header; a
 * fine-grained PAT / GitHub App token omits it entirely → `granted: null`.
 * Reading your own user needs no special scope, so this succeeds for any VALID
 * token regardless of scopes (and throws, like the other ops, on a bad token /
 * network error — callers decide whether that is blocking).
 */
export async function checkGitHubScopes(
  required: readonly string[] = GITHUB_SCOPES
): Promise<GitHubScopeStatus> {
  try {
    const ctx = await newContext();
    const res = await ctx.octokit.rest.users.getAuthenticated();
    const header = (res.headers as Record<string, string | undefined>)["x-oauth-scopes"];
    if (header === undefined || header === null) return { granted: null, missing: [] };
    const granted = String(header)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { granted, missing: required.filter((s) => !granted.includes(s)) };
  } catch (err) {
    wrap(err, "GitHub scope check failed");
  }
}

export interface CreateRepoOptions {
  /** Make the repo private. Default: true. */
  private?: boolean;
  description?: string;
}

/**
 * Create a new GitHub repository. Accepts either bare name (creates for the
 * authenticated user) or "owner/name" (creates in org if owner != login).
 *
 * @returns the repo HTML URL.
 */
export async function createRepo(name: string, opts: CreateRepoOptions = {}): Promise<string> {
  try {
    const ctx = await newContext();
    const isPrivate = opts.private !== false;
    const description = opts.description;

    if (name.includes("/")) {
      const { owner, repo } = parseOwnerRepo(name);
      const login = await getLogin(ctx);
      let data;
      if (owner.toLowerCase() === login.toLowerCase()) {
        ({ data } = await ctx.octokit.rest.repos.createForAuthenticatedUser({
          name: repo,
          private: isPrivate,
          description,
        }));
      } else {
        ({ data } = await ctx.octokit.rest.repos.createInOrg({
          org: owner,
          name: repo,
          private: isPrivate,
          description,
        }));
      }
      return data.html_url || `https://github.com/${formatOwnerRepo(owner, repo)}`;
    }

    const { data } = await ctx.octokit.rest.repos.createForAuthenticatedUser({
      name,
      private: isPrivate,
      description,
    });
    return data.html_url || `https://github.com/${data.full_name}`;
  } catch (err) {
    wrap(err, `Failed to create repository "${name}"`);
  }
}

/** Delete a GitHub repository. Requires the `delete_repo` OAuth scope. */
export async function deleteRepo(name: string): Promise<void> {
  try {
    const { owner, repo } = parseOwnerRepo(name);
    const ctx = await newContext();
    await ctx.octokit.rest.repos.delete({ owner, repo });
  } catch (err) {
    wrap(err, `Failed to delete repository "${name}"`);
  }
}

/** True iff the repository exists and is visible to the authenticated user. */
export async function repoExists(name: string): Promise<boolean> {
  try {
    const { owner, repo } = parseOwnerRepo(name);
    const ctx = await newContext();
    await ctx.octokit.rest.repos.get({ owner, repo });
    return true;
  } catch (err) {
    if (err instanceof RequestError && err.status === 404) return false;
    wrap(err, `Failed to check repository "${name}"`);
  }
}

/**
 * Whether GitHub Actions is enabled for `ownerRepo`. `GET .../actions/permissions`
 * returns `enabled:false` both when a repo admin disabled Actions AND when an org
 * policy disables it for the repo. When Actions is off, the kit's CI workflows
 * (pr.yml / merge.yml) silently never run, which presents as "CI didn't follow
 * the kit workflow". Returns:
 *   - true / false  : the determined state
 *   - undefined     : couldn't determine (no token, repo invisible, API error) ,
 *                     callers must treat this as "unknown", never as disabled,
 *                     so a missing token never produces a false alarm.
 */
export async function getActionsEnabled(ownerRepo: string): Promise<boolean | undefined> {
  try {
    const { owner, repo } = parseOwnerRepo(ownerRepo);
    const ctx = await newContext();
    const { data } = await ctx.octokit.rest.actions.getGithubActionsPermissionsRepository({ owner, repo });
    return data.enabled;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the canonical `owner/repo` slug. Used by create-project to poll
 * until a freshly-created repo is visible (SAML / propagation delays).
 */
export async function getRepoFullName(name: string): Promise<string> {
  try {
    const { owner, repo } = parseOwnerRepo(name);
    const ctx = await newContext();
    const { data } = await ctx.octokit.rest.repos.get({ owner, repo });
    return data.full_name || formatOwnerRepo(owner, repo);
  } catch (err) {
    wrap(err, `Repository "${name}" is not visible`);
  }
}
