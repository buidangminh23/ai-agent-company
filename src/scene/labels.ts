import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";

export function htmlLabel(parent: THREE.Object3D, html: string, className: string, x: number, y: number, z: number, center?: [number, number]): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  const obj = new CSS2DObject(el);
  if (center) obj.center.set(center[0], center[1]);
  obj.position.set(x, y, z);
  parent.add(obj);
  return el;
}

export function canvasPlate(text: string, w: number, h: number, opts: { bg?: string; fg?: string; size?: number; sub?: string } = {}): THREE.Mesh {
  const scale = 256;
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const g = c.getContext("2d")!;
  g.fillStyle = opts.bg ?? "#14171c";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = opts.fg ?? "#eef3fa";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const size = (opts.size ?? 0.55) * c.height;
  g.font = `700 ${size}px Inter, Segoe UI, sans-serif`;
  g.fillText(text, c.width / 2, opts.sub ? c.height * 0.38 : c.height / 2, c.width * 0.92);
  if (opts.sub) {
    g.font = `600 ${size * 0.55}px Inter, Segoe UI, sans-serif`;
    g.fillStyle = "#c9d3df";
    g.fillText(opts.sub, c.width / 2, c.height * 0.74, c.width * 0.92);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  mesh.userData.keep = true;
  return mesh;
}

const MIN_DISPLAY_WIDTH = 256;
const SUPERSAMPLE = 3;
const DISPLAY_SAMPLE_SCALE = 2;
const MAX_BACKING_WIDTH = 6144;
const MAX_BACKING_PIXELS = 8_000_000;
const RESIZE_TOLERANCE = 0.12;
const panelByMaterial = new WeakMap<THREE.Material, CanvasPanel>();

function displayTexture(source: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

function downscale(source: HTMLCanvasElement, target: HTMLCanvasElement): void {
  let current: HTMLCanvasElement = source;
  while (current.width / 2 >= target.width) {
    const half = document.createElement("canvas");
    half.width = Math.round(current.width / 2);
    half.height = Math.round(current.height / 2);
    const g = half.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }
  const g = target.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.clearRect(0, 0, target.width, target.height);
  g.drawImage(current, 0, 0, target.width, target.height);
}

export class CanvasPanel {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly material: THREE.MeshBasicMaterial;
  readonly width: number;
  readonly height: number;
  private readonly display = document.createElement("canvas");
  private texture: THREE.CanvasTexture;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const scale = Math.min(SUPERSAMPLE, MAX_BACKING_WIDTH / width, Math.sqrt(MAX_BACKING_PIXELS / (width * height)));
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.scale(this.canvas.width / width, this.canvas.height / height);
    this.display.width = this.canvas.width;
    this.display.height = this.canvas.height;
    this.texture = displayTexture(this.display);
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    panelByMaterial.set(this.material, this);
  }

  static of(material: THREE.Material | THREE.Material[]): CanvasPanel | undefined {
    return Array.isArray(material) ? undefined : panelByMaterial.get(material);
  }

  fitTo(screenPixels: number): void {
    if (!Number.isFinite(screenPixels) || screenPixels <= 0) return;
    const width = Math.round(Math.min(this.canvas.width, Math.max(MIN_DISPLAY_WIDTH, screenPixels * DISPLAY_SAMPLE_SCALE)));
    if (Math.abs(width - this.display.width) / this.display.width < RESIZE_TOLERANCE) return;
    this.display.width = width;
    this.display.height = Math.round((width * this.canvas.height) / this.canvas.width);
    const previous = this.texture;
    this.texture = displayTexture(this.display);
    this.material.map = this.texture;
    this.material.needsUpdate = true;
    previous.dispose();
    this.commit();
  }

  commit(): void {
    if (this.display.width === this.canvas.width) {
      const g = this.display.getContext("2d")!;
      g.clearRect(0, 0, this.display.width, this.display.height);
      g.drawImage(this.canvas, 0, 0);
    } else {
      downscale(this.canvas, this.display);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
  }
}
