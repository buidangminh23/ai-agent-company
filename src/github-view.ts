import { L, locale } from "../shared/i18n.ts";
import { ACTION_LABELS, GIT_GROUPS, actionable, repoGroups, shortTitle, type GitAction, type GitHubSnapshot, type GitItem, type GitKind } from "../shared/github.ts";
import { escapeHtml } from "./markdown.ts";
import "./github-view.css";

const KIND_LABELS: Record<GitKind, string> = { ci: L("CI lỗi"), pr: "Pull request", issue: "Issue", security: L("Bảo mật"), notification: L("Thông báo") };
const KIND_SHORT: Record<GitKind, string> = { ci: L("CI lỗi"), pr: "PR", issue: "Issue", security: L("Bảo mật"), notification: L("Thông báo") };
const SEVERITY_STATE = { error: "offline", warning: "waiting", info: "idle" } as const;
const SEVERITY_LABELS = { error: L("Cần sửa"), warning: L("Cần xem"), info: L("Thông tin") } as const;

function text(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

function href(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function ago(value: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(value)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return L("vừa xong");
  if (minutes < 60) return L("{0} phút", minutes);
  return minutes < 1440 ? L("{0} giờ", Math.floor(minutes / 60)) : L("{0} ngày", Math.floor(minutes / 1440));
}

const BACK = '<svg class="ops-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';

function clock(value: string | null): string {
  return value ? new Date(value).toLocaleString(locale(), { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : L("chưa đọc lần nào");
}

export class GitHubBoard {
  data: GitHubSnapshot | null = null;
  private loading = false;
  private error = "";
  private confirming = "";
  private busy = "";
  private repo: string | null = null;
  private item: string | null = null;
  private repoChosen = false;

  constructor(private readonly changed: () => void, private readonly notify: (message: string) => void) {}

  async refresh(force = false): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const response = await fetch(`/api/github${force ? "?refresh=1" : ""}`, { cache: "no-store", signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(response.status === 401 ? L("Đăng nhập bằng mã truy cập để xem GitHub.") : L("Hub trả lỗi {0}.", response.status));
      this.data = await response.json();
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : L("Không đọc được GitHub.");
    } finally {
      this.loading = false;
      this.changed();
    }
  }

  count(): number {
    return actionable(this.data);
  }

  groups(match: (item: GitItem) => boolean): [string, GitItem[]][] {
    return repoGroups((this.data?.items ?? []).filter(match), this.data?.usage, this.data?.pinned).map((group) => [group.repo, group.items]);
  }

  heading(repo: string, items: GitItem[]): string {
    const [owner, name] = repo.includes("/") ? repo.split("/") : ["", repo];
    const kinds = GIT_GROUPS.map(([kind]) => [kind, items.filter((item) => item.kind === kind).length] as const).filter(([, count]) => count);
    const badges = kinds.map(([kind, count]) => `<span class="gh-mini" data-kind="${kind}">${count} ${KIND_SHORT[kind]}</span>`).join("");
    const commits = this.data?.usage?.find((entry) => entry.repo === repo)?.commits ?? 0;
    const ownerTag = owner && owner !== this.data?.login ? `<small class="gh-repo-owner">${text(owner)}</small>` : "";
    const usageTag = commits ? L("<small class=\"gh-repo-owner\" title=\"Số commit trên nhánh chính trong 30 ngày\">{0} commit/30 ngày</small>", commits) : "";
    return `<span class="gh-repo-head"><span class="gh-repo-name" title="${text(repo)}">${text(name)}</span>${ownerTag}${usageTag}<span class="gh-minis">${badges}</span></span>`;
  }

  emptyState(): { title: string; detail: string } | null {
    if (!this.data) return { title: this.error ? L("Chưa đọc được GitHub") : L("Đang đọc GitHub"), detail: this.error || L("Hub đang lấy CI, pull request, issue, cảnh báo bảo mật và thông báo.") };
    if (!this.data.connected && !this.data.items.length) return { title: L("Chưa nối được GitHub"), detail: this.data.note || L("GitHub CLI trên hub chưa đăng nhập.") };
    return null;
  }

  summary(match: (item: GitItem) => boolean): string {
    const items = (this.data?.items ?? []).filter(match);
    const tone: Record<GitKind, string> = { ci: "red", pr: "amber", issue: "amber", security: "red", notification: "neutral" };
    const cells = GIT_GROUPS.map(([kind, label]) => {
      const list = items.filter((item) => item.kind === kind);
      const first = list[0];
      return `<button type="button" class="ops-kpi" ${first ? `data-gh="open" data-gh-id="${text(first.id)}"` : "disabled"} data-tone="${list.length ? tone[kind] : "neutral"}"><strong>${list.length}</strong><span>${label}</span></button>`;
    }).join("");
    const note = this.data?.note ? ` · ${text(this.data.note)}` : "";
    return L("<div class=\"ops-kpis gh-kpis\">{0}</div><p class=\"gh-sync\">{1} · đồng bộ {2}{3}<button type=\"button\" class=\"gh-refresh\" data-gh=\"refresh\" {4}>{5}</button></p>", cells, this.data?.login ? L("Tài khoản {0} · {1} repo", text(this.data.login), this.data.repos) : "GitHub", text(clock(this.data?.fetchedAt ?? null)), note, this.loading ? "disabled" : "", this.loading ? L("Đang đồng bộ…") : L("Đồng bộ ngay"));
  }

  row(item: GitItem, active: boolean, now: number): string {
    return `<button type="button" class="ops-row" data-gh="open" data-gh-id="${text(item.id)}" data-key="row:${text(item.id)}" aria-current="${active}"><span class="ops-led" data-state="${SEVERITY_STATE[item.severity]}" aria-hidden="true"></span><span class="ops-row-main"><span class="ops-row-title">${text(shortTitle(item))}</span><span class="ops-row-meta"><span class="gh-kind" data-kind="${item.kind}">${KIND_LABELS[item.kind]}</span>${item.author ? ` · ${text(item.author)}` : ""}</span></span><span class="ops-row-side"><time datetime="${text(item.updatedAt)}">${text(ago(item.updatedAt, now))}</time></span></button>`;
  }

  private repoButton(repo: string, items: GitItem[], active: boolean): string {
    const [owner, name] = repo.includes("/") ? repo.split("/") : ["", repo];
    const tone = items.some((item) => item.severity === "error") ? "offline" : items.some((item) => item.severity === "warning") ? "waiting" : "idle";
    const ownerTag = owner && owner !== this.data?.login ? `<small>${text(owner)}</small>` : "";
    return `<button type="button" class="ops-row gh-repo" data-gh="repo" data-gh-repo="${text(repo)}" data-key="gh-repo:${text(repo)}" aria-current="${active}"><span class="ops-led" data-state="${tone}" aria-hidden="true"></span><span class="gh-repo-label" title="${text(repo)}">${text(name)}${ownerTag}</span><span class="gh-repo-count">${items.length}</span></button>`;
  }

  board(match: (item: GitItem) => boolean, now: number): string {
    const groups = this.groups(match).filter(([, list]) => list.length);
    const current = groups.find(([repo]) => repo === this.repo) ?? groups[0];
    this.repo = current[0];
    const [repo, items] = current;
    const opened = items.find((item) => item.id === this.item) ?? null;
    if (!opened) this.item = null;
    const repos = groups.map(([name, list]) => this.repoButton(name, list, name === repo)).join("");
    const toRepos = L("<button type=\"button\" class=\"ops-back\" data-gh=\"repos\" data-key=\"gh-repos\">{0}<span>Danh sách repo</span></button>", BACK);
    const body = opened
      ? L("<button type=\"button\" class=\"gh-back\" data-gh=\"list\" data-key=\"gh-list\">{0}<span>Quay lại {1}</span></button>{2}", BACK, text(repo.split("/").pop()), this.pane(opened, now))
      : `${toRepos}<div class="gh-repo-title">${this.heading(repo, items)}</div><div class="gh-items">${items.map((item) => this.row(item, false, now)).join("")}</div>`;
    return L("<div class=\"ops-split gh-split\" data-detail=\"{0}\"><nav class=\"ops-list gh-repos\" aria-label=\"Repo trên GitHub\">{1}</nav><section class=\"ops-pane\" aria-label=\"{2}\">{3}</section></div>", this.repoChosen, repos, text(repo), body);
  }

  private show(): void {
    this.changed();
    const pane = document.querySelector<HTMLElement>(".gh-split .ops-pane");
    if (pane) pane.scrollTop = 0;
  }

  private actionButton(item: GitItem, action: GitAction): string {
    const key = `${action}:${item.id}`;
    const meta = ACTION_LABELS[action];
    if (this.busy === key) return L("<button type=\"button\" class=\"ops-primary\" disabled>Đang gửi lên GitHub…</button>");
    if (this.confirming === key) return L("<span class=\"gh-confirm\"><span>{0}</span><button type=\"button\" class=\"ops-primary\" data-gh=\"confirm\" data-gh-action=\"{1}\" data-gh-id=\"{2}\" data-key=\"gh-confirm:{3}\">Xác nhận</button><button type=\"button\" data-gh=\"cancel\">Huỷ</button></span>", text(meta.confirm), action, text(item.id), text(key));
    return `<button type="button" data-gh="ask" data-gh-action="${action}" data-gh-id="${text(item.id)}" data-key="gh-ask:${text(key)}" ${this.busy ? "disabled" : ""}>${text(meta.label)}</button>`;
  }

  pane(item: GitItem, now: number): string {
    const tags = item.tags.length ? `<p class="gh-tags">${item.tags.map((tag) => `<span class="gh-tag" data-tone="${tag.tone}">${text(tag.label)}</span>`).join("")}</p>` : "";
    const detail = item.detail.map((line) => `<p class="gh-line">${text(line)}</p>`).join("");
    const link = href(item.url);
    const readAll = item.kind === "notification" ? (this.confirming === "read-all" ? L("<span class=\"gh-confirm\"><span>Đánh dấu mọi thông báo đã đọc?</span><button type=\"button\" class=\"ops-primary\" data-gh=\"confirm-all\" data-key=\"gh-confirm-all\">Xác nhận</button><button type=\"button\" data-gh=\"cancel\">Huỷ</button></span>") : L("<button type=\"button\" data-gh=\"ask-all\" data-key=\"gh-ask-all\" {0}>Đọc tất cả</button>", this.busy ? "disabled" : "")) : "";
    return L("<article class=\"ops-view gh-view\" data-kind=\"{0}\"><div class=\"ops-card-top\"><span class=\"ops-category\">{1}</span><span class=\"ops-state\" data-state=\"{2}\">{3}</span></div><h2 class=\"ops-view-title\">{4}</h2>{5}<div class=\"gh-detail\">{6}</div><footer><time datetime=\"{7}\">Cập nhật {8}{9}</time><div class=\"ops-actions\">{10}{11}{12}</div></footer></article>", item.kind, KIND_LABELS[item.kind], SEVERITY_STATE[item.severity], SEVERITY_LABELS[item.severity], text(item.title), tags, detail, text(item.updatedAt), text(ago(item.updatedAt, now) || L("chưa rõ")), ago(item.updatedAt, now) && ago(item.updatedAt, now) !== L("vừa xong") ? L(" trước") : "", item.actions.map((action) => this.actionButton(item, action)).join(""), readAll, link ? L("<a class=\"ops-action\" href=\"{0}\" target=\"_blank\" rel=\"noopener noreferrer\">Mở trên GitHub</a>", text(link)) : "");
  }

  click(target: Element): boolean {
    const button = target.closest<HTMLElement>("[data-gh]");
    if (!button) return false;
    const mode = button.dataset.gh;
    if (mode === "refresh") void this.refresh(true);
    else if (mode === "repo") { this.repo = button.dataset.ghRepo ?? null; this.item = null; this.repoChosen = true; this.confirming = ""; this.show(); }
    else if (mode === "open") {
      const item = this.data?.items.find((entry) => entry.id === button.dataset.ghId);
      if (item) { this.repo = item.repo; this.item = item.id; this.repoChosen = true; this.confirming = ""; this.show(); }
    }
    else if (mode === "list") { this.item = null; this.confirming = ""; this.show(); }
    else if (mode === "repos") { this.repoChosen = false; this.item = null; this.changed(); }
    else if (mode === "ask") { this.confirming = `${button.dataset.ghAction}:${button.dataset.ghId}`; this.changed(); }
    else if (mode === "ask-all") { this.confirming = "read-all"; this.changed(); }
    else if (mode === "cancel") { this.confirming = ""; this.changed(); }
    else if (mode === "confirm") void this.run(button.dataset.ghId ?? "", button.dataset.ghAction as GitAction);
    else if (mode === "confirm-all") void this.run("", "read-all");
    return true;
  }

  private async run(id: string, action: GitAction | "read-all"): Promise<void> {
    if (this.busy) return;
    this.busy = action === "read-all" ? "read-all" : `${action}:${id}`;
    this.confirming = "";
    this.changed();
    try {
      const response = await fetch("/api/github/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action }), signal: AbortSignal.timeout(120_000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? L("Hub trả lỗi {0}.", response.status));
      this.notify(action === "read-all" ? L("Đã đánh dấu mọi thông báo GitHub là đã đọc.") : ACTION_LABELS[action].done);
      this.busy = "";
      await this.refresh();
    } catch (error) {
      this.notify(error instanceof Error ? error.message : L("GitHub chưa nhận thao tác. Thử lại sau."));
    } finally {
      this.busy = "";
      this.changed();
    }
  }
}
