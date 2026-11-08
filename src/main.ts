import { L, getLang, locale, storeLang } from "../shared/i18n.ts";
import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { CSS3DObject, CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import type { Snapshot } from "../shared/types.ts";
import { ROLE_BY_ID } from "../shared/roles.ts";
import { buildOffice } from "./scene/build.ts";
import { SX, ZONE_BY_ID, configureLayout, type ZoneId } from "./scene/layout.ts";
import { AgentManager, STATE_LABELS, escapeHtml } from "./agents.ts";
import { drawAll, drawMeeting } from "./panels.ts";
import { TV_WIDTH, YouTubeTv } from "./youtube-tv.ts";
import { APP_COLORS, APP_NAMES } from "./scene/mascots.ts";
import { renderMarkdown } from "./markdown.ts";
import { OPS_PREFIX, buildCrew, crewKind } from "./crew.ts";
import { resolveRoles, roleLabel } from "./roles-view.ts";
import { CanvasPanel } from "./scene/labels.ts";
import { tickAmbient } from "./scene/ambient.ts";
import { tickBilliards } from "./scene/lounge.ts";
import { easeInOut, easeOut, reducedMotion } from "./motion.ts";
import { OperationsDashboard, icon, safeLink } from "./dashboard.ts";
import { OfficeHud } from "./hud.ts";
import { OperationsScene } from "./scene/operations.ts";
import { Courier } from "./courier.ts";
import { MeetingDirector } from "./meeting.ts";
import { CommunicationScene } from "./scene/communication.ts";
import { pressOptionKey } from "./replies.ts";
import { pressGuard } from "./press-guard.ts";

document.documentElement.lang = getLang();
document.getElementById("office-title")!.textContent = L("Văn phòng AI Agent Company");
document.getElementById("live")!.textContent = L("Đang nối hub…");
document.getElementById("home")!.setAttribute("aria-label", L("Về góc nhìn gốc"));
document.getElementById("home")!.title = L("Về toàn cảnh");
document.getElementById("agent-card")!.setAttribute("aria-label", L("Theo dõi agent"));
const langToggle = document.getElementById("lang-toggle") as HTMLButtonElement;
langToggle.textContent = getLang() === "en" ? "VI" : "EN";
langToggle.title = L("Đổi ngôn ngữ");
langToggle.setAttribute("aria-label", L("Đổi ngôn ngữ"));
langToggle.addEventListener("click", () => {
  storeLang(getLang() === "en" ? "vi" : "en");
  location.reload();
});

const FIT_HALF_W = 32.5;
const FIT_HALF_H = 23.6;
const CAMERA_HOME = new THREE.Vector3(0, 62, 52);
const TARGET_HOME = new THREE.Vector3(0, 0, -2.2);
const HOME_FLIGHT_MS = 650;
const INTRO_MS = 1400;
const INTRO_ZOOM = 1.22;
const CARD_EXIT_MS = 140;
const CARD_SWAP_MS = 180;
const UI_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

const stage = document.getElementById("stage")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);
const tvLayer = new CSS3DRenderer();
tvLayer.domElement.className = "tv-layer";
stage.appendChild(tvLayer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.className = "labels";
stage.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e15);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
camera.position.copy(CAMERA_HOME);
camera.lookAt(TARGET_HOME);

const controls = new MapControls(camera, renderer.domElement);
controls.target.copy(TARGET_HOME);
controls.enableRotate = false;
controls.screenSpacePanning = false;
controls.minZoom = 1;
controls.maxZoom = 12;
controls.zoomToCursor = true;
controls.update();

scene.add(new THREE.HemisphereLight(0xfff1dc, 0x1b2433, 1.15));
const key = new THREE.DirectionalLight(0xffe3bd, 2.1);
key.position.set(-22, 60, 34);
key.castShadow = true;
key.shadow.mapSize.set(4096, 4096);
key.shadow.bias = -0.0004;
Object.assign(key.shadow.camera, { left: -40, right: 40, top: 34, bottom: -34, near: 1, far: 160 });
scene.add(key);
const fill = new THREE.DirectionalLight(0x9cc2ff, 0.45);
fill.position.set(30, 30, -20);
scene.add(fill);

const EDGE_MARGIN = 1.2;
const REBUILD_THRESHOLD = 0.03;

