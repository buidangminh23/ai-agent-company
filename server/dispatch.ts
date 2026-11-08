import { L } from "../shared/i18n.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentInfo } from "../shared/types.ts";
import type { DispatchReceipt, DispatchStatus, DispatchSubmission, DispatchTarget } from "../shared/dispatch.ts";
import { mergeDispatchReceipt } from "../shared/dispatch.ts";
import { messageSummary } from "./sources/messages.ts";

export interface DispatchAdapter {
  inspect(agent: AgentInfo): Promise<{ available: boolean; reason: string }>;
  send(agent: AgentInfo, text: string, requestId: string): Promise<{ status: DispatchStatus; detail: string }>;
  check?(agent: AgentInfo, requestId: string): Promise<{ status: DispatchStatus; detail: string } | null>;
}

export class DispatchError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
}

export const DISPATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MACHINES = ["WORKSTATION", "SERVER", "LAPTOP"];

export function validateDispatch(value: unknown): DispatchSubmission {
  const body = value as DispatchSubmission;
  if (!body || typeof body !== "object" || !DISPATCH_ID.test(body.requestId) || typeof body.targetAgentId !== "string" || !body.targetAgentId || body.targetAgentId.length > 300 || !MACHINES.includes(body.targetMachine) || typeof body.message !== "string" || !body.message.trim() || body.message.length > 16000 || body.message.includes("\0")) throw new DispatchError(400, L("Nội dung hoặc đích gửi không hợp lệ"));
  return { requestId: body.requestId.toLowerCase(), targetAgentId: body.targetAgentId, targetMachine: body.targetMachine, message: body.message.trim() };
}

