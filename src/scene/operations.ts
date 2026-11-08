import { L } from "../../shared/i18n.ts";
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { AgentInfo, Snapshot } from "../../shared/types.ts";
import { deriveOperations, type OperationsSnapshot } from "../../shared/operations.ts";
import type { AgentManager } from "../agents.ts";
import { STATE_LABELS } from "../agents.ts";
import { reducedMotion } from "../motion.ts";
import { CanvasPanel } from "./labels.ts";

const INBOX_EMPTY = L("<svg class=\"office-inbox-icon\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M3.5 8.5l3 3 6-7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg><span>Không có việc chờ</span>");

interface DeskScreen {
  panel: CanvasPanel;
  mesh: THREE.Mesh;
  signature: string;
}

interface Burst {
  points: THREE.Points;
  velocity: Float32Array;
  age: number;
}

export class OperationsScene {
  private readonly root = new THREE.Group();
  private readonly screens = new Map<string, DeskScreen>();
  private readonly warnings = new Map<string, CSS2DObject>();
  private readonly lines: THREE.Line[] = [];
  private readonly bursts: Burst[] = [];
  private readonly completed = new Map<string, string>();
  private readonly inbox: HTMLButtonElement;
  private initialized = false;
  private enabled = true;

  constructor(scene: THREE.Scene, private agents: AgentManager, open: () => void) {
    scene.add(this.root);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "office-inbox";
    button.dataset.count = "0";
    button.innerHTML = INBOX_EMPTY;
    button.setAttribute("aria-controls", "operations-dashboard");
    button.addEventListener("click", open);
    this.inbox = button;
    const controls = document.createElement("div");
    controls.className = "office-controls";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", L("Điều khiển văn phòng"));
    controls.append(button);
    document.body.append(controls);
  }

  setEffects(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clearBursts();
  }

  reset(): void {
    for (const item of this.screens.values()) {
      item.mesh.removeFromParent();
      item.mesh.geometry.dispose();
      item.panel.dispose();
    }
    this.screens.clear();
    this.clearWarnings();
    this.clearBursts();
    this.initialized = false;
    this.completed.clear();
  }

