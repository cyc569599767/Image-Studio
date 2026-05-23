import type { backend } from "../../wailsjs/go/models";
import type { ProgressInfo, Workspace } from "../types/domain";

export type APIModeValue = "responses" | "images";

export interface RunningJobMeta {
  workspaceId: string;
  apiMode: APIModeValue;
}

export interface WorkspacePatch extends Partial<Workspace> {
  runningJobs?: string[];
  runningJobIds?: string[];
}

export interface WorkspaceRuntimeState {
  activeWorkspaceId: string;
  runningJobs: string[];
  jobsTotal: number;
  jobsCompleted: number;
  progress: ProgressInfo | null;
  lastLogLine: string;
  errorMessage: string | null;
  errorRawPath: string | null;
  lastPayload: backend.GenerateOptions | null;
  workspaces: Workspace[];
}

export interface WorkspaceRuntimeMirror {
  runningJobs: string[];
  jobsTotal: number;
  jobsCompleted: number;
  progress: ProgressInfo | null;
  lastLogLine: string;
  errorMessage: string | null;
  errorRawPath: string | null;
  lastPayload: backend.GenerateOptions | null;
  isRunning: boolean;
}

export function normalizeAPIMode(mode: string): APIModeValue {
  return String(mode).trim() === "images" ? "images" : "responses";
}

export function apiModeLabel(mode: string): string {
  return normalizeAPIMode(mode) === "images" ? "Images API" : "Responses API";
}

export function normalizeConcurrencyLimit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function normalizeBatchCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(9, Math.floor(n)));
}

export function patchWorkspaceRuntime(workspaces: Workspace[], workspaceId: string, patch: WorkspacePatch): Workspace[] {
  return workspaces.map((w) => {
    if (w.id !== workspaceId) return w;
    const next: Workspace = { ...w };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.currentImageId !== undefined) next.currentImageId = patch.currentImageId;
    if (patch.batchResultIds !== undefined) next.batchResultIds = patch.batchResultIds;
    if (patch.resultGridOpen !== undefined) next.resultGridOpen = patch.resultGridOpen;
    if (patch.runningJobs !== undefined) next.runningJobIds = patch.runningJobs;
    if (patch.runningJobIds !== undefined) next.runningJobIds = patch.runningJobIds;
    if (patch.jobsTotal !== undefined) next.jobsTotal = patch.jobsTotal;
    if (patch.jobsCompleted !== undefined) next.jobsCompleted = patch.jobsCompleted;
    if (patch.progress !== undefined) next.progress = patch.progress;
    if (patch.lastLogLine !== undefined) next.lastLogLine = patch.lastLogLine;
    if (patch.errorMessage !== undefined) next.errorMessage = patch.errorMessage;
    if (patch.errorRawPath !== undefined) next.errorRawPath = patch.errorRawPath;
    if (patch.lastPayload !== undefined) next.lastPayload = patch.lastPayload;
    return next;
  });
}

export function workspaceRuntimeFromState(
  s: WorkspaceRuntimeState,
  workspaceId: string,
): WorkspaceRuntimeMirror {
  if (s.activeWorkspaceId === workspaceId) {
    return {
      runningJobs: s.runningJobs,
      jobsTotal: s.jobsTotal,
      jobsCompleted: s.jobsCompleted,
      progress: s.progress,
      lastLogLine: s.lastLogLine,
      errorMessage: s.errorMessage,
      errorRawPath: s.errorRawPath,
      lastPayload: s.lastPayload,
      isRunning: s.runningJobs.length > 0,
    };
  }
  const w = s.workspaces.find((item) => item.id === workspaceId);
  const runningJobs = w?.runningJobIds ?? [];
  return {
    runningJobs,
    jobsTotal: w?.jobsTotal ?? 0,
    jobsCompleted: w?.jobsCompleted ?? 0,
    progress: w?.progress ?? null,
    lastLogLine: w?.lastLogLine ?? "",
    errorMessage: w?.errorMessage ?? null,
    errorRawPath: w?.errorRawPath ?? null,
    lastPayload: w?.lastPayload ?? null,
    isRunning: runningJobs.length > 0,
  };
}

export function activeRuntimePatch(patch: WorkspacePatch): Partial<WorkspaceRuntimeMirror> {
  const out: Partial<WorkspaceRuntimeMirror> = {};
  if (patch.runningJobs !== undefined) {
    out.runningJobs = patch.runningJobs;
    out.isRunning = patch.runningJobs.length > 0;
  }
  if (patch.runningJobIds !== undefined) {
    out.runningJobs = patch.runningJobIds;
    out.isRunning = patch.runningJobIds.length > 0;
  }
  if (patch.jobsTotal !== undefined) out.jobsTotal = patch.jobsTotal;
  if (patch.jobsCompleted !== undefined) out.jobsCompleted = patch.jobsCompleted;
  if (patch.progress !== undefined) out.progress = patch.progress;
  if (patch.lastLogLine !== undefined) out.lastLogLine = patch.lastLogLine;
  if (patch.errorMessage !== undefined) out.errorMessage = patch.errorMessage;
  if (patch.errorRawPath !== undefined) out.errorRawPath = patch.errorRawPath;
  if (patch.lastPayload !== undefined) out.lastPayload = patch.lastPayload;
  return out;
}

export function workspaceRunningCount(s: { runningJobMeta: Record<string, RunningJobMeta> }, apiMode: APIModeValue): number {
  return Object.values(s.runningJobMeta).filter((job) => job.apiMode === apiMode).length;
}