const FALLBACK_WIDTH = 1600;
const FALLBACK_HEIGHT = 900;
const HUD_CLEARANCE_PX = 12;
const ROOM_FILL = 0.8;
const GROUND_FORESHORTEN = Math.sin(Math.atan2(CAMERA_HOME.y - TARGET_HOME.y, CAMERA_HOME.z - TARGET_HOME.z));

interface ViewFit {
  fitHalfW: number;
  fitHalfH: number;
  halfW: number;
  halfH: number;
  shiftX: number;
  shiftY: number;
}

function viewFit(): ViewFit {
  const width = innerWidth > 0 ? innerWidth : FALLBACK_WIDTH;
  const height = innerHeight > 0 ? innerHeight : FALLBACK_HEIGHT;
  const inset = hud.insets();
  const left = inset.left ? Math.min(inset.left + HUD_CLEARANCE_PX, width / 2) : 0;
  const top = inset.top ? Math.min(inset.top + HUD_CLEARANCE_PX, height / 2) : 0;
  const freeW = width - left;
  const freeH = height - top;
  const aspect = freeW / freeH;
  const fitHalfH = Math.max(FIT_HALF_H, FIT_HALF_W / aspect);
  const unitsPerPx = (2 * fitHalfH) / freeH;
  return { fitHalfW: fitHalfH * aspect, fitHalfH, halfW: (width * unitsPerPx) / 2, halfH: (height * unitsPerPx) / 2, shiftX: left / 2, shiftY: top / 2 };
}

function disposeOffice(root: THREE.Group): void {
  root.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
  scene.remove(root);
}

function makeOffice(): ReturnType<typeof buildOffice> {
  configureLayout(viewFit().fitHalfW - EDGE_MARGIN);
  const built = buildOffice(scene);
  key.shadow.camera.left = -40 * SX;
  key.shadow.camera.right = 40 * SX;
  key.shadow.camera.updateProjectionMatrix();
  return built;
}

const hud = new OfficeHud({
  open: (tab) => dashboard.open(tab),
  office: () => {
    dashboard.close();
    select(null);
    flyHome(1, HOME_FLIGHT_MS, easeInOut);
  },
  room: (zone) => {
    dashboard.close();
    select(null);
    flyToRoom(zone);
  },
});
let office = makeOffice();
const tv = new YouTubeTv(() => flyToScreen());
const tvObject = new CSS3DObject(tv.element);
const tvScene = new THREE.Scene();
tvScene.add(tvObject);

function placeTv(): void {
  const led = office.screens.find((mesh) => mesh.userData.panel === "led");
  const width = (led?.geometry as THREE.PlaneGeometry | undefined)?.parameters?.width;
  const height = (led?.geometry as THREE.PlaneGeometry | undefined)?.parameters?.height;
  if (!led || !width || !height) return;
  led.updateWorldMatrix(true, false);
  led.matrixWorld.decompose(tvObject.position, tvObject.quaternion, tvObject.scale);
  tvObject.scale.multiplyScalar(width / TV_WIDTH);
  tv.setHeight((TV_WIDTH * height) / width);
}
placeTv();
let panels = office.panels;

const card = document.getElementById("agent-card")!;
let selected: string | null = null;
let preview: string | null = null;
let previewTimer = 0;
let closeTimer = 0;
let hoverAgent: string | null = null;
let cardSignature = "";
const agents = new AgentManager(scene, (id) => select(id), previewAgent);
if (import.meta.env.DEV) Object.assign(window, { __agents: agents, __select: (id: string | null) => select(id), __apply: (snap: Snapshot) => applySnapshot(snap) });

function select(id: string | null): void {
  clearTimeout(previewTimer);
  clearTimeout(closeTimer);
  preview = null;
  hoverAgent = null;
  selected = id;
  agents.focus(id);
  const position = id ? agents.position(id) : null;
  if (position) flyTo(position, 4.2, HOME_FLIGHT_MS, easeInOut);
  renderCard();
}

function previewAgent(id: string | null): void {
  if (id && id === hoverAgent) return;
  hoverAgent = id;
  clearTimeout(previewTimer);
  clearTimeout(closeTimer);
  if (selected) return;
  agents.focus(id);
  if (id) {
    previewTimer = window.setTimeout(() => {
      preview = id;
      renderCard();
    }, 2000);
  } else {
    closeTimer = window.setTimeout(() => {
      preview = null;
      renderCard();
    }, 350);
  }
}

