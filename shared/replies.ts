import type { MachineId } from "./types.ts";

export type ReplyApp = "claude" | "codex";
export type ReplyStatus = "pending" | "answered" | "rejected" | "unknown";
export type ReplyKind = "question" | "approval" | "plan";

export interface ReplyField {
  id: string;
  text: string;
  options: string[];
  multiSelect: boolean;
  allowFreeText: boolean;
  labels?: Record<string, string>;
  descriptions?: Record<string, string>;
  header?: string;
  optional?: boolean;
}

export const REPLY_DESCRIPTION_LIMIT = 1000;
export const REPLY_HEADER_LIMIT = 80;

export function replyFieldHints(field: ReplyField): Pick<ReplyField, "descriptions" | "header"> {
  const descriptions = field.options.filter((option) => field.descriptions && Object.hasOwn(field.descriptions, option)).map((option) => [option, field.descriptions![option]]);
  return { ...(descriptions.length ? { descriptions: Object.fromEntries(descriptions) } : {}), ...(field.header ? { header: field.header } : {}) };
}

export function replyFieldHintsValid(field: ReplyField): boolean {
  if (field.header !== undefined && (typeof field.header !== "string" || field.header.length > REPLY_HEADER_LIMIT || field.header.includes("\0"))) return false;
  if (field.descriptions === undefined) return true;
  if (!field.descriptions || typeof field.descriptions !== "object" || Array.isArray(field.descriptions)) return false;
  return Object.entries(field.descriptions).every(([option, value]) => field.options.includes(option) && typeof value === "string" && value.length <= REPLY_DESCRIPTION_LIMIT && !value.includes("\0"));
}

export interface ReplyQuestion {
  id: string;
  kind: ReplyKind;
  title: string;
  detail: string;
  agentId: string;
  app: ReplyApp;
  machine: MachineId;
  threadId: string;
  nativeRequestId: string;
  askedAt: string;
  fields: ReplyField[];
}

export interface ReplyAvailability {
  agentId: string;
  app: ReplyApp;
  machine: MachineId;
  reason: string;
}

export interface ReplyList {
  generatedAt: string;
  questions: ReplyQuestion[];
  unavailable: ReplyAvailability[];
}

export interface ReplySubmission {
  requestId: string;
  questionId: string;
  agentId: string;
  answers: Record<string, string[]>;
}

export interface ReplyReceipt {
  requestId: string;
  questionId: string;
  agentId: string;
  status: ReplyStatus;
  createdAt: string;
  updatedAt: string;
  detail: string;
}
