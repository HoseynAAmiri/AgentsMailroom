export type GoalsSkeletonMode = "goals" | "decisions" | "ready" | "active" | "board";
export type MailSkeletonVariant = "status" | "tasks" | "standard";

const GOALS_MODES: readonly GoalsSkeletonMode[] = ["goals", "decisions", "ready", "active", "board"];

export function resolveGoalsSkeletonMode(raw: unknown): GoalsSkeletonMode {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return resolveGoalsSkeletonMode(parsed);
      }
    } catch {
      return GOALS_MODES.includes(raw as GoalsSkeletonMode) ? (raw as GoalsSkeletonMode) : "goals";
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const mode = (raw as { viewMode?: unknown }).viewMode;
    if (typeof mode === "string" && GOALS_MODES.includes(mode as GoalsSkeletonMode)) {
      return mode as GoalsSkeletonMode;
    }
  }
  return "goals";
}

export function resolveMailSkeletonVariant(folder?: string | null): MailSkeletonVariant {
  if (folder === "status") return "status";
  if (folder === "tasks") return "tasks";
  return "standard";
}