const cardHeldByPress = pressGuard(card, window, () => renderCard());
card.addEventListener("pointerenter", () => clearTimeout(closeTimer));
card.addEventListener("pointerleave", () => previewAgent(null));
card.addEventListener("focusin", () => clearTimeout(closeTimer));
card.addEventListener("focusout", (event) => {
  if (!card.contains(event.relatedTarget as Node | null)) previewAgent(null);
});
card.addEventListener("input", (event) => dashboard.answerInput(event.target as HTMLInputElement));
card.addEventListener("keydown", (event) => { pressOptionKey(event); });
card.addEventListener("click", (event) => {
  if (dashboard.answerClick(event.target as Element)) return;
  const action = (event.target as Element).closest<HTMLButtonElement>("button[data-action]")?.dataset.action;
  if (action === "close") select(null);
  if (action === "pin") select(preview);
  if (action === "ops" && cardAgentId) dashboard.showAgent(cardAgentId);
  if (action === "home") {
    select(null);
    flyHome(1, HOME_FLIGHT_MS, easeInOut);
  }
});
addEventListener("keydown", (event) => {
  if (event.key === "Escape") select(null);
});

let cardExit: Animation | null = null;
let cardAgentId: string | null = null;

function showCard(id: string): void {
  cardExit?.cancel();
  cardExit = null;
  const wasHidden = card.hidden;
  if (id !== cardAgentId && lastSnap?.agents.some((agent) => agent.id === id && agent.pending)) dashboard.refreshAnswers();
  card.hidden = false;
  if (!wasHidden && cardAgentId && cardAgentId !== id && !reducedMotion()) {
    card.animate([{ opacity: 0.35, filter: "blur(2px)" }, { opacity: 1, filter: "blur(0)" }], { duration: CARD_SWAP_MS, easing: UI_EASE });
  }
  cardAgentId = id;
}

function hideCard(): void {
  cardAgentId = null;
  if (card.hidden || cardExit) return;
  if (reducedMotion()) {
    card.hidden = true;
    return;
  }
  cardExit = card.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(6px) scale(0.98)" }], { duration: CARD_EXIT_MS, easing: UI_EASE });
  cardExit.onfinish = () => {
    cardExit = null;
    card.hidden = true;
  };
}

const ANSWER_REFRESH_MS = 10_000;
setInterval(() => {
  if (document.visibilityState === "hidden" || replayMode || !cardAgentId) return;
  if (lastSnap?.agents.some((agent) => agent.id === cardAgentId && agent.pending)) dashboard.refreshAnswers();
}, ANSWER_REFRESH_MS);

function copyMachinePanel(index: number): void {
  const view = card.querySelector<HTMLCanvasElement>(".card-machine canvas");
  const source = index >= 0 ? panels.machines[index]?.canvas : undefined;
  if (!view || !source) return;
  view.width = source.width;
  view.height = source.height;
  view.getContext("2d")?.drawImage(source, 0, 0);
}

