import type { AgentApp, MachineId } from "./types.ts";

export type DispatchStatus = "queued" | "sending" | "accepted" | "delivered" | "replied" | "failed" | "unknown";

export interface DispatchTarget {
  agentId: string;
  app: AgentApp;
  machine: MachineId;
  title: string;
  project: string;
  available: boolean;
  reason: string;
}

export interface DispatchReceipt {
  id: string;
  status: DispatchStatus;
  targetAgentId: string;
  targetMachine: MachineId;
  summary: string;
  at: string;
  updatedAt: string;
  detail: string;
  author: "human-web";
}

export interface DispatchSubmission {
  requestId: string;
  targetAgentId: string;
  targetMachine: MachineId;
  message: string;
}

export interface DispatchList {
  generatedAt: string;
  targets: DispatchTarget[];
  receipts: DispatchReceipt[];
}

export function mergeDispatchReceipt(existing: DispatchReceipt | undefined, incoming: DispatchReceipt): DispatchReceipt {
  if (!existing) return incoming;
  if (existing.id !== incoming.id || existing.targetAgentId !== incoming.targetAgentId || existing.targetMachine !== incoming.targetMachine) return existing;
  const rank: Record<DispatchStatus, number> = { queued: 0, sending: 1, unknown: 1, accepted: 2, failed: 2, delivered: 3, replied: 4 };
  if (["replied", "failed"].includes(existing.status) || rank[incoming.status] < rank[existing.status] || rank[incoming.status] === rank[existing.status] && Date.parse(incoming.updatedAt) < Date.parse(existing.updatedAt)) return existing;
  return incoming;
}
