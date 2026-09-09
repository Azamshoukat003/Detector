/**
 * Outgoing alert delivery. One text string in, one Discord/Slack incoming
 * webhook POST out. Deliberately dependency-free and fire-once — there is no
 * queue or retry in v1, so a delivery failure is logged and reported in the
 * webhook response rather than silently swallowed.
 */

export type AlertKind = "discord" | "slack";

export interface AlertResult {
  sent: boolean;
  reason?: string;
}

function alertKind(): AlertKind {
  return process.env.ALERT_WEBHOOK_KIND?.toLowerCase() === "slack"
    ? "slack"
    : "discord";
}

export async function sendAlert(text: string): Promise<AlertResult> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) {
    console.warn("[repo-guard] ALERT_WEBHOOK_URL not set; alert dropped:", text);
    return { sent: false, reason: "ALERT_WEBHOOK_URL is not configured" };
  }

  const kind = alertKind();
  const body = kind === "slack" ? { text } : { content: text };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`[repo-guard] alert webhook returned ${res.status}: ${detail}`);
      return { sent: false, reason: `alert webhook returned ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[repo-guard] alert webhook request failed:", reason);
    return { sent: false, reason };
  }
}