export class DispatchBroker {
  private db: DatabaseSync;
  private options: { adapter: DispatchAdapter; file?: string; onChange?: () => void; timeoutMs?: number };
  constructor(options: { adapter: DispatchAdapter; file?: string; onChange?: () => void; timeoutMs?: number }) {
    this.options = options;
    const file = options.file ?? process.env.MSC_DISPATCH_FILE ?? path.join(os.homedir(), ".msc-company", "communications.sqlite");
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS communications (id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL)");
    for (const row of this.db.prepare("SELECT receipt FROM communications").all()) {
      const receipt = JSON.parse(String(row.receipt)) as DispatchReceipt;
      if (receipt.status === "sending" || receipt.status === "queued") this.update(receipt.id, { status: "unknown", detail: L("Dịch vụ đã khởi động lại; chưa xác nhận kết quả, không tự gửi lại") });
    }
  }
  close(): void { this.db.close(); }
  private notify(): void { try { this.options.onChange?.(); } catch {} }
  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([operation(), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("dispatch timeout")), this.options.timeoutMs ?? 22000); })]); }
    finally { clearTimeout(timer!); }
  }
  receipts(): DispatchReceipt[] { return this.db.prepare("SELECT receipt FROM communications ORDER BY rowid DESC LIMIT 100").all().map(row => JSON.parse(String(row.receipt))); }
  receipt(id: string): DispatchReceipt | null {
    const row = this.db.prepare("SELECT receipt FROM communications WHERE id=?").get(id.toLowerCase());
    return row ? JSON.parse(String(row.receipt)) : null;
  }
  async refresh(agents: AgentInfo[], id?: string): Promise<void> {
    const check = this.options.adapter.check;
    if (!check) return;
    const receipts = (id ? [this.receipt(id)] : this.receipts().slice(0, 12)).filter((receipt): receipt is DispatchReceipt => Boolean(receipt && ["queued", "sending", "accepted", "delivered", "unknown"].includes(receipt.status)));
    await Promise.all(receipts.map(async receipt => {
      const matches = agents.filter(agent => agent.id === receipt.targetAgentId && agent.machine === receipt.targetMachine && !agent.parentId);
      if (matches.length !== 1) return;
      try {
        const result = await this.bounded(() => check(matches[0], receipt.id));
        if (result) this.reconcile({ ...receipt, ...result, updatedAt: new Date().toISOString() });
      } catch {}
    }));
  }
  async targets(agents: AgentInfo[]): Promise<DispatchTarget[]> {
    return Promise.all(agents.filter(agent => !agent.parentId).slice(0, 128).map(async agent => {
      let availability = { available: false, reason: L("Chưa xác minh được ứng dụng đích") };
      try { availability = await this.bounded(() => this.options.adapter.inspect(agent)); } catch {}
      return { agentId: agent.id, app: agent.app, machine: agent.machine, title: agent.title, project: agent.project, ...availability };
    }));
  }
  private update(id: string, change: Partial<DispatchReceipt>): DispatchReceipt {
    const receipt = { ...this.receipt(id)!, ...change, updatedAt: new Date().toISOString() };
    this.db.prepare("UPDATE communications SET receipt=? WHERE id=?").run(JSON.stringify(receipt), id);
    this.notify();
    return receipt;
  }
  reconcile(receipt: DispatchReceipt): DispatchReceipt | null {
    const existing = this.receipt(receipt.id);
    if (!existing || existing.targetAgentId !== receipt.targetAgentId || existing.targetMachine !== receipt.targetMachine) return existing;
    if (mergeDispatchReceipt(existing, receipt) === existing) return existing;
    if (existing.status === receipt.status && existing.detail === receipt.detail) return existing;
    return this.update(receipt.id, { status: receipt.status, detail: receipt.detail });
  }
  async submit(raw: unknown, agents: AgentInfo[], forward?: (submission: DispatchSubmission) => Promise<DispatchReceipt>): Promise<DispatchReceipt> {
    const body = validateDispatch(raw);
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const existing = this.db.prepare("SELECT digest, receipt FROM communications WHERE id=?").get(body.requestId);
    if (existing) {
      if (existing.digest !== digest) throw new DispatchError(409, L("Mã gửi đã được dùng cho nội dung khác"));
      return JSON.parse(String(existing.receipt));
    }
    const matches = agents.filter(agent => agent.id === body.targetAgentId && agent.machine === body.targetMachine && !agent.parentId);
    if (matches.length !== 1 || !matches[0].sessionId || !matches[0].cwd) throw new DispatchError(409, L("Không xác minh được đúng phiên đích; chưa gửi"));
    const agent = matches[0];
    const at = new Date().toISOString();
    const receipt: DispatchReceipt = { id: body.requestId, targetAgentId: agent.id, targetMachine: agent.machine, summary: messageSummary(body.message), status: "sending", at, updatedAt: at, detail: L("Đang xác minh và gửi yêu cầu"), author: "human-web" };
    this.db.prepare("INSERT INTO communications (id,digest,receipt) VALUES (?,?,?)").run(receipt.id, digest, JSON.stringify(receipt));
    this.notify();
    try {
      if (forward) {
        const result = await this.bounded(() => forward(body));
        if (result.id !== receipt.id || result.targetAgentId !== agent.id || result.targetMachine !== agent.machine) throw new Error("receipt mismatch");
        return this.update(receipt.id, { status: result.status, detail: result.detail });
      }
      let capability;
      try { capability = await this.bounded(() => this.options.adapter.inspect(agent)); }
      catch { return this.update(receipt.id, { status: "failed", detail: L("Không xác minh được ứng dụng đích trong thời gian cho phép; chưa gửi") }); }
      if (!capability.available) return this.update(receipt.id, { status: "failed", detail: capability.reason });
      const result = await this.bounded(() => this.options.adapter.send(agent, `[Human via AI Agent Company · ${body.requestId}]\n${body.message}`, body.requestId));
      return this.update(receipt.id, result);
    } catch (error) {
      const unsent = (error as { sent?: boolean })?.sent === false;
      return this.update(receipt.id, { status: unsent ? "failed" : "unknown", detail: unsent ? (error as { reason?: string }).reason ?? L("Ứng dụng từ chối trước khi gửi; chưa chuyển nội dung") : L("Chưa xác nhận được kết quả; không tự gửi lại, kiểm tra chat đích") });
    }
  }
}
