import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { GitHubError, listRepos } from "@/lib/github";
import type { RepoListItem } from "@/lib/scan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  try {
    const repos = await listRepos(session.accessToken);
    const items: RepoListItem[] = repos.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      owner: r.owner.login,
      private: r.private,
      fork: r.fork,
      archived: r.archived,
      defaultBranch: r.default_branch,
      htmlUrl: r.html_url,
      pushedAt: r.pushed_at,
      admin: Boolean(r.permissions?.admin),
    }));
    return NextResponse.json({ repos: items });
  } catch (err) {
    if (err instanceof GitHubError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Unknown error listing repos.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
