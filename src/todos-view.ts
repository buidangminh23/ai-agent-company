import { L } from "../shared/i18n.ts";
import { PRIORITY_LABELS, TODO_LIMITS, TODO_STATUSES, columnOf, dueLabel, moveTodo, parseQuickAdd, todoCounts, vietnamDay, type Todo, type TodoFields, type TodoPriority, type TodoStatus } from "../shared/todos.ts";
import { escapeHtml as text } from "./markdown.ts";
import "./todos-view.css";

const GLYPHS = {
  check: '<path d="m4.2 8.3 2.6 2.6 5-5.4"/>',
  left: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  right: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  edit: '<path d="M3 13h2.5l7-7-2.5-2.5-7 7zM9.2 4.8l2.5 2.5"/>',
  trash: '<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.3"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  folder: '<path d="M2 4.5h4.5l1.2 1.5H14v7H2z"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  close: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
};
const QUICK_EXAMPLE = L("Gửi báo giá ngày mai");
const QUICK_TIP = L("Nhập nhanh: <b>mai</b> hoặc <b>thứ 6</b> để đặt hạn; <b>!cao</b> để ưu tiên cao; <b>#Website</b> để chọn dự án. Hoặc chọn trực tiếp ở các ô bên dưới.");
const EMPTY_DRAFT: TodoFields = { title: "", note: "", priority: "normal", due: null, project: "" };
type AutoField = "due" | "priority" | "project";
const AUTO_FIELDS: AutoField[] = ["due", "priority", "project"];
const ORDER: TodoStatus[] = ["todo", "doing", "done"];

function glyph(name: keyof typeof GLYPHS): string {
  return `<svg class="td-glyph" viewBox="0 0 16 16" aria-hidden="true">${GLYPHS[name]}</svg>`;
}

function chips(fields: Pick<TodoFields, "due" | "priority" | "project">, today: string, done = false): string {
  const parts: string[] = [];
  if (fields.due) {
    const due = dueLabel(fields.due, today);
    parts.push(`<span class="td-chip" data-tone="${done ? "later" : due.tone}">${glyph("calendar")}${text(due.text)}</span>`);
  }
  if (fields.priority !== "normal") parts.push(L("<span class=\"td-chip\" data-priority=\"{0}\">Ưu tiên {1}</span>", fields.priority, PRIORITY_LABELS[fields.priority].toLowerCase()));
  if (fields.project) parts.push(`<span class="td-chip" data-tone="project">${glyph("folder")}${text(fields.project)}</span>`);
  return parts.join("");
}

export class TodoBoard {
  private todos: Todo[] | null = null;
  private loading = false;
  private error = "";
  private addDraft: TodoFields = { ...EMPTY_DRAFT };
  private readonly addTouched = new Set<AutoField>();
  private adding = false;
  private editing: string | null = null;
  private draft: TodoFields | null = null;
  private dragId: string | null = null;
  private readonly saving = new Set<string>();

  constructor(private readonly changed: (todos: Todo[]) => void) {}

  list(): Todo[] {
    return this.todos ?? [];
  }

  openCount(): number {
    return this.list().filter((todo) => todo.status !== "done").length;
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const response = await fetch("/api/todos", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(response.status === 401 ? L("Phiên truy cập hết hạn. Tải lại trang để đăng nhập.") : L("Không đọc được danh sách việc ({0}).", response.status));
      this.todos = ((await response.json()) as { todos: Todo[] }).todos;
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : L("Không đọc được danh sách việc.");
    } finally {
      this.loading = false;
      this.changed(this.list());
    }
  }

