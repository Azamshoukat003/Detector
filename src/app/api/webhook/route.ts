import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sendAlert } from "@/lib/alert";
import { isSensitivePushPath } from "@/lib/scan-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PushCommit {
  id?: string;
  message?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
}

interface PushPayload {
  ref?: string;
  forced?: boolean;
  created?: boolean;
  deleted?: boolean;
  before?: string;
  after?: string;
  compare?: string;
  commits?: PushCommit[];
  head_commit?: PushCommit | null;
  repository?: { full_name?: string; html_url?: string };
  pusher?: { name?: string };
  sender?: { login?: string };
}

/**
 * Constant-time comparison of the delivered signature against ours.
 * Length is compared first because timingSafeEqual throws on a mismatch —
 * the length of a hex digest is not a secret.
 */
function signatureMatches(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function shortRef(ref: string | undefined): string {
  if (!ref) return "(unknown ref)";
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "tag:");
}

/** Paths in this push that touch one of the persistence-relevant config files. */
function sensitivePathsTouched(payload: PushPayload): string[] {
  const hits = new Set<string>();
  for (const commit of payload.commits ?? []) {
    for (const path of [...(commit.added ?? []), ...(commit.modified ?? [])]) {
      if (isSensitivePushPath(path)) hits.add(path);
    }
  }
  return [...hits].sort();
}

export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed: an unverifiable endpoint is worse than a broken one.
    console.error("[detector] GITHUB_WEBHOOK_SECRET is not set; rejecting delivery.");
    return NextResponse.json({ error: "Webhook secret not configured." }, { status: 500 });
  }

  // Must read the raw body: the HMAC is over the exact bytes GitHub sent.
  const raw = await request.text();

  if (!signatureMatches(raw, request.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  if (event === "ping") {
    return NextResponse.json({ ok: true, pong: true });
  }
  if (event !== "push") {
    return NextResponse.json({ ok: true, ignored: event ?? "unknown" });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(raw) as PushPayload;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const repoName = payload.repository?.full_name ?? "(unknown repo)";
  const ref = shortRef(payload.ref);
  const pusher = payload.pusher?.name ?? payload.sender?.login ?? "(unknown pusher)";
  const alerts: string[] = [];

  if (payload.forced === true) {
    const lines = [
      "**FORCE-PUSH DETECTED**",
      `repo:   ${repoName}`,
      `ref:    ${ref}`,
      `pusher: ${pusher}`,
      `before: ${payload.before ?? "?"}`,
      `after:  ${payload.after ?? "?"}`,
    ];
    if (payload.compare) lines.push(`compare: ${payload.compare}`);
    lines.push("History on this ref was rewritten. Verify this was you.");
    alerts.push(lines.join("\n"));
  }

  const touched = sensitivePathsTouched(payload);
  if (touched.length > 0) {
    alerts.push(
      [
        "**SENSITIVE CONFIG FILE CHANGED**",
        `repo:   ${repoName}`,
        `ref:    ${ref}`,
        `pusher: ${pusher}`,
        `files:  ${touched.join(", ")}`,
        "These files are used to hide dropped payloads and re-run them on build.",
      ].join("\n"),
    );
  }

  const deliveries = await Promise.all(alerts.map((text) => sendAlert(text)));
  const failed = deliveries.filter((d) => !d.sent);

  return NextResponse.json({
    ok: true,
    repo: repoName,
    ref,
    forced: payload.forced === true,
    sensitivePaths: touched,
    alertsRaised: alerts.length,
    alertsDelivered: deliveries.filter((d) => d.sent).length,
    ...(failed.length > 0 ? { deliveryErrors: failed.map((d) => d.reason) } : {}),
  });
}

/** GitHub only ever POSTs; a GET here is a human checking the URL. */
export function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "Detector webhook",
    expects: "POST with X-Hub-Signature-256 and X-GitHub-Event: push",
  });
}
