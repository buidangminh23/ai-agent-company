import type { AgentApp, MachineId } from "./types.ts";

export type ControlAction = "stop" | "settings";
export type ControlStatus = "pending" | "done" | "rejected" | "unknown";

export interface ControlCapability {
  available: boolean;
  reason: string;
}

export interface ControlModel {
  id: string;
  label: string;
  efforts: string[];
}

export interface AgentSettingsState extends ControlCapability {
  model: string | null;
  effort: string | null;
  models: ControlModel[];
}

export interface AgentControlState {
  agentId: string;
  app: AgentApp;
  machine: MachineId;
  approvals: ControlCapability;
  questions: ControlCapability;
  send: ControlCapability;
  stop: ControlCapability & { warning: string };
  settings: AgentSettingsState;
}

export interface ControlList {
  generatedAt: string;
  agents: AgentControlState[];
}

export interface ControlSettingsChange {
  model?: string;
  effort?: string;
}

export interface ControlSubmission {
  requestId: string;
  agentId: string;
  machine: MachineId;
  action: ControlAction;
  settings?: ControlSettingsChange;
}

export interface ControlReceipt {
  requestId: string;
  agentId: string;
  action: ControlAction;
  status: ControlStatus;
  createdAt: string;
  updatedAt: string;
  detail: string;
}