  markup(now = Date.now()): string {
    const today = vietnamDay(now);
    if (!this.todos) return `<div class="ops-empty"><strong>${this.error ? L("Chưa đọc được danh sách việc") : L("Đang tải việc cá nhân")}</strong><p>${text(this.error || L("Danh sách lưu trên hub, mở ở máy nào cũng thấy giống nhau."))}</p></div>`;
    const counts = todoCounts(this.todos, today);
    const summary = [L("{0} cần làm", counts.todo), L("{0} đang làm", counts.doing), counts.overdue ? L("{0} quá hạn", counts.overdue) : "", counts.doneToday ? L("{0} xong hôm nay", counts.doneToday) : ""].filter(Boolean).join(" · ");
    const error = this.error && !this.adding ? `<p class="td-error" role="alert">${text(this.error)}</p>` : "";
    const popup = this.adding ? this.addMarkup() : "";
    return L("<div class=\"td-wrap\"><div class=\"ops-section-heading td-heading\"><h2>Việc cá nhân</h2><p>{0}. Kéo thẻ sang cột khác, hoặc chọn thẻ rồi bấm Alt + phím mũi tên.</p></div>{1}<div class=\"td-board\">{2}</div>{3}</div>", text(summary), error, TODO_STATUSES.map(([status, label]) => this.columnMarkup(status, label, today)).join(""), popup);
  }

  private columnMarkup(status: TodoStatus, label: string, today: string): string {
    const cards = columnOf(this.list(), status);
    const add = status === "todo" ? L("<button type=\"button\" class=\"td-add-open\" data-todo-add-open data-key=\"todo-add:open\" aria-haspopup=\"dialog\">{0}Thêm việc</button>", glyph("plus")) : "";
    const body = cards.map((todo) => (todo.id === this.editing ? this.editMarkup(todo) : this.cardMarkup(todo, today))).join("") || `<li class="td-empty">${status === "todo" ? L("Chưa có việc nào. Bấm Thêm việc để tạo việc đầu tiên.") : status === "doing" ? L("Kéo việc vào đây khi bắt đầu làm.") : L("Việc xong sẽ nằm ở đây.")}</li>`;
    return `<section class="td-column" data-status="${status}" aria-labelledby="td-head-${status}"><header class="td-column-head"><h3 id="td-head-${status}">${label}</h3><span class="td-count">${cards.length}</span></header>${add}<ol class="td-list" data-drop="${status}" aria-label="${label}">${body}</ol></section>`;
  }

