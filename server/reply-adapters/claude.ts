import { createHash } from "node:crypto";
import path from "node:path";
import { REPLY_DESCRIPTION_LIMIT, REPLY_HEADER_LIMIT } from "../../shared/replies.ts";
import type { ReplyField } from "../../shared/replies.ts";
import type { AgentInfo, MachineId } from "../../shared/types.ts";
import type { ClaudeHookDecision, ClaudeHookEntry, ClaudeHookRegistry } from "../claude-hook.ts";
import type { NativeReplyAdapter, NativeReplyQuestion } from "../replies.ts";

type Registry = Pick<ClaudeHookRegistry, "pending" | "resolve">;
type Data = Record<string, unknown>;

const ACCOUNT = "claude-hook";
const PLAN_LIMIT = 8000;
const DETAIL_LIMIT = 4000;
const ELLIPSIS = "\n… (đã cắt bớt)";
const PLAN_DEFAULT = "Sếp yêu cầu sửa lại kế hoạch trước khi làm.";
const DENY_DEFAULT = "Sếp đã từ chối thao tác này từ web công ty.";
const APPROVAL_LABELS: Record<string, string> = { allow: "Cho phép", "allow-always": "Luôn cho phép (theo gợi ý của Claude)", deny: "Từ chối", "deny-stop": "Từ chối và dừng lượt" };
const FEEDBACK_ID = "feedback";
const DECISION_ID = "decision";

const data = (value: unknown): Data | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : null;
const str = (value: unknown) => typeof value === "string" ? value : "";
const cut = (value: string, max: number) => value.length > max ? `${value.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}` : value;
const TRUNCATED_TITLE = " (nội dung quá dài, duyệt trong app)";
const normalizedCwd = (value: string) => /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\") ? path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase() : path.posix.normalize(value).replace(/\/+$/, "") || "/";
const version = (entry: ClaudeHookEntry) => createHash("sha256").update(JSON.stringify([entry.toolName, entry.toolInput])).digest("hex");
const valid = (value: string, max: number) => value.trim().length > 0 && value.length <= max && !value.includes("\0");

const QUESTION_LIMIT = 6000;
const FIELD_ID_LIMIT = 200;
const fieldId = (text: string, index: number) => text.length <= FIELD_ID_LIMIT ? text : `#${index + 1}`;

interface AskQuestion { text: string; options: string[]; multiSelect: boolean; header: string; descriptions: string[] }

function askQuestions(input: Data): AskQuestion[] | null {
  const list = input.questions;
  if (!Array.isArray(list) || list.length < 1 || list.length > 8) return null;
  const result: AskQuestion[] = [];
  for (const item of list) {
    const question = data(item);
    const text = str(question?.question);
    const options = Array.isArray(question?.options) ? question.options.map((option) => data(option)) : null;
    if (!question || !valid(text, QUESTION_LIMIT) || result.some((entry) => entry.text === text) || !options || options.length > 30 || options.some((option) => !option || !valid(str(option.label), 1000))) return null;
    const labels = options.map((option) => str(option!.label));
    if (new Set(labels).size !== labels.length) return null;
    result.push({ text, options: labels, multiSelect: question.multiSelect === true, header: str(question.header), descriptions: options.map((option) => str(option!.description)) });
  }
  return result;
}

const SUGGESTION_TYPES: Record<string, string> = { addRules: "Thêm quy tắc", replaceRules: "Thay quy tắc", removeRules: "Gỡ quy tắc", setMode: "Đổi chế độ", addDirectories: "Thêm thư mục", removeDirectories: "Gỡ thư mục" };

class Fields {
  readonly lines: string[] = [];
  private readonly used = new Set<string>();
  private readonly input: Data;
  constructor(input: Data) { this.input = input; }
  text(key: string, label: string, always = true): void {
    const value = this.input[key];
    if (typeof value !== "string") return;
    this.used.add(key);
    if (always || value) this.lines.push(`${label}: ${value}`);
  }
  flag(key: string, label: string): void {
    const value = this.input[key];
    if (typeof value !== "boolean") return;
    this.used.add(key);
    if (value) this.lines.push(label);
  }
  take(key: string): unknown { this.used.add(key); return this.input[key]; }
  rest(prefix = "Trường khác"): string {
    const extra = Object.fromEntries(Object.entries(this.input).filter(([key]) => !this.used.has(key)));
    return Object.keys(extra).length ? `${prefix}: ${JSON.stringify(extra)}` : "";
  }
}

function editText(value: unknown, index: number): string {
  const edit = data(value);
  if (!edit) return `[${index + 1}] ${JSON.stringify(value)}`;
  const fields = new Fields(edit);
  fields.flag("replace_all", "thay tất cả");
  const head = `[${index + 1}]${fields.lines.length ? ` ${fields.lines.pop()}` : ""}`;
  fields.text("old_string", "Thay");
  fields.text("new_string", "Thành");
  return [head, ...fields.lines, fields.rest()].filter(Boolean).join("\n");
}

