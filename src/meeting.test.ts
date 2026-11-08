import assert from "node:assert/strict";
import test from "node:test";
import type { AgentInfo, AgentState } from "../shared/types.ts";
import type { CeoMeetingStatus, MeetingAgenda } from "./scene/ceo.ts";
import type { LoungeCue } from "./scene/lounge.ts";
import { MeetingDirector } from "./meeting.ts";
import { meetingLayout } from "./scene/layout.ts";
import { ROLES } from "../shared/roles.ts";

const NOW = Date.parse("2026-11-01T08:00:00Z");

function agent(id: string, state: AgentState, task: string, project = "demo-app", at = NOW): AgentInfo {
  return { id, app: "claude", machine: "WORKSTATION", title: task, task, project, role: null, state, detail: "", parentId: null, updatedAt: new Date(at).toISOString(), pending: null };
}

class FakeHost {
  token = 0;
  status: CeoMeetingStatus | null = null;
  agendas: MeetingAgenda[] = [];
  requestMeeting(agenda: MeetingAgenda): number {
    this.agendas.push(agenda);
    this.status = { token: ++this.token, state: "waiting", time: 0, duration: 0 };
    return this.token;
  }
  meetingStatus(): CeoMeetingStatus | null {
    return this.status;
  }
}

class FakeStage {
  cues = new Map<string, LoungeCue>();
  lines = new Map<string, string | null>();
  stage(cues: Map<string, LoungeCue>): void {
    this.cues = cues;
  }
  say(id: string, text: string | null): void {
    this.lines.set(id, text);
  }
}

const crew = ["staff:WORKSTATION:po", "staff:WORKSTATION:ba", "staff:WORKSTATION:test", "life:ceo:assistant"].map((id) => agent(id, "idle", "Sẵn sàng nhận việc"));

test("meetings fill every chair and reserve the presenter's own chair during presentations", () => {
  const director = new MeetingDirector();
  const host = new FakeHost();
  const stage = new FakeStage();
  const staff = ["WORKSTATION", "LAPTOP", "SERVER"].flatMap((machine) => ROLES.map((role) => ({ ...agent(`staff:${machine}:${role.id}`, "idle", "Ready"), machine: machine as AgentInfo["machine"] })));
  const available = [...staff, ...crew];
  director.observe([], NOW);
  director.observe([agent("a", "working", "Plan")], NOW);
  director.frame(host, stage, NOW);
  const chairs = meetingLayout().chairs;
  const seated = director.pins(available);
  assert.equal(seated.size, chairs.length);
  assert.equal(new Set([...seated.values()].map((pin) => pin.key)).size, chairs.length);
  assert.ok(seated.has("life:ceo:assistant"));
  director.observe([agent("a", "working", "Plan"), agent("b", "working", "Review")], NOW);
  const joined = director.pins(available);
  assert.equal(joined.size, chairs.length);
  assert.ok(joined.has("b"));
  host.status = { token: 1, state: "meetListen", time: 1, duration: 14 };
  director.frame(host, stage, NOW);
  const presenting = director.pins(available);
  const audience = [...presenting.values()].filter((pin) => pin.pose === "sit");
  assert.equal(presenting.get("a")!.task, "present");
  assert.equal(audience.length, chairs.length - 1);
  assert.deepEqual(new Set(audience.map((pin) => pin.key)), new Set(chairs.slice(1).map((_, index) => `meeting:seat:${index + 1}`)));
  for (const [id, pin] of joined) if (id !== "a") assert.equal(presenting.get(id)?.key, pin.key);
  assert.equal(director.board()!.people, chairs.length + 1);
  host.status = { token: 1, state: "meetApprove", time: 1, duration: 5 };
  director.frame(host, stage, NOW);
  const returned = director.pins(available);
  assert.equal(returned.get("a")!.key, joined.get("a")!.key);
  assert.equal(returned.size, chairs.length);
  host.status = { token: 1, state: "meetReturn", time: 1, duration: 20 };
  director.frame(host, stage, NOW);
  assert.equal(director.pins(available).size, 0);
});

test("meeting attendance replaces unavailable staff without duplicating callers or seats", () => {
  const director = new MeetingDirector();
  const host = new FakeHost();
  const stage = new FakeStage();
  director.observe([], NOW);
  director.observe([agent("a", "working", "Plan")], NOW);
  director.frame(host, stage, NOW);
  const first = director.pins([...crew, agent("a", "working", "Plan")]);
  assert.equal(first.size, crew.length + 1);
  const unavailable = crew[1].id;
  const next = director.pins([...crew.filter((entry) => entry.id !== unavailable), agent("replacement", "idle", "Ready"), agent("blocked", "waiting", "Approval")]);
  assert.ok(!next.has(unavailable));
  assert.ok(!next.has("blocked"));
  assert.ok(next.has("replacement"));
  assert.equal(new Set([...next.values()].map((pin) => pin.key)).size, next.size);
});