  update(snapshot: Snapshot, replay = false): void {
    const ops = deriveOperations(snapshot, { from: null, to: null, retentionDays: 0, persistent: false, note: "" });
    const count = ops.attention.length;
    if (this.inbox.dataset.count !== String(count)) {
      this.inbox.dataset.count = String(count);
      this.inbox.innerHTML = count ? L("<span class=\"office-inbox-count\" aria-hidden=\"true\">{0}</span><span>Cần sếp xử lý</span>", count) : INBOX_EMPTY;
    }
    this.inbox.setAttribute("aria-label", count ? L("{0} việc cần sếp xử lý. Mở danh sách", count) : L("Không có việc cần sếp xử lý. Mở danh sách"));
    const used = new Set<string>();
    for (const agent of snapshot.agents) {
      const desk = this.agents.desk(agent.id);
      if (desk && !used.has(desk.key)) {
        used.add(desk.key);
        let screen = this.screens.get(desk.key);
        if (!screen) {
          const panel = new CanvasPanel(512, 288);
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.32), panel.material);
          mesh.position.set(desk.x - 0.1, 1.09, desk.z - 1.06);
          this.root.add(mesh);
          screen = { panel, mesh, signature: "" };
          this.screens.set(desk.key, screen);
        }
        const signature = JSON.stringify([agent.project, agent.state, agent.task, agent.detail]);
        if (screen.signature !== signature) {
          screen.signature = signature;
          this.drawScreen(screen.panel, agent);
        }
      }
    }
    for (const [key, screen] of this.screens) {
      if (used.has(key)) continue;
      screen.mesh.removeFromParent();
      screen.mesh.geometry.dispose();
      screen.panel.dispose();
      this.screens.delete(key);
    }
    this.clearWarnings();
    for (const alert of ops.attention) {
      if (alert.kind !== "stalled" && alert.kind !== "conflict") continue;
      for (const id of alert.agentIds) {
        if (this.warnings.has(id)) continue;
        const label = document.createElement("span");
        label.className = "office-warning";
        label.textContent = alert.kind === "conflict" ? L("Sửa trùng file") : L("Lâu chưa cập nhật");
        label.title = alert.detail;
        const object = new CSS2DObject(label);
        this.root.add(object);
        this.warnings.set(id, object);
      }
    }
    for (const conflict of ops.conflicts.slice(0, 24)) {
      const start = this.agents.position(conflict.agentIds[0]);
      if (!start) continue;
      for (const id of conflict.agentIds.slice(1)) {
        const end = this.agents.position(id);
        if (!end) continue;
        start.y = 2;
        end.y = 2;
        const middle = start.clone().lerp(end, 0.5);
        middle.y = 4;
        const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)), new THREE.LineDashedMaterial({ color: 0xffb547, dashSize: 0.3, gapSize: 0.18, transparent: true, opacity: 0.8 }));
        line.computeLineDistances();
        this.root.add(line);
        this.lines.push(line);
      }
    }
    if (replay) this.initialized = false;
  }

  applyOperations(operations: OperationsSnapshot): void {
    const ids = new Set<string>();
    for (const task of operations.tasks) {
      ids.add(task.id);
      const completion = task.stage === "completed" ? task.agent.outcome?.at ?? "" : "";
      if (completion && this.initialized && this.completed.get(task.id) !== completion) this.celebrate(task.id);
      this.completed.set(task.id, completion);
    }
    for (const id of this.completed.keys()) if (!ids.has(id)) this.completed.delete(id);
    this.initialized = true;
  }

  private drawScreen(panel: CanvasPanel, agent: AgentInfo): void {
    const g = panel.ctx;
    g.fillStyle = "#101b2c";
    g.fillRect(0, 0, 512, 288);
    g.fillStyle = agent.pending ? "#ffb547" : "#7ce3b5";
    g.font = "700 36px Inter, sans-serif";
    g.fillText(agent.project.slice(0, 25), 22, 48, 468);
    g.font = "600 27px Inter, sans-serif";
    g.fillText(STATE_LABELS[agent.state], 22, 89, 468);
    g.fillStyle = "#e7effa";
    g.font = "26px Inter, sans-serif";
    const words = (agent.task || agent.title).split(/\s+/);
    let line = "";
    let y = 140;
    for (const word of words) {
      if (g.measureText(`${line} ${word}`).width > 468 && line) {
        g.fillText(line, 22, y, 468);
        y += 34;
        line = word;
        if (y > 242) break;
      } else line = `${line} ${word}`.trim();
    }
    if (y <= 242) g.fillText(line, 22, y, 468);
    panel.commit();
  }

  private celebrate(id: string): void {
    if (!this.enabled || reducedMotion() || this.bursts.length >= 6) return;
    const origin = this.agents.position(id);
    if (!origin) return;
    const count = 28;
    const positions = new Float32Array(count * 3);
    const velocity = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions.set([origin.x, origin.y + 1.6, origin.z], i * 3);
      const angle = i / count * Math.PI * 2;
      velocity.set([Math.cos(angle) * 1.5, 2 + Math.random(), Math.sin(angle) * 1.5], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x7ce3b5, size: 0.12, transparent: true, depthWrite: false }));
    this.root.add(points);
    this.bursts.push({ points, velocity, age: 0 });
  }

  tick(dt: number): void {
    for (const [id, warning] of this.warnings) {
      const position = this.agents.position(id);
      warning.visible = !!position;
      if (position) warning.position.copy(position).add(new THREE.Vector3(0, 2.6, 0));
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.age += dt;
      if (burst.age > 1.8 || reducedMotion()) {
        this.disposeBurst(burst);
        this.bursts.splice(i, 1);
        continue;
      }
      const attr = burst.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      const data = attr.array as Float32Array;
      for (let j = 0; j < data.length; j += 3) {
        burst.velocity[j + 1] -= 3 * dt;
        for (let k = 0; k < 3; k++) data[j + k] += burst.velocity[j + k] * dt;
      }
      attr.needsUpdate = true;
      (burst.points.material as THREE.PointsMaterial).opacity = 1 - burst.age / 1.8;
    }
  }

  private clearWarnings(): void {
    for (const label of this.warnings.values()) { label.element.remove(); label.removeFromParent(); }
    this.warnings.clear();
    for (const line of this.lines) { line.removeFromParent(); line.geometry.dispose(); (line.material as THREE.Material).dispose(); }
    this.lines.length = 0;
  }

  private disposeBurst(burst: Burst): void {
    burst.points.removeFromParent();
    burst.points.geometry.dispose();
    (burst.points.material as THREE.Material).dispose();
  }

  private clearBursts(): void {
    for (const burst of this.bursts) this.disposeBurst(burst);
    this.bursts.length = 0;
  }
}
