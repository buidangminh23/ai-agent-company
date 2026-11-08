import type { RoleId } from "./types.ts";

export interface RoleDef {
  id: RoleId;
  label: string;
  row: "office" | "tech";
  keywords: string[];
  files: string[];
}

export const ROLES: RoleDef[] = [
  { id: "po", label: "PO/PM", row: "office", keywords: ["roadmap", "kế hoạch", "plan", "sprint", "backlog", "ưu tiên", "milestone", "prd", "jira"], files: [] },
  { id: "ba", label: "BA", row: "office", keywords: ["nghiệp vụ", "usecase", "use case", "user story", "srs", "brd", "urd", "yêu cầu", "requirement", "bpmn", "đặc tả"], files: [] },
  { id: "marketing", label: "Marketing", row: "office", keywords: ["marketing", "quảng cáo", "ads", "campaign", "seo", "chiến dịch", "landing", "facebook ads"], files: [] },
  { id: "content", label: "Content", row: "office", keywords: ["content", "bài viết", "viết bài", "caption", "kịch bản", "script video", "thuyết minh", "blog", "copy", "video", "capcut"], files: [".mdx"] },
  { id: "cskh", label: "CSKH", row: "office", keywords: ["khách hàng", "cskh", "support", "hỗ trợ", "phản hồi khách", "ticket", "issue", "reply"], files: [] },
  { id: "hr", label: "HR", row: "office", keywords: ["nhân sự", "chấm công", "tuyển", "lương", "hr", "nhân viên"], files: [] },
  { id: "admin", label: "Hành chính", row: "office", keywords: ["hành chính", "văn bản", "công văn", "hồ sơ", "biểu mẫu", "excel", "word", "pdf", "hoá đơn", "hóa đơn", "đổi tên", "bài tập", "assignment"], files: [".docx", ".xlsx", ".xlsm", ".pdf", ".pptx"] },
  { id: "sales", label: "Sales", row: "office", keywords: ["bán hàng", "báo giá", "sales", "đơn hàng", "thanh toán", "checkout", "gói", "giá"], files: [] },
  { id: "backend", label: "Backend", row: "tech", keywords: ["backend", "api", "endpoint", "server", "database", "prisma", "sql", "fastapi", "migration", "route", "supabase", "bot"], files: [".py", ".sql", ".prisma", ".go", ".rs"] },
  { id: "frontend", label: "Frontend", row: "tech", keywords: ["frontend", "react", "component", "trang", "page", "astro", "next", "vue", "tailwind"], files: [".tsx", ".jsx", ".vue", ".astro", ".svelte"] },
  { id: "uiux", label: "UI/UX", row: "tech", keywords: ["giao diện", "ui", "ux", "thiết kế", "design", "layout", "spacing", "màu", "icon", "logo", "wireframe", "figma", "3d", "animation"], files: [".css", ".scss", ".svg", ".fig"] },
  { id: "test", label: "Test", row: "tech", keywords: ["test", "kiểm thử", "qa", "playwright", "vitest", "pytest", "e2e", "regression", "review", "rà soát"], files: [".test.ts", ".spec.ts", "_test.py"] },
  { id: "devops", label: "DevOps", row: "tech", keywords: ["deploy", "ci", "cd", "docker", "vercel", "github actions", "release", "phát hành", "pipeline", "workflow", "tunnel", "cloudflare"], files: ["dockerfile", ".yml", ".yaml"] },
  { id: "ai", label: "AI Engineer", row: "tech", keywords: ["prompt", "llm", "agent", "model", "mcp", "skill", "claude", "codex", "antigravity", "gemini", "rag", "embedding", "bridge"], files: [] },
  { id: "data", label: "Data", row: "tech", keywords: ["data", "dữ liệu", "phân tích", "báo cáo", "dashboard", "chart", "pandas", "thống kê", "csv", "visualisation"], files: [".csv", ".ipynb", ".parquet"] },
  { id: "system", label: "System", row: "tech", keywords: ["windows", "macos", "linux", "registry", "powershell", "ssh", "tailscale", "dọn", "ổ c", "cài đặt", "setup", "driver", "hệ thống", "scheduled task", "startup"], files: [".ps1", ".sh", ".bat"] },
];

export const ROLE_BY_ID = new Map(ROLES.map((r) => [r.id, r]));

export function classifyRole(text: string, files: string[]): RoleId | null {
  const hay = ` ${text.toLowerCase()} `;
  let best: RoleId | null = null;
  let bestScore = 0;
  for (const role of ROLES) {
    let score = 0;
    for (const kw of role.keywords) {
      if (kw.length <= 3 ? new RegExp(`(?:^|[^\\p{L}\\p{N}])${kw}(?:[^\\p{L}\\p{N}]|$)`, "u").test(hay) : hay.includes(kw)) score += 2;
    }
    for (const f of files) {
      const lf = f.toLowerCase();
      for (const ext of role.files) if (lf.endsWith(ext) || lf.includes(ext)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = role.id;
    }
  }
  return bestScore >= 2 ? best : null;
}
