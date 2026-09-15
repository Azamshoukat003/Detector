const API = "https://api.github.com";

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

function headers(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "repo-guard",
  };
}

/** Raw request — use when a non-2xx status is meaningful (e.g. 404). */
export function ghRaw(token: string, path: string): Promise<Response> {
  return fetch(path.startsWith("http") ? path : API + path, {
    headers: headers(token),
    cache: "no-store",
  });
}

export async function gh<T>(token: string, path: string): Promise<T> {
  const res = await ghRaw(token, path);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      /* keep the raw slice */
    }
    throw new GitHubError(res.status, `GitHub ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export async function ghPost<T>(
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: string; errors?: unknown[] };
      if (parsed.message) {
        detail = parsed.message;
        if (parsed.errors?.length) detail += ` (${JSON.stringify(parsed.errors)})`;
      }
    } catch {
      /* keep the raw slice */
    }
    throw new GitHubError(res.status, `GitHub ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export async function ghPatch<T>(
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method: "PATCH",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      /* keep the raw slice */
    }
    throw new GitHubError(res.status, `GitHub ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export async function ghDelete(token: string, path: string): Promise<void> {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method: "DELETE",
    headers: headers(token),
    cache: "no-store",
  });
  // A successful ref deletion is 204 No Content.
  if (res.status === 204 || res.ok) return;
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    if (parsed.message) detail = parsed.message;
  } catch {
    /* keep the raw slice */
  }
  throw new GitHubError(res.status, `GitHub ${res.status}: ${detail}`);
}

export interface BranchSummary {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

/** Up to 300 branches — plenty for a personal account, and bounded. */
export async function listBranches(
  token: string,
  owner: string,
  repo: string,
): Promise<BranchSummary[]> {
  const out: BranchSummary[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh<BranchSummary[]>(
      token,
      `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
    );
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export interface CompareFile {
  filename: string;
  status: string;
  sha: string;
}

export interface CompareResponse {
  files?: CompareFile[];
  ahead_by: number;
  behind_by: number;
}

/**
 * Files that exist on `head` but not on `base`. This is exactly the set that
 * merging the branch would bring in, so it is the right thing to scan — and it
 * is one request per branch instead of a whole tree walk.
 */
export function compareBranches(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<CompareResponse> {
  return gh<CompareResponse>(
    token,
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
}

export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  html_url: string;
  pushed_at: string | null;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface TreeResponse {
  sha: string;
  tree: TreeEntry[];
  truncated: boolean;
}

export interface BlobResponse {
  sha: string;
  size: number;
  content: string;
  encoding: "base64" | "utf-8";
}

/** Two pages (200 repos) — enough for a personal account without paging UI. */
export async function listRepos(token: string): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  for (let page = 1; page <= 2; page++) {
    const batch = await gh<RepoSummary[]>(
      token,
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    );
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export function getTree(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<TreeResponse> {
  return gh<TreeResponse>(
    token,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
}

const NUL = String.fromCharCode(0);

export async function getBlobText(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<string | null> {
  const blob = await gh<BlobResponse>(token, `/repos/${owner}/${repo}/git/blobs/${sha}`);
  const text =
    blob.encoding === "base64"
      ? Buffer.from(blob.content, "base64").toString("utf8")
      : blob.content;
  // A NUL byte means binary; the regex rules are meaningless there.
  return text.includes(NUL) ? null : text;
}

/** Raw bytes of a blob — used for asset header checks, not for rule matching. */
export async function getBlobBytes(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<Buffer> {
  const blob = await gh<BlobResponse>(token, `/repos/${owner}/${repo}/git/blobs/${sha}`);
  return blob.encoding === "base64"
    ? Buffer.from(blob.content, "base64")
    : Buffer.from(blob.content, "utf8");
}

export interface ProtectionStatus {
  state: "protected" | "unprotected" | "unknown";
  requiresPullRequestReviews: boolean | null;
  requiredApprovingReviewCount: number | null;
  forcePushBlocked: boolean | null;
  detail?: string;
}

interface RawProtection {
  required_pull_request_reviews?: { required_approving_review_count?: number } | null;
  allow_force_pushes?: { enabled: boolean } | null;
}

/**
 * Branch protection needs admin on the repo. A 403 is not something the user
 * can act on from inside this tool, so it is reported as "unknown" rather
 * than failing the whole scan.
 */
export async function getBranchProtection(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<ProtectionStatus> {
  const res = await ghRaw(
    token,
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`,
  );

  if (res.status === 404) {
    return {
      state: "unprotected",
      requiresPullRequestReviews: false,
      requiredApprovingReviewCount: null,
      forcePushBlocked: false,
      detail: "No branch protection rule on the default branch.",
    };
  }

  if (res.status === 403 || res.status === 401) {
    return {
      state: "unknown",
      requiresPullRequestReviews: null,
      requiredApprovingReviewCount: null,
      forcePushBlocked: null,
      detail: "Requires admin access on the repo to read protection settings.",
    };
  }

  if (!res.ok) {
    return {
      state: "unknown",
      requiresPullRequestReviews: null,
      requiredApprovingReviewCount: null,
      forcePushBlocked: null,
      detail: `GitHub returned ${res.status} for the protection endpoint.`,
    };
  }

  const data = (await res.json()) as RawProtection;
  const reviews = data.required_pull_request_reviews ?? null;
  return {
    state: "protected",
    requiresPullRequestReviews: reviews !== null,
    requiredApprovingReviewCount: reviews?.required_approving_review_count ?? null,
    // The API reports whether force pushes are *allowed*; invert it.
    forcePushBlocked: !(data.allow_force_pushes?.enabled ?? false),
  };
}
