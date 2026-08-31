import type { ComponentStatusSummary } from "./types.js";

const STATUS_ICON: Record<string, string> = {
  blocked_on_deps: "⏳",
  in_progress: "🔨",
  awaiting_input: "❓",
  ready_for_pr: "📝",
  pr_open: "🔀",
  merged: "✅",
  conflict_paused: "⚠️",
  usage_paused: "🛑",
};

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function shortLabel(taskDescription: string): string {
  const firstLine = taskDescription.split("\n")[0]!;
  return firstLine.length > 50 ? `${firstLine.slice(0, 47)}...` : firstLine;
}

// Shared between the real Slack board (mrkdwn) and the terminal fallback —
// the asterisks read as literal characters in a plain terminal, which is a
// minor cosmetic tradeoff for not duplicating the actual rendering logic.
export function renderStatusText(runId: number, components: ComponentStatusSummary[], now: Date = new Date()): string {
  const labelById = new Map(components.map((c) => [c.id, shortLabel(c.taskDescription)]));

  const lines = components.map((c) => {
    const icon = STATUS_ICON[c.status] ?? "•";
    const parts = [`${icon} *#${c.id} ${shortLabel(c.taskDescription)}*`, `\`${c.status}\``, `branch \`${c.branchName}\``];

    if (c.dependsOn.length && c.status === "blocked_on_deps") {
      const depLabels = c.dependsOn.map((depId) => `#${depId} ${labelById.get(depId) ?? "?"}`).join(", ");
      parts.push(`waiting on: ${depLabels}`);
    }

    if (c.prNumber !== null) {
      parts.push(`PR #${c.prNumber}`);
    }

    if (c.startedAt) {
      const elapsedMs = c.status === "merged" ? c.updatedAt.getTime() - c.startedAt.getTime() : now.getTime() - c.startedAt.getTime();
      parts.push(c.status === "merged" ? `took ${formatDuration(elapsedMs)}` : `running ${formatDuration(elapsedMs)}`);
    }

    return parts.join(" · ");
  });

  return [`*Run ${runId} status*`, ...lines].join("\n");
}