function renderCard(): void {
  if (cardHeldByPress()) return;
  const id = selected ?? preview;
  const info = id ? [...(lastSnap?.agents ?? []), ...crewAgents].find((agent) => agent.id === id) : undefined;
  if (!info) {
    hideCard();
    selected = null;
    preview = null;
    cardSignature = "";
    return;
  }
  showCard(info.id);
  const kind = crewKind(info.id);
  const machineIndex = kind === "ops" && info.id === `${OPS_PREFIX}${info.machine}` ? lastSnap!.machines.findIndex((machine) => machine.id === info.machine) : -1;
  card.classList.toggle("machine-only", machineIndex >= 0);
  const role = kind === "ops" ? L("Vận hành") : kind === "life" ? L("Văn phòng") : kind === "staff" && info.role ? ROLE_BY_ID.get(info.role)?.label ?? roleLabel(info) : roleLabel(info);
  const children = lastSnap!.agents.filter((agent) => agent.parentId === info.id);
  const parent = lastSnap!.agents.find((agent) => agent.id === info.parentId);
  const machineOnline = lastSnap!.machines.find((machine) => machine.id === info.machine)?.online ?? false;
  const connected = !replayMode && document.getElementById("live")!.dataset.state === "on" && machineOnline;
  const signature = JSON.stringify([info, children.map((agent) => agent.id), parent?.title, selected, connected, kind ? "" : dashboard.answerSignature(info)]);
  if (signature === cardSignature) {
    if (machineIndex >= 0) copyMachinePanel(machineIndex);
    return;
  }
  cardSignature = signature;
  if (machineIndex >= 0) {
    card.setAttribute("aria-label", L("Tình trạng {0}. Nhấn Escape để đóng.", info.machine));
    card.dataset.state = connected ? "online" : "offline";
    card.innerHTML = L("<div class=\"card-machine\"><canvas role=\"img\" aria-label=\"{0}: {1}\"></canvas></div><button type=\"button\" class=\"machine-dismiss sr-only\" data-action=\"close\">Đóng tình trạng máy</button>", escapeHtml(info.machine), escapeHtml(info.detail));
    copyMachinePanel(machineIndex);
    return;
  }
  card.setAttribute("aria-label", L("Theo dõi {0} · {1}", APP_NAMES[info.app], info.project));
  const deciding = connected && info.pending?.kind === "decision" && info.state === "idle";
  const pillState = !connected ? "offline" : deciding ? "decision" : info.state;
  const pillText = replayMode ? L("Đang xem lịch sử") : !connected ? L("Mất kết nối") : deciding ? L("Chờ sếp quyết") : STATE_LABELS[info.state];
  card.dataset.state = pillState;
  const heading = kind === "staff" ? L("Nhân viên trực") : kind === "ops" ? L("Vận hành máy chủ") : kind === "life" ? L("Nhân viên văn phòng") : L("Theo dõi {0}", APP_NAMES[info.app]);
  const facts = [
    L("<div><dt>{0}Nhiệm vụ</dt><dd class=\"card-task\" title=\"{1}\">{2}</dd></div>", icon("target"), escapeHtml(info.task || info.title), escapeHtml(info.task || info.title)),
    L("<div><dt>{0}Máy</dt><dd>{1}</dd></div>", icon("machine"), escapeHtml(info.machine)),
    info.branch ? L("<div><dt>{0}Nhánh</dt><dd><code>{1}</code></dd></div>", icon("board"), escapeHtml(info.branch)) : "",
    children.length ? L("<div><dt>{0}Subagent</dt><dd>{1} đang chạy</dd></div>", icon("agent"), children.length) : "",
  ].join("");
  const chat = kind ? null : safeLink(info.nativeUrl);
  const actions = kind ? "" : L("<section class=\"card-actions\" aria-label=\"Hành động nhanh\"><span class=\"eyebrow\">Hành động nhanh</span><div><button type=\"button\" class=\"primary\" data-action=\"ops\">{0}Xem trong bảng điều hành</button>{1}<button type=\"button\" data-action=\"home\">{2}Về toàn cảnh</button></div></section>", icon("grid"), chat ? L("<a href=\"{0}\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"Mở ứng dụng trên thiết bị đang xem; chat cần có trên thiết bị đó.\">{1}Mở chat gốc</a>", escapeHtml(chat), icon("chat")) : "", icon("home"));
  const report = info.progress || info.detail || L("Chưa có hoạt động");
  const tool = info.state !== "idle" && info.progress && info.detail && info.detail !== info.progress ? `<p class="card-tool">${escapeHtml(info.detail)}</p>` : "";
  const focused = card.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusedAction = focused?.dataset.action;
  const focusedKey = focused?.dataset.key;
  const scroll = card.scrollTop;
  const reportSection = `<section class="card-section card-report"><span class="eyebrow">${info.state === "idle" ? L("Báo cáo mới nhất") : L("Tiến độ hiện tại")}</span><div class="md">${renderMarkdown(report)}</div>${tool}</section>`;
  card.innerHTML = L("<header class=\"card-head\"><b>{0}{1}</b><button class=\"x\" data-action=\"close\" aria-label=\"Đóng popup\">×</button></header>\n<div class=\"card-profile\"><span class=\"card-avatar\" style=\"--app:{2}\" aria-hidden=\"true\">{3}</span><div class=\"card-who\"><strong>{4}</strong><small>{5} · {6}{7}</small></div><span class=\"pill\" data-state=\"{8}\">{9}</span></div>\n{10}\n<dl class=\"card-facts\">{11}</dl>\n{12}\n{13}\n{14}\n{15}\n<footer><time datetime=\"{16}\">Cập nhật {17}</time>{18}{19}</footer>", heading, info.parentId ? " · subagent" : "", APP_COLORS[info.app], escapeHtml(APP_NAMES[info.app].slice(0, 1)), escapeHtml(info.project), escapeHtml(role), APP_NAMES[info.app], info.model ? ` · ${escapeHtml(info.model)}` : "", pillState, pillText, kind ? "" : dashboard.answerMarkup(info, connected), facts, info.recap ? L("<section class=\"card-section card-recap\"><span class=\"eyebrow\">Tóm tắt lượt vừa xong</span><p>{0}</p></section>", escapeHtml(info.recap)) : "", reportSection, info.parentId ? `<p class="card-parent">Agent cha: ${escapeHtml(parent?.title || L("Không có trong phiên theo dõi"))}</p>` : "", actions, escapeHtml(info.updatedAt), new Date(info.updatedAt).toLocaleString(locale()), !connected ? L("<span class=stale>Dữ liệu lần nhận cuối</span>") : "", selected ? L("<span>Đã giữ popup · Esc để đóng</span>") : L("<button data-action=\"pin\">Giữ popup mở</button>"));
  copyMachinePanel(machineIndex);
  card.scrollTop = scroll;
  if (focusedAction) card.querySelector<HTMLButtonElement>(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  if (focusedKey) [...card.querySelectorAll<HTMLElement>("[data-key]")].find((element) => element.dataset.key === focusedKey)?.focus({ preventScroll: true });
}

const live = document.getElementById("live")!;
let lastSnap: Snapshot | null = null;
let liveSnap: Snapshot | null = null;
let replayMode = false;
let crewAgents: Snapshot["agents"] = [];
let lastReceivedAt = 0;
const STREAM_STALE_MS = 30000;
let stream: EventSource | null = null;
let reconnectTimer = 0;
let refreshing = false;
let pageLoaded = document.readyState === "complete";
let communicationEnabled = true;
const sceneOps = new OperationsScene(scene, agents, () => dashboard.open("overview"));
const communicationScene = new CommunicationScene(scene, agents);
const dashboard = new OperationsDashboard({
  state: (open, tab) => hud.setState(open, tab),
  selectAgent: (id) => select(id),
  effects: (enabled) => {
    communicationEnabled = enabled;
    sceneOps.setEffects(enabled);
    communicationScene.setEnabled(enabled);
    if (lastSnap) placeCrew(lastSnap);
  },
  operations: (data) => {
    hud.updateOperations(data);
    if (!replayMode) sceneOps.applyOperations(data);
  },
  todos: (list) => hud.updateTodos(list),
  github: (count) => hud.updateGitHub(count),
  inbox: (data) => hud.updateInbox(data),
  replay: (snapshot) => {
    const entering = !!snapshot;
    if (entering !== replayMode || snapshot && lastSnap && Date.parse(snapshot.generatedAt) < Date.parse(lastSnap.generatedAt)) {
      agents.reset();
      sceneOps.reset();
      courier.reset(agents);
      communicationScene.reset();
      select(null);
    }
    replayMode = entering;
    const current = snapshot ?? liveSnap;
    if (current) renderSnapshot(current);
  },
});

const courier = new Courier();
const meeting = new MeetingDirector();

function placeCrew(snap: Snapshot): void {
  const observedAt = replayMode ? Date.parse(snap.generatedAt) : Date.now();
  const people = resolveRoles(snap.agents);
  const crew = buildCrew({ ...snap, agents: people }, observedAt, agents.realSeats());
  crewAgents = crew.agents;
  const communicate = communicationEnabled && !replayMode && live.dataset.state === "on" && Date.now() - lastReceivedAt < STREAM_STALE_MS;
  courier.observe(snap.messages ?? [], observedAt, communicate);
  if (!replayMode) meeting.observe(people, observedAt);
  const meetingPins = replayMode ? new Map() : meeting.pins([...people, ...crew.agents]);
  if (!communicate) courier.reset(agents);
  const courierPins = communicate ? courier.pins(agents, observedAt, new Set(meetingPins.keys()), new Set(snap.machines.filter((machine) => !machine.online).map((machine) => machine.id))) : new Map();
  const pins = new Map([...crew.pins, ...courierPins]);
  if (office.ceo.state === "briefing") {
    pins.set("life:ceo:assistant", { key: "ceo:briefing", x: 3.6, z: -18.2, facing: -Math.PI / 2, pose: "stand", approach: { x: 3.6, z: -16.4 }, task: "present" });
  }
  for (const [id, pin] of meetingPins) pins.set(id, pin);
  agents.update([...people, ...crew.agents], pins, observedAt);
}

const CREW_TICK_MS = 1000;
setInterval(() => {
  if (!lastSnap || replayMode || document.visibilityState === "hidden") return;
  placeCrew(lastSnap);
  if (selected || preview) renderCard();
}, CREW_TICK_MS);

function applySnapshot(snap: Snapshot): void {
  if (liveSnap && Date.parse(snap.generatedAt) < Date.parse(liveSnap.generatedAt)) return;
  lastReceivedAt = Date.now();
  live.dataset.state = "on";
  liveSnap = snap;
  dashboard.setConnected(true);
  dashboard.update(snap);
  if (!replayMode) renderSnapshot(snap);
}

function disconnectCommunications(): void {
  communicationScene.setConnected(false);
  courier.reset(agents);
  if (lastSnap && !replayMode) placeCrew(lastSnap);
}

function renderSnapshot(snap: Snapshot): void {
  lastSnap = snap;
  placeCrew(snap);
  sceneOps.update(snap, replayMode);
  communicationScene.update(snap, replayMode);
  hud.update(snap);
  drawAll(panels, snap);
  if (!replayMode) drawMeeting(panels.meeting, snap, meeting.board());
  document.body.dataset.booted = "1";
  if (selected || preview) renderCard();
}

function connect(attempt = 0): void {
  if (!pageLoaded) return;
  clearTimeout(reconnectTimer);
  stream?.close();
  const es = new EventSource("/api/stream");
  stream = es;
  es.onopen = () => {
    if (stream !== es) return;
    attempt = 0;
    dashboard.inboxChanged();
  };
  es.onmessage = (ev) => {
    if (stream === es) applySnapshot(JSON.parse(ev.data) as Snapshot);
  };
  es.addEventListener("inbox", () => {
    if (stream === es) dashboard.inboxChanged();
  });
  es.addEventListener("todos", () => {
    if (stream === es) dashboard.todosChanged();
  });
  es.addEventListener("github", () => {
    if (stream === es) dashboard.githubChanged();
  });
  es.addEventListener("ping", () => {
    if (stream !== es) return;
    lastReceivedAt = Date.now();
    live.dataset.state = "on";
  });
  es.onerror = () => {
    if (stream !== es) return;
    live.dataset.state = "off";
    dashboard.setConnected(false);
    disconnectCommunications();
    renderCard();
    es.close();
    const delay = Math.min(15000, 1000 * 2 ** attempt) + Math.random() * 500;
    reconnectTimer = window.setTimeout(() => connect(attempt + 1), delay);
  };
}

async function refreshSnapshot(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Snapshot ${response.status}`);
    applySnapshot(await response.json() as Snapshot);
  } catch {
    live.dataset.state = "off";
    dashboard.setConnected(false);
    disconnectCommunications();
    renderCard();
  } finally {
    refreshing = false;
  }
}

function resumeUpdates(): void {
  if (document.visibilityState === "hidden") return;
  void refreshSnapshot();
  connect();
}

document.addEventListener("visibilitychange", resumeUpdates);
addEventListener("online", resumeUpdates);
addEventListener("focus", () => { void refreshSnapshot(); });
setInterval(() => {
  if (document.visibilityState === "hidden" || Date.now() - lastReceivedAt < STREAM_STALE_MS) return;
  live.dataset.state = "off";
  dashboard.setConnected(false);
  disconnectCommunications();
  renderCard();
  void refreshSnapshot();
  connect();
}, 5000);
void refreshSnapshot();
if (pageLoaded) connect();
else addEventListener("load", () => {
  window.setTimeout(() => {
    pageLoaded = true;
    connect();
  }, 0);
}, { once: true });

setInterval(() => {
  if (!lastSnap) return;
  if (replayMode) {
    live.textContent = L("Lịch sử · {0}", new Date(lastSnap.generatedAt).toLocaleString(locale()));
    return;
  }
  const age = Math.round((Date.now() - Date.parse(lastSnap.generatedAt)) / 1000);
  live.textContent = live.dataset.state === "on" ? L("Realtime · {0} agent · cập nhật {1}s trước", lastSnap.agents.length, age) : L("Mất kết nối hub, đang nối lại…");
}, 1000);

const HOVER_DWELL_MS = 2000;
const POP_GAP = 18;
const machinePop = document.getElementById("machine-pop")!;
let hoverIndex: number | null = null;
let hoverTimer = 0;
let lastPointer = { x: 0, y: 0 };

function placePop(): void {
  const rect = machinePop.getBoundingClientRect();
  const x = Math.min(lastPointer.x + POP_GAP, innerWidth - rect.width - 12);
  const y = Math.min(Math.max(12, lastPointer.y - rect.height / 2), innerHeight - rect.height - 12);
  machinePop.style.left = `${Math.max(12, x)}px`;
  machinePop.style.top = `${y}px`;
}

function showPop(index: number): void {
  machinePop.replaceChildren(panels.machines[index].canvas);
  machinePop.hidden = false;
  placePop();
}

function setHover(index: number | null): void {
  if (index === hoverIndex) return;
  hoverIndex = index;
  clearTimeout(hoverTimer);
  machinePop.hidden = true;
  if (index !== null) hoverTimer = window.setTimeout(() => showPop(index), HOVER_DWELL_MS);
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = { x: 0, y: 0 };
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener("pointermove", (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (e.buttons) { previewAgent(null); return setHover(null); }
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const agentHit = raycaster.intersectObjects(agents.pickables(), true)[0];
  previewAgent(agentHit ? agents.idOf(agentHit.object) : null);
  const hit = raycaster.intersectObjects(office.hoverTargets, false)[0];
  setHover(!agentHit && hit ? (hit.object.userData.hoverMachine as number) : null);
  if (!machinePop.hidden) placePop();
});
renderer.domElement.addEventListener("pointerleave", () => { setHover(null); previewAgent(null); });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(agents.pickables(), true)[0];
  if (hit) select(agents.idOf(hit.object));
  else {
    const screen = raycaster.intersectObjects(office.screens, false)[0]?.object.userData.panel;
    if (screen === "meeting") dashboard.open("projects");
    else select(null);
  }
});

interface CameraFlight {
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  fromZoom: number;
  toPos: THREE.Vector3;
  toTarget: THREE.Vector3;
  zoom: number;
  start: number;
  duration: number;
  ease: (t: number) => number;
}

let flight: CameraFlight | null = null;

function flyToRoom(id: ZoneId): void {
  const zone = ZONE_BY_ID.get(id);
  if (!zone) return;
  const fit = viewFit();
  const across = (2 * fit.fitHalfW) / (zone.x1 - zone.x0);
  const deep = (2 * fit.fitHalfH) / ((zone.z1 - zone.z0) * GROUND_FORESHORTEN);
  const zoom = THREE.MathUtils.clamp(Math.min(across, deep) * ROOM_FILL, controls.minZoom, controls.maxZoom);
  flyTo(new THREE.Vector3((zone.x0 + zone.x1) / 2, 0, (zone.z0 + zone.z1) / 2), zoom, HOME_FLIGHT_MS, easeInOut);
}

const SCREEN_FILL = 0.94;

function flyToScreen(): void {
  const led = office.screens.find((mesh) => mesh.userData.panel === "led");
  const geometry = led?.geometry as THREE.PlaneGeometry | undefined;
  if (!led || !geometry?.parameters) return;
  led.updateWorldMatrix(true, false);
  const { width, height } = geometry.parameters;
  const center = new THREE.Vector3().setFromMatrixPosition(led.matrixWorld);
  const top = new THREE.Vector3(0, height / 2, 0).applyMatrix4(led.matrixWorld);
  const bottom = new THREE.Vector3(0, -height / 2, 0).applyMatrix4(led.matrixWorld);
  const view = TARGET_HOME.clone().sub(CAMERA_HOME).normalize();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const shown = Math.abs(top.sub(bottom).dot(up));
  const fit = viewFit();
  const zoom = THREE.MathUtils.clamp(Math.min((2 * fit.fitHalfW) / (width * led.getWorldScale(new THREE.Vector3()).x), (2 * fit.fitHalfH) / shown) * SCREEN_FILL, controls.minZoom, controls.maxZoom);
  flyTo(center.addScaledVector(view, -center.y / view.y), zoom, HOME_FLIGHT_MS, easeInOut);
}

function flyHome(zoom: number, duration: number, ease: (t: number) => number): void {
  flyTo(TARGET_HOME, zoom, duration, ease);
}

function flyTo(target: THREE.Vector3, zoom: number, duration: number, ease: (t: number) => number): void {
  const toTarget = target.clone();
  const toPos = CAMERA_HOME.clone().sub(TARGET_HOME).add(toTarget);
  if (reducedMotion()) {
    camera.position.copy(toPos);
    controls.target.copy(toTarget);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    flight = null;
    return;
  }
  flight = { fromPos: camera.position.clone(), fromTarget: controls.target.clone(), fromZoom: camera.zoom, toPos, toTarget, zoom, start: performance.now(), duration, ease };
}

function stepFlight(now: number): void {
  if (!flight) return;
  const k = flight.ease(Math.min(1, (now - flight.start) / flight.duration));
  camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
  controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
  camera.zoom = flight.fromZoom + (flight.zoom - flight.fromZoom) * k;
  camera.updateProjectionMatrix();
  if (k >= 1) flight = null;
}

renderer.domElement.addEventListener("pointerdown", () => (flight = null));
renderer.domElement.addEventListener("wheel", () => (flight = null), { passive: true });
document.getElementById("home")!.addEventListener("click", () => flyHome(1, HOME_FLIGHT_MS, easeInOut));
if (!reducedMotion()) {
  camera.zoom = INTRO_ZOOM;
  camera.updateProjectionMatrix();
  flyHome(1, INTRO_MS, easeOut);
}

let rebuildTimer = 0;

function rebuildIfNeeded(): void {
  const wanted = Math.max(1, (viewFit().fitHalfW - EDGE_MARGIN) / 30);
  if (Math.abs(wanted - SX) < REBUILD_THRESHOLD) return;
  setHover(null);
  office.ceo.dispose();
  office.coffee.dispose();
  office.amenities.dispose();
  disposeOffice(office.root);
  office = makeOffice();
  placeTv();
  screenFitKey = "";
  panels = office.panels;
  agents.reset();
  sceneOps.reset();
  if (lastSnap) renderSnapshot(lastSnap);
}

function resize(): void {
  const w = innerWidth;
  const h = innerHeight;
  const { halfW, halfH, shiftX, shiftY } = viewFit();
  Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
  camera.setViewOffset(w, h, -shiftX, -shiftY, w, h);
  renderer.setSize(w, h);
  tvLayer.setSize(w, h);
  labels.setSize(w, h);
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(rebuildIfNeeded, 250);
}
addEventListener("resize", resize);
hud.watchLayout(resize);
resize();

let screenFitKey = "";
const screenScale = new THREE.Vector3();

function fitScreens(): void {
  const pxPerUnit = (renderer.domElement.height * camera.zoom) / (camera.top - camera.bottom);
  const key = `${pxPerUnit.toFixed(2)}:${office.screens.length}`;
  if (key === screenFitKey) return;
  screenFitKey = key;
  for (const mesh of office.screens) {
    const panel = CanvasPanel.of(mesh.material);
    const width = (mesh.geometry as THREE.PlaneGeometry).parameters?.width;
    if (!panel || !width) continue;
    mesh.getWorldScale(screenScale);
    panel.fitTo(width * screenScale.x * pxPerUnit);
  }
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  agents.tick(dt, clock.elapsedTime);
  tickBilliards(clock.elapsedTime, dt);
  office.coffee.tick(clock.elapsedTime, agents.coffeeGuests());
  office.amenities.tick(clock.elapsedTime, dt);
  sceneOps.tick(dt);
  communicationScene.setConnected(live.dataset.state === "on" && Date.now() - lastReceivedAt < STREAM_STALE_MS);
  communicationScene.tick(dt);
  tickAmbient(clock.elapsedTime);
  office.ceo.tick(dt, clock.elapsedTime);
  if (!replayMode && meeting.frame(office.ceo, agents, Date.now())) {
    if (lastSnap) {
      placeCrew(lastSnap);
      drawMeeting(panels.meeting, lastSnap, meeting.board());
    }
  }
  stepFlight(performance.now());
  controls.update();
  fitScreens();
  renderer.render(scene, camera);
  tvLayer.render(tvScene, camera);
  labels.render(scene, camera);
  agents.layoutLabels(innerWidth, innerHeight, dt, [office.ceo.speechBubble]);
});