test("the first snapshot only learns the office, later commands call a meeting", () => {
  const director = new MeetingDirector();
  director.observe([agent("a", "working", "Viết API")], NOW);
  assert.equal(director.pending(), null);
  director.observe([agent("a", "working", "Viết API"), agent("b", "working", "Làm landing page", "landing")], NOW);
  assert.deepEqual(director.pending(), { kind: "project", project: "landing", title: "Làm landing page", machine: "WORKSTATION", agentIds: ["b"] });
  director.observe([agent("a", "working", "Sửa lỗi đăng nhập"), agent("b", "working", "Làm landing page", "landing")], NOW + 1000);
  const call = director.pending()!;
  assert.deepEqual(call.agentIds, ["b", "a"]);
  assert.equal(call.kind, "project");
  assert.equal(call.title, "Sửa lỗi đăng nhập");
});

test("idle sessions that wake up count as a new order, but not stale or repeated ones", () => {
  const director = new MeetingDirector();
  director.observe([agent("a", "idle", "Viết API")], NOW);
  director.observe([agent("a", "working", "Viết API"), agent("old", "working", "Phiên cũ", "demo-app", NOW - 10 * 60_000)], NOW);
  assert.deepEqual(director.pending()!.agentIds, ["a"]);
  assert.equal(director.pending()!.kind, "order");
  director.observe([agent("a", "idle", "Viết API")], NOW + 5000);
  director.observe([agent("a", "working", "Viết API")], NOW + 10_000);
  assert.deepEqual(director.pending()!.agentIds, ["a"]);
  director.observe([agent("x", "working", "Phụ")].map((a) => ({ ...a, parentId: "a" })), NOW);
  assert.deepEqual(director.pending()!.agentIds, ["a"]);
});

test("a meeting seats callers and staff, moves the caller to present, then releases everyone", () => {
  const director = new MeetingDirector();
  const host = new FakeHost();
  const stage = new FakeStage();
  director.observe([], NOW);
  director.observe([agent("a", "working", "Dựng phòng họp")], NOW);
  assert.equal(director.frame(host, stage, NOW), true);
  assert.equal(host.agendas[0].title, "Dựng phòng họp");
  let pins = director.pins(crew);
  assert.deepEqual([...pins.keys()], ["a", "life:ceo:assistant", "staff:WORKSTATION:po", "staff:WORKSTATION:ba", "staff:WORKSTATION:test"]);
  assert.ok([...pins.values()].every((pin) => pin.pose === "sit" && pin.key.startsWith("meeting:seat:")));
  assert.equal(new Set([...pins.values()].map((pin) => pin.key)).size, pins.size);
  host.status = { token: 1, state: "meetOrder", time: 2, duration: 12 };
  director.frame(host, stage, NOW + 1000);
  assert.equal(stage.cues.size, 5);
  assert.equal(director.board()!.step, "Ra lệnh giao việc");
  host.status = { token: 1, state: "meetListen", time: 1, duration: 14 };
  director.frame(host, stage, NOW + 2000);
  pins = director.pins(crew);
  assert.equal(pins.get("a")!.task, "present");
  assert.equal(stage.cues.has("a"), false);
  assert.equal(stage.lines.get("a"), "Kế hoạch: Dựng phòng họp");
  host.status = { token: 1, state: "meetApprove", time: 2, duration: 5 };
  director.frame(host, stage, NOW + 3000);
  assert.equal(stage.lines.get("a"), "Rõ! Bắt tay vào làm ngay.");
  host.status = { token: 1, state: "meetReturn", time: 1, duration: 20 };
  director.frame(host, stage, NOW + 4000);
  assert.equal(director.pins(crew).size, 0);
  assert.equal(stage.lines.get("a"), null);
  host.status = null;
  director.frame(host, stage, NOW + 5000);
  assert.equal(director.board(), null);
  assert.equal(stage.cues.size, 0);
});

test("orders that arrive during the meeting join it, later ones wait for the next meeting", () => {
  const director = new MeetingDirector();
  const host = new FakeHost();
  const stage = new FakeStage();
  director.observe([], NOW);
  director.observe([agent("a", "working", "Việc A")], NOW);
  director.frame(host, stage, NOW);
  host.status = { token: 1, state: "meetWalk", time: 3, duration: 30 };
  director.frame(host, stage, NOW);
  director.observe([agent("a", "working", "Việc A"), agent("b", "working", "Việc B")], NOW);
  assert.deepEqual(director.pending()!.agentIds, ["a", "b"]);
  host.status = { token: 1, state: "meetListen", time: 1, duration: 14 };
  director.frame(host, stage, NOW);
  director.observe([agent("a", "working", "Việc A"), agent("b", "working", "Việc B"), agent("c", "working", "Việc C")], NOW);
  assert.deepEqual(director.pending()!.agentIds, ["a", "b"]);
  host.status = null;
  director.frame(host, stage, NOW + 1000);
  assert.deepEqual(director.pending()!.agentIds, ["c"]);
  assert.equal(host.agendas.length, 1);
  director.frame(host, stage, NOW + 22_000);
  assert.equal(host.agendas.length, 2);
  assert.equal(host.agendas[1].title, "Việc C");
});
