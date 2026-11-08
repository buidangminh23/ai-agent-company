import type { MachineHealth, MachineId } from "./types.ts";

export type ServiceState = "running" | "stopped" | "error" | "unknown";
export type ServiceKind = "service" | "container" | "app";

export interface SystemProcess {
  pid: number;
  name: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
  uptimeSec: number | null;
}

export interface BackgroundService {
  id: string;
  name: string;
  description: string;
  kind: ServiceKind;
  state: ServiceState;
  pid: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  uptimeSec: number | null;
  detail: string;
  important: boolean;
}

export interface SystemInventory {
  checkedAt: string;
  services: BackgroundService[];
  processes: SystemProcess[];
  issues: string[];
}

export interface MachineSystem {
  id: MachineId;
  online: boolean;
  health: MachineHealth;
  inventory: SystemInventory | null;
}

export interface SystemReport {
  generatedAt: string;
  machines: MachineSystem[];
}

export const SYSTEM_STALE_MS = 120_000;

export function systemFresh(machine: MachineSystem, now = Date.now()): boolean {
  const checkedAt = Date.parse(machine.inventory?.checkedAt ?? "");
  return machine.online && Number.isFinite(checkedAt) && now - checkedAt >= -30_000 && now - checkedAt <= SYSTEM_STALE_MS;
}

export function serviceAttention(service: BackgroundService): boolean {
  return service.state === "error";
}
