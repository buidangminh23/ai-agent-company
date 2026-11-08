import type { MachineId } from "./types.ts";

export type JobStatus = "ok" | "warn" | "error" | "stale" | "missing";
export type JobGroup = "sync" | "update" | "cleanup";

export type FigureKey = "pulled" | "updated" | "reclaimedMb";
export type JobFigures = Partial<Record<FigureKey, number>>;

export interface AutomationJob {
  id: string;
  name: string;
  group: JobGroup;
  schedule: string;
  status: JobStatus;
  lastRun: string | null;
  lastRunLabel: string;
  summary: string;
  details: string[];
  figures: JobFigures;
}

export interface MachineAutomation {
  id: MachineId;
  online: boolean;
  reported: boolean;
  checkedAt: string | null;
  jobs: AutomationJob[];
}

export interface AutomationReport {
  generatedAt: string;
  machines: MachineAutomation[];
}