  private addMarkup(): string {
    const draft = this.addDraft;
    const options = (Object.keys(PRIORITY_LABELS) as TodoPriority[]).map((value) => `<option value="${value}" ${draft.priority === value ? "selected" : ""}>${PRIORITY_LABELS[value]}</option>`).join("");
    const projects = [...new Set(this.list().map((todo) => todo.project).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi")).map((project) => `<option value="${text(project)}"></option>`).join("");
    const title = L("<div class=\"td-field\"><label for=\"td-quick\">Tên việc</label><input id=\"td-quick\" type=\"text\" autocomplete=\"off\" required maxlength=\"{0}\" placeholder=\"Ví dụ: {1}\" value=\"{2}\" aria-describedby=\"td-quick-hint\" data-todo-add-field=\"title\" data-key=\"todo-add:title\"><p class=\"td-hint\" id=\"td-quick-hint\" data-todo-hint>{3}</p></div>", TODO_LIMITS.title + 80, QUICK_EXAMPLE, text(draft.title), this.hintMarkup());
    const note = L("<div class=\"td-field\"><label for=\"td-add-note\">Ghi chú</label><textarea id=\"td-add-note\" rows=\"2\" maxlength=\"{0}\" placeholder=\"Chi tiết, đường dẫn, người liên quan (không bắt buộc)\" data-todo-add-field=\"note\" data-key=\"todo-add:note\">{1}</textarea></div>", TODO_LIMITS.note, text(draft.note));
    const due = L("<div class=\"td-field\"><label for=\"td-add-due\">Hạn chót</label><input id=\"td-add-due\" type=\"date\" value=\"{0}\" data-todo-add-field=\"due\" data-key=\"todo-add:due\"></div>", text(draft.due ?? ""));
    const priority = L("<div class=\"td-field\"><label for=\"td-add-priority\">Ưu tiên</label><select id=\"td-add-priority\" data-todo-add-field=\"priority\" data-key=\"todo-add:priority\">{0}</select></div>", options);
    const project = L("<div class=\"td-field\"><label for=\"td-add-project\">Dự án</label><input id=\"td-add-project\" type=\"text\" autocomplete=\"off\" list=\"td-projects\" maxlength=\"{0}\" placeholder=\"Tuỳ chọn\" value=\"{1}\" data-todo-add-field=\"project\" data-key=\"todo-add:project\"></div><datalist id=\"td-projects\">{2}</datalist>", TODO_LIMITS.project, text(draft.project), projects);
    const error = this.error ? `<p class="td-error" role="alert">${text(this.error)}</p>` : "";
    const busy = this.saving.has("new");
    const header = L("<header class=\"td-pop-head\"><h3 id=\"td-pop-title\">Thêm việc mới</h3><button type=\"button\" class=\"td-icon\" data-todo-add-close data-key=\"todo-add:close\" aria-label=\"Đóng\" title=\"Đóng (Esc)\">{0}</button></header>", glyph("close"));
    const footer = L("<footer class=\"td-pop-foot\"><button type=\"button\" class=\"td-pop-reset\" data-todo-add-reset data-key=\"todo-add:reset\">Xoá trống</button><button type=\"button\" data-todo-add-close data-key=\"todo-add:cancel\">Huỷ</button><button type=\"submit\" class=\"ops-primary\" data-key=\"todo-add:submit\"{0}>{1}</button></footer>", busy ? " disabled" : "", busy ? L("Đang lưu…") : L("Thêm việc"));
    return `<div class="td-pop-back" aria-hidden="true" data-todo-add-close></div><div class="td-pop" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="td-pop-title"><form class="td-add" data-todo-add>${header}<div class="td-pop-body">${title}${note}<div class="td-add-row">${due}${priority}${project}</div>${error}</div>${footer}</form></div>`;
  }

  private hintMarkup(): string {
    const raw = this.addDraft.title.trim();
    const saved = raw ? parseQuickAdd(raw, vietnamDay(Date.now())).title : "";
    return saved && saved !== raw ? L("<span class=\"td-hint-label\">Tên sẽ lưu:</span> {0}", text(saved)) : QUICK_TIP;
  }

  private cardMarkup(todo: Todo, today: string): string {
    const index = ORDER.indexOf(todo.status);
    const done = todo.status === "done";
    const busy = this.saving.has(todo.id);
    const back = index > 0 ? L("<button type=\"button\" class=\"td-icon\" data-todo-move=\"{0}\" data-to=\"{1}\" aria-label=\"Chuyển về {2}\" title=\"Chuyển về {3}\">{4}</button>", todo.id, ORDER[index - 1], TODO_STATUSES[index - 1][1], TODO_STATUSES[index - 1][1], glyph("left")) : "";
    const forward = index < ORDER.length - 1 ? L("<button type=\"button\" class=\"td-icon\" data-todo-move=\"{0}\" data-to=\"{1}\" aria-label=\"Chuyển sang {2}\" title=\"Chuyển sang {3}\">{4}</button>", todo.id, ORDER[index + 1], TODO_STATUSES[index + 1][1], TODO_STATUSES[index + 1][1], glyph("right")) : "";
    const meta = chips(todo, today, done);
    return L("<li class=\"td-card\" draggable=\"true\" tabindex=\"0\" data-todo=\"{0}\" data-key=\"todo:{1}\" data-priority=\"{2}\" data-busy=\"{3}\" aria-label=\"{4}\"><button type=\"button\" class=\"td-check\" data-todo-toggle=\"{5}\" aria-pressed=\"{6}\" aria-label=\"{7}\" title=\"{8}\">{9}</button><div class=\"td-body\"><p class=\"td-title\">{10}</p>{11}{12}</div><div class=\"td-actions\">{13}{14}<button type=\"button\" class=\"td-icon\" data-todo-edit=\"{15}\" aria-label=\"Sửa việc\" title=\"Sửa\">{16}</button><button type=\"button\" class=\"td-icon\" data-todo-delete=\"{17}\" aria-label=\"Xoá việc\" title=\"Xoá\">{18}</button></div></li>", todo.id, todo.id, todo.priority, busy, text(todo.title), todo.id, done, done ? L("Mở lại việc này") : L("Đánh dấu đã xong"), done ? L("Mở lại") : "Xong", glyph("check"), text(todo.title), todo.note ? `<p class="td-note">${text(todo.note)}</p>` : "", meta ? `<div class="td-meta">${meta}</div>` : "", back, forward, todo.id, glyph("edit"), todo.id, glyph("trash"));
  }

  private editMarkup(todo: Todo): string {
    const draft = this.draft!;
    const options = (Object.keys(PRIORITY_LABELS) as TodoPriority[]).map((value) => `<option value="${value}" ${draft.priority === value ? "selected" : ""}>${PRIORITY_LABELS[value]}</option>`).join("");
    return L("<li class=\"td-card td-editing\"><form class=\"td-edit\" data-todo-form=\"{0}\"><label>Tên việc<input type=\"text\" maxlength=\"{1}\" required value=\"{2}\" data-todo-field=\"title\" data-key=\"todo-edit:title\"></label><label>Ghi chú<textarea rows=\"3\" maxlength=\"{3}\" data-todo-field=\"note\" data-key=\"todo-edit:note\">{4}</textarea></label><div class=\"td-edit-row\"><label>Hạn chót<input type=\"date\" value=\"{5}\" data-todo-field=\"due\" data-key=\"todo-edit:due\"></label><label>Ưu tiên<select data-todo-field=\"priority\" data-key=\"todo-edit:priority\">{6}</select></label><label>Dự án<input type=\"text\" maxlength=\"{7}\" value=\"{8}\" data-todo-field=\"project\" data-key=\"todo-edit:project\"></label></div><div class=\"td-edit-actions\"><button type=\"button\" data-todo-cancel data-key=\"todo-edit:cancel\">Huỷ</button><button type=\"submit\" class=\"ops-primary\" data-key=\"todo-edit:save\">Lưu</button></div></form></li>", todo.id, TODO_LIMITS.title, text(draft.title), TODO_LIMITS.note, text(draft.note), text(draft.due ?? ""), options, TODO_LIMITS.project, text(draft.project));
  }

  click(target: Element): boolean {
    if (target.closest("[data-todo-add-reset]")) {
      this.resetAdd();
      return true;
    }
    if (target.closest("[data-todo-add-open]")) {
      this.openAdd();
      return true;
    }
    if (target.closest("[data-todo-add-close]")) {
      this.closeAdd();
      return true;
    }
    const element = target.closest<HTMLElement>("[data-todo-toggle], [data-todo-move], [data-todo-edit], [data-todo-delete], [data-todo-cancel]");
    if (!element) return false;
    const data = element.dataset;
    if (data.todoToggle) {
      const todo = this.find(data.todoToggle);
      if (todo) void this.move(todo.id, todo.status === "done" ? "todo" : "done", 0);
    } else if (data.todoMove) void this.move(data.todoMove, data.to as TodoStatus, 0);
    else if (data.todoEdit) this.startEdit(data.todoEdit);
    else if (data.todoDelete) void this.remove(data.todoDelete);
    else this.stopEdit();
    return true;
  }

  input(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, root: ParentNode): boolean {
    const addField = target.dataset.todoAddField as keyof TodoFields | undefined;
    if (addField) {
      this.inputAdd(addField, target.value, root);
      return true;
    }
    const field = target.dataset.todoField as keyof TodoFields | undefined;
    if (!field || !this.draft) return false;
    this.draft = { ...this.draft, [field]: field === "due" ? target.value || null : target.value };
    return true;
  }

  submit(form: HTMLFormElement): boolean {
    if (form.matches("[data-todo-add]")) {
      void this.create();
      return true;
    }
    if (form.dataset.todoForm) {
      void this.saveEdit(form.dataset.todoForm);
      return true;
    }
    return false;
  }

  keydown(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && this.adding) {
      this.closeAdd();
      return true;
    }
    if (event.key === "Escape" && this.editing && target.closest(".td-edit")) {
      this.stopEdit();
      return true;
    }
    const id = target.matches("[data-todo]") ? target.dataset.todo! : null;
    if (!id) return false;
    const todo = this.find(id);
    if (!todo) return false;
    if (event.key === "Enter") {
      this.startEdit(id);
      return true;
    }
    if (!event.altKey || !event.key.startsWith("Arrow")) return false;
    const column = columnOf(this.list(), todo.status);
    const position = column.findIndex((item) => item.id === id);
    const index = ORDER.indexOf(todo.status);
    if (event.key === "ArrowLeft" && index > 0) void this.move(id, ORDER[index - 1], 0);
    else if (event.key === "ArrowRight" && index < ORDER.length - 1) void this.move(id, ORDER[index + 1], 0);
    else if (event.key === "ArrowUp" && position > 0) void this.move(id, todo.status, position - 1);
    else if (event.key === "ArrowDown" && position < column.length - 1) void this.move(id, todo.status, position + 1);
    else return true;
    return true;
  }

  bind(root: HTMLElement): void {
    root.addEventListener("dragstart", (event) => {
      const card = (event.target as Element).closest<HTMLElement>("[data-todo]");
      if (!card || !event.dataTransfer) return;
      this.dragId = card.dataset.todo!;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", this.dragId);
      requestAnimationFrame(() => card.classList.add("td-dragging"));
    });
    root.addEventListener("dragover", (event) => {
      const list = (event.target as Element).closest<HTMLElement>("[data-drop]");
      if (!this.dragId || !list) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      this.markDrop(root, list, this.dropIndex(list, event.clientY));
    });
    root.addEventListener("drop", (event) => {
      const list = (event.target as Element).closest<HTMLElement>("[data-drop]");
      if (!this.dragId || !list) return;
      event.preventDefault();
      const id = this.dragId;
      const index = this.dropIndex(list, event.clientY);
      this.endDrag(root);
      void this.move(id, list.dataset.drop as TodoStatus, index);
    });
    root.addEventListener("dragend", () => this.endDrag(root));
  }

  private dropIndex(list: HTMLElement, y: number): number {
    const cards = [...list.querySelectorAll<HTMLElement>("[data-todo]")].filter((card) => card.dataset.todo !== this.dragId);
    const index = cards.findIndex((card) => {
      const rect = card.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    return index < 0 ? cards.length : index;
  }

  private markDrop(root: HTMLElement, list: HTMLElement, index: number): void {
    for (const element of root.querySelectorAll<HTMLElement>("[data-drop-over], [data-drop-before]")) {
      delete element.dataset.dropOver;
      delete element.dataset.dropBefore;
    }
    list.dataset.dropOver = "true";
    const cards = [...list.querySelectorAll<HTMLElement>("[data-todo]")].filter((card) => card.dataset.todo !== this.dragId);
    if (cards[index]) cards[index].dataset.dropBefore = "true";
    else list.dataset.dropOver = "end";
  }

  private endDrag(root: HTMLElement): void {
    this.dragId = null;
    for (const element of root.querySelectorAll<HTMLElement>("[data-drop-over], [data-drop-before], .td-dragging")) {
      delete element.dataset.dropOver;
      delete element.dataset.dropBefore;
      element.classList.remove("td-dragging");
    }
  }

  private inputAdd(field: keyof TodoFields, value: string, root: ParentNode): void {
    if (field !== "title") {
      this.addDraft = { ...this.addDraft, [field]: field === "due" ? value || null : value };
      if (field !== "note") this.addTouched.add(field);
      return;
    }
    const parsed = parseQuickAdd(value, vietnamDay(Date.now()));
    this.addDraft = { ...this.addDraft, title: value };
    for (const auto of AUTO_FIELDS) {
      if (this.addTouched.has(auto)) continue;
      this.addDraft = { ...this.addDraft, [auto]: parsed[auto] };
      const control = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-todo-add-field="${auto}"]`);
      if (control) control.value = parsed[auto] ?? "";
    }
    const hint = root.querySelector<HTMLElement>("[data-todo-hint]");
    if (hint) hint.innerHTML = this.hintMarkup();
  }

  private openAdd(): void {
    this.adding = true;
    this.error = "";
    this.changed(this.list());
    document.querySelector<HTMLInputElement>("#td-quick")?.focus();
  }

  private closeAdd(): void {
    this.adding = false;
    this.error = "";
    this.changed(this.list());
    document.querySelector<HTMLElement>("[data-todo-add-open]")?.focus();
  }

  private resetAdd(): void {
    this.addDraft = { ...EMPTY_DRAFT };
    this.addTouched.clear();
    this.changed(this.list());
    document.querySelector<HTMLInputElement>("#td-quick")?.focus();
  }

  private find(id: string): Todo | undefined {
    return this.todos?.find((todo) => todo.id === id);
  }

  private startEdit(id: string): void {
    const todo = this.find(id);
    if (!todo) return;
    this.editing = id;
    this.draft = { title: todo.title, note: todo.note, priority: todo.priority, due: todo.due, project: todo.project };
    this.changed(this.list());
    document.querySelector<HTMLInputElement>('[data-key="todo-edit:title"]')?.focus();
  }

  private stopEdit(): void {
    const id = this.editing;
    this.editing = null;
    this.draft = null;
    this.changed(this.list());
    if (id) document.querySelector<HTMLElement>(`[data-key="todo:${id}"]`)?.focus();
  }

  private async write(method: string, id: string | null, body?: unknown): Promise<Todo | null> {
    const response = await fetch(id ? `/api/todos/${encodeURIComponent(id)}` : "/api/todos", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12_000) });
    const payload = (await response.json().catch(() => null)) as (Todo & { error?: string }) | null;
    if (!response.ok) throw new Error(response.status === 401 ? L("Phiên truy cập hết hạn. Tải lại trang để đăng nhập.") : payload?.error ?? L("Hub trả lỗi {0}.", response.status));
    return method === "DELETE" ? null : payload;
  }

  private async run(id: string, action: () => Promise<void>): Promise<void> {
    this.saving.add(id);
    try {
      await action();
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : L("Không lưu được việc. Thử lại sau.");
      await this.refresh();
    } finally {
      this.saving.delete(id);
      this.changed(this.list());
    }
  }

  private async create(): Promise<void> {
    const draft = this.addDraft;
    const fields: TodoFields = { ...draft, title: parseQuickAdd(draft.title, vietnamDay(Date.now())).title, note: draft.note.trim(), project: draft.project.trim() };
    if (!fields.title) {
      this.error = L("Nhập tên việc trước khi thêm.");
      this.changed(this.list());
      return;
    }
    let createdId: string | null = null;
    await this.run("new", async () => {
      const created = await this.write("POST", null, fields);
      if (created && !this.find(created.id)) this.todos = moveTodo([...this.list(), created], created.id, "todo", 0, created.createdAt);
      this.addDraft = { ...EMPTY_DRAFT };
      this.addTouched.clear();
      this.adding = false;
      createdId = created?.id ?? null;
    });
    if (this.adding) document.querySelector<HTMLInputElement>("#td-quick")?.focus();
    else document.querySelector<HTMLElement>(createdId ? `[data-key="todo:${createdId}"]` : "[data-todo-add-open]")?.focus();
  }

  private async move(id: string, status: TodoStatus, index: number): Promise<void> {
    if (!this.find(id)) return;
    this.todos = moveTodo(this.list(), id, status, index, new Date().toISOString());
    this.changed(this.list());
    document.querySelector<HTMLElement>(`[data-key="todo:${id}"]`)?.focus({ preventScroll: true });
    await this.run(id, async () => {
      await this.write("PATCH", id, { status, index });
    });
  }

  private async saveEdit(id: string): Promise<void> {
    const draft = this.draft;
    if (!draft) return;
    if (!draft.title.trim()) {
      this.error = L("Tên việc không được để trống.");
      this.changed(this.list());
      return;
    }
    await this.run(id, async () => {
      const updated = await this.write("PATCH", id, draft);
      if (updated) this.todos = this.list().map((todo) => (todo.id === id ? updated : todo));
      this.editing = null;
      this.draft = null;
    });
    document.querySelector<HTMLElement>(`[data-key="todo:${id}"]`)?.focus();
  }

  private async remove(id: string): Promise<void> {
    const todo = this.find(id);
    if (!todo || !window.confirm(L("Xoá việc “{0}”?", todo.title))) return;
    this.todos = this.list().filter((item) => item.id !== id);
    this.changed(this.list());
    await this.run(id, async () => {
      await this.write("DELETE", id);
    });
  }
}