function toolText(entry: ClaudeHookEntry): string {
  const fields = new Fields(entry.toolInput);
  switch (entry.toolName) {
    case "Bash":
      fields.flag("dangerouslyDisableSandbox", "⚠ Chạy ngoài sandbox (dangerouslyDisableSandbox)");
      fields.flag("run_in_background", "Chạy nền");
      fields.text("command", "Lệnh");
      fields.text("description", "Mô tả", false);
      break;
    case "Edit":
      fields.text("file_path", "Tệp");
      fields.flag("replace_all", "Thay tất cả chỗ trùng");
      fields.text("old_string", "Thay");
      fields.text("new_string", "Thành");
      break;
    case "MultiEdit": {
      fields.text("file_path", "Tệp");
      const edits = entry.toolInput.edits;
      if (Array.isArray(edits)) { fields.take("edits"); fields.lines.push(`Số chỗ sửa: ${edits.length}`, ...edits.map(editText)); }
      break;
    }
    case "Write":
      fields.text("file_path", "Tệp");
      fields.text("content", "Nội dung");
      break;
    case "NotebookEdit":
      fields.text("notebook_path", "Notebook");
      fields.text("cell_id", "Ô", false);
      fields.text("edit_mode", "Kiểu sửa", false);
      fields.text("new_source", "Nội dung");
      break;
    case "WebFetch":
      fields.text("url", "Địa chỉ");
      fields.text("prompt", "Yêu cầu", false);
      break;
    default: return JSON.stringify(entry.toolInput);
  }
  return [...fields.lines, fields.rest()].filter(Boolean).join("\n");
}

function suggestionText(value: unknown): string {
  const suggestion = data(value);
  if (!suggestion) return `• ${JSON.stringify(value)}`;
  const fields = new Fields(suggestion);
  const type = fields.take("type");
  const parts = [typeof type === "string" ? `${SUGGESTION_TYPES[type] ?? type} (${type})` : `Kiểu: ${JSON.stringify(type ?? null)}`];
  const behavior = suggestion.behavior;
  if (typeof behavior === "string") { fields.take("behavior"); parts.push(`hành vi: ${behavior}`); }
  const rules = suggestion.rules;
  if (Array.isArray(rules)) { fields.take("rules"); parts.push(`quy tắc: ${rules.map((rule) => { const item = data(rule); return item && typeof item.toolName === "string" && Object.keys(item).every((key) => key === "toolName" || (key === "ruleContent" && typeof item.ruleContent === "string")) ? `${item.toolName}${typeof item.ruleContent === "string" ? `(${item.ruleContent})` : ""}` : JSON.stringify(rule); }).join(", ") || "(không có)"}`); }
  if (typeof suggestion.mode === "string") { fields.take("mode"); parts.push(`chế độ: ${suggestion.mode}`); }
  const directories = suggestion.directories;
  if (Array.isArray(directories)) { fields.take("directories"); parts.push(`thư mục: ${directories.map((directory) => typeof directory === "string" ? directory : JSON.stringify(directory)).join(", ") || "(không có)"}`); }
  if (typeof suggestion.destination === "string") { fields.take("destination"); parts.push(`lưu vào: ${suggestion.destination}`); }
  const rest = fields.rest("khác");
  return `• ${[...parts, rest].filter(Boolean).join(" · ")}`;
}

function fullApprovalText(entry: ClaudeHookEntry): string {
  const tool = toolText(entry);
  if (!Array.isArray(entry.suggestions) || !entry.suggestions.length) return tool;
  return `${tool}\n\nNếu chọn Luôn cho phép:\n${entry.suggestions.map(suggestionText).join("\n")}`;
}

function approvalDetail(entry: ClaudeHookEntry): { text: string; truncated: boolean } {
  const text = fullApprovalText(entry);
  return { text: cut(text, DETAIL_LIMIT), truncated: text.length > DETAIL_LIMIT };
}

function feedbackField(text: string): ReplyField {
  return { id: FEEDBACK_ID, text, options: [], multiSelect: false, allowFreeText: true, optional: true };
}

