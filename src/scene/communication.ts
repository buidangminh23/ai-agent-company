import { L } from "../../shared/i18n.ts";
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { AgentMessage, MachineId, MessageStatus, Snapshot } from "../../shared/types.ts";
import { messageStatus, messageStatusLabel } from "../../shared/messages.ts";
import type { AgentManager } from "../agents.ts";
import { MACHINE_ROOMS, ZONE_BY_ID } from "./layout.ts";
import { reducedMotion } from "../motion.ts";

const COLORS: Record<MessageStatus, number> = { queued: 0xe8b967, sending: 0x64bdff, accepted: 0x9b9cfa, delivered: 0x53dfb3, replied: 0x5be5ef, failed: 0xff747f, unknown: 0xe8b967 };
interface Flow {
  message: AgentMessage;
  group: THREE.Group;
  line: THREE.Line;
  packet: THREE.Mesh;
  ring: THREE.Mesh;
  label: CSS2DObject;
  curve: THREE.QuadraticBezierCurve3;
  age: number;
  offline: boolean;
}
export class CommunicationScene {
  private readonly flows = new Map<string, Flow>();
  private readonly seen = new Map<string, string>();
  private snapshot: Snapshot | null = null;
  private connected = true;
  private enabled = true;
  constructor(private scene: THREE.Scene, private agents: AgentManager) {}
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const flow of this.flows.values()) flow.group.visible = enabled;
  }
  setConnected(connected: boolean): void { this.connected = connected; }
  reset(): void {
    for (const flow of this.flows.values()) this.dispose(flow);
    this.flows.clear();
  }
  update(snapshot: Snapshot, replay: boolean): void {
    this.snapshot = snapshot;
    if (replay) this.reset();
    for (const message of snapshot.messages) {
      const signature = JSON.stringify([message.status, message.toId, message.detail, message.updatedAt]);
      if (this.seen.get(message.id) === signature) continue;
      this.seen.delete(message.id);
      this.seen.set(message.id, signature);
      if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!);
      const age = Date.now() - Date.parse(message.updatedAt ?? message.at);
      if (replay || !Number.isFinite(age) || age < -5000 || age > 90_000) continue;
      const existing = this.flows.get(message.id);
      if (existing) { existing.message = message; existing.age = 0; continue; }
      if (this.flows.size >= 16) {
        const first = this.flows.keys().next().value!;
        this.dispose(this.flows.get(first)!);
        this.flows.delete(first);
      }
      const group = new THREE.Group();
      const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: COLORS[messageStatus(message)], dashSize: 0.45, gapSize: 0.22, transparent: true, opacity: 0.65, depthTest: false }));
      const packet = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), new THREE.MeshBasicMaterial({ depthTest: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.4, 24), new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthTest: false }));
      ring.rotation.x = -Math.PI / 2;
      const element = document.createElement("span");
      element.className = "communication-label";
      const label = new CSS2DObject(element);
      group.add(line, packet, ring, label);
      group.visible = this.enabled;
      this.scene.add(group);
      this.flows.set(message.id, { message, group, line, packet, ring, label, curve: new THREE.QuadraticBezierCurve3(), age: 0, offline: false });
    }
  }
  private endpoint(id: string, machine?: MachineId): THREE.Vector3 | null {
    const position = this.agents.position(id);
    if (position) return position.setY(2.6);
    if (id.startsWith("human-web")) return new THREE.Vector3(0, 3, -19);
    const room = MACHINE_ROOMS.find((room) => room.machine === machine);
    const zone = room && ZONE_BY_ID.get(room.zone);
    return zone ? new THREE.Vector3((zone.x0 + zone.x1) / 2, 2.6, zone.z0 + 2) : null;
  }
  tick(dt: number): void {
    for (const [id, flow] of this.flows) {
      flow.age += dt;
      if (flow.age >= 12) { this.dispose(flow); this.flows.delete(id); continue; }
      const sender = this.snapshot?.agents.find((agent) => agent.id === flow.message.fromId);
      const recipient = this.snapshot?.agents.find((agent) => agent.id === flow.message.toId);
      const machine = recipient?.machine ?? flow.message.targetMachine;
      const start = this.endpoint(flow.message.fromId, sender?.machine);
      const end = this.endpoint(flow.message.toId, machine);
      flow.offline = !this.connected || this.snapshot?.machines.some((entry) => (entry.id === machine || entry.id === sender?.machine) && !entry.online) === true;
      flow.group.visible = this.enabled && start !== null;
      if (!start) continue;
      const destination = end ?? start.clone().add(new THREE.Vector3(0, 1, 0));
      flow.curve.v0.copy(start);
      flow.curve.v2.copy(destination);
      flow.curve.v1.copy(start).lerp(destination, 0.5).add(new THREE.Vector3(0, Math.min(6, start.distanceTo(destination) / 6 + 1), 0));
      const state = messageStatus(flow.message);
      const color = flow.offline ? 0xff747f : COLORS[state];
      flow.line.geometry.setFromPoints(flow.curve.getPoints(32));
      flow.line.computeLineDistances();
      (flow.line.material as THREE.LineDashedMaterial).color.setHex(color);
      (flow.packet.material as THREE.MeshBasicMaterial).color.setHex(color);
      (flow.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
      const quiet = reducedMotion();
      const moving = !flow.offline && Boolean(end) && ["sending", "accepted", "delivered", "replied"].includes(state);
      const progress = quiet || !moving ? 0.5 : (flow.age * 0.45) % 1;
      flow.packet.position.copy(flow.curve.getPoint(state === "replied" ? 1 - progress : progress));
      flow.packet.visible = Boolean(end) && !flow.offline && state !== "failed";
      flow.packet.rotation.y = quiet ? 0 : flow.age * 2;
      flow.ring.position.copy(state === "delivered" ? destination : start);
      flow.ring.scale.setScalar(quiet ? 1 : 1 + (Math.sin(flow.age * 3) + 1) * 0.25);
      flow.label.position.copy(flow.curve.getPoint(0.5)).add(new THREE.Vector3(0, 0.6, 0));
      flow.label.element.textContent = flow.offline ? L("Mất kết nối · chưa có cập nhật mới") : `${messageStatusLabel(state)}${end ? "" : L(" · chưa rõ phiên nhận")}`;
      flow.label.element.dataset.state = flow.offline ? "failed" : state;
      flow.label.element.title = flow.message.summary;
    }
  }
  private dispose(flow: Flow): void {
    flow.group.removeFromParent();
    flow.label.element.remove();
    for (const object of [flow.line, flow.packet, flow.ring]) {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
  }
}