function toQuestion(entry: ClaudeHookEntry, agent: AgentInfo, machine: MachineId): NativeReplyQuestion | null {
  const base = { agentId: agent.id, app: "claude" as const, machine, askedAt: entry.receivedAt, identity: { accountId: ACCOUNT, cwd: entry.cwd, sessionId: entry.sessionId, threadId: entry.sessionId, nativeRequestId: entry.id, version: version(entry) } };
  if (entry.toolName === "AskUserQuestion") {
    const questions = askQuestions(entry.toolInput);
    if (!questions) return null;
    const detail = questions.map((question) => [question.header && `[${question.header}]`, question.text, ...question.options.map((option, index) => `• ${option}${question.descriptions[index] ? `: ${question.descriptions[index]}` : ""}`)].filter(Boolean).join("\n")).join("\n\n");
    return { ...base, kind: "question", title: "Claude hỏi sếp", detail: cut(detail, DETAIL_LIMIT), fields: questions.map((question, position) => {
      const descriptions = question.options.map((option, index) => [option, question.descriptions[index].slice(0, REPLY_DESCRIPTION_LIMIT)]).filter(([, description]) => description);
      return { id: fieldId(question.text, position), text: question.text, options: question.options, multiSelect: question.multiSelect, allowFreeText: true, ...(descriptions.length ? { descriptions: Object.fromEntries(descriptions) } : {}), ...(question.header ? { header: question.header.slice(0, REPLY_HEADER_LIMIT) } : {}) };
    }) };
  }
  if (entry.toolName === "ExitPlanMode") return { ...base, kind: "plan", title: "Claude xin duyệt kế hoạch", detail: cut(str(entry.toolInput.plan), PLAN_LIMIT), fields: [{ id: DECISION_ID, text: "Kế hoạch chỉ duyệt được trong app; từ web sếp có thể yêu cầu Claude sửa lại", options: ["revise"], labels: { revise: "Yêu cầu sửa kế hoạch" }, multiSelect: false, allowFreeText: false }, feedbackField("Góp ý cho Claude (không bắt buộc)")] };
  const detail = approvalDetail(entry);
  const options = [...(detail.truncated ? [] : ["allow", ...(Array.isArray(entry.suggestions) && entry.suggestions.length ? ["allow-always"] : [])]), "deny", "deny-stop"];
  return { ...base, kind: "approval", title: `Claude xin quyền dùng ${entry.toolName}${detail.truncated ? TRUNCATED_TITLE : ""}`, detail: detail.text, fields: [{ id: DECISION_ID, text: "Quyết định của sếp", options, labels: Object.fromEntries(options.map((option) => [option, APPROVAL_LABELS[option]])), multiSelect: false, allowFreeText: false }, feedbackField("Lời nhắn cho Claude khi từ chối (không bắt buộc)")] };
}

function fits(fields: ReplyField[], answers: Record<string, string[]>): boolean {
  const ids = new Set(fields.map((field) => field.id));
  if (!answers || typeof answers !== "object" || Object.keys(answers).some((id) => !ids.has(id))) return false;
  return fields.every((field) => {
    const values = answers[field.id];
    if (values === undefined || (Array.isArray(values) && !values.length)) return field.optional === true;
    return Array.isArray(values) && (field.multiSelect || values.length === 1) && new Set(values).size === values.length && values.every((value) => typeof value === "string" && valid(value, 4000) && (field.allowFreeText || field.options.includes(value)));
  });
}

function decisionFor(entry: ClaudeHookEntry, kind: NativeReplyQuestion["kind"], answers: Record<string, string[]>): ClaudeHookDecision {
  const feedback = answers[FEEDBACK_ID]?.[0]?.trim() ?? "";
  if (kind === "question") {
    const names = new Map((askQuestions(entry.toolInput) ?? []).map((question, index) => [fieldId(question.text, index), question.text]));
    return { behavior: "allow", updatedInput: { ...entry.toolInput, answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [names.get(id) ?? id, values.join(", ")])) } };
  }
  if (kind === "plan") return { behavior: "deny", message: feedback || PLAN_DEFAULT };
  const decision = answers[DECISION_ID][0];
  if (decision === "allow") return { behavior: "allow" };
  if (decision === "allow-always") return { behavior: "allow", updatedPermissions: structuredClone(entry.suggestions ?? []) };
  return decision === "deny-stop" ? { behavior: "deny", message: feedback || DENY_DEFAULT, interrupt: true } : { behavior: "deny", message: feedback || DENY_DEFAULT };
}

export function createClaudeReplyAdapter(registry: Registry, machine: MachineId): NativeReplyAdapter {
  const eligible = (agent: AgentInfo) => agent.app === "claude" && agent.machine === machine && agent.parentId === null && typeof agent.sessionId === "string" && typeof agent.cwd === "string";
  return {
    app: "claude",
    async list(agent) {
      if (!eligible(agent)) return [];
      const cwd = normalizedCwd(agent.cwd!);
      return registry.pending(agent.sessionId!).filter((entry) => normalizedCwd(entry.cwd) === cwd).map((entry) => toQuestion(entry, agent, machine)).filter((question): question is NativeReplyQuestion => question !== null).slice(0, 16);
    },
    async submit(question, answers, context) {
      if (context.author !== "human-web" || context.signal.aborted || question.app !== "claude" || question.machine !== machine || question.identity.accountId !== ACCOUNT) return { status: "stale" };
      const entry = registry.pending(question.identity.sessionId).find((item) => item.id === question.identity.nativeRequestId);
      if (!entry || version(entry) !== question.identity.version || normalizedCwd(entry.cwd) !== normalizedCwd(question.identity.cwd)) return { status: "stale" };
      const current = toQuestion(entry, { id: question.agentId, app: "claude", machine, sessionId: entry.sessionId, cwd: entry.cwd, parentId: null } as AgentInfo, machine);
      if (!current || current.kind !== question.kind || JSON.stringify(current.fields) !== JSON.stringify(question.fields) || !fits(current.fields, answers)) return { status: "stale" };
      return { status: registry.resolve(entry.id, decisionFor(entry, current.kind, answers)) ? "answered" : "stale" };
    },
  };
}
