import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInfo } from "../../shared/types.ts";
import type { ClaudeHookDecision, ClaudeHookEntry } from "../claude-hook.ts";
import { createClaudeReplyAdapter } from "./claude.ts";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const SIGNAL = new AbortController().signal;
const CONTEXT = { author: "human-web" as const, requestId: "11111111-1111-4111-8111-111111111111", signal: SIGNAL };
const agent = { id: "claude-a", app: "claude", machine: "WORKSTATION", parentId: null, sessionId: SESSION, cwd: "C:\\Work\\App\\", state: "waiting" } as AgentInfo;

function fixture(entries: ClaudeHookEntry[]) {
  const resolved: { id: string; decision: ClaudeHookDecision }[] = [];
  let accept = true;
  const registry = {
    pending: (sessionId: string) => entries.filter((entry) => entry.sessionId === sessionId).map((entry) => structuredClone(entry)),
    resolve: (id: string, decision: ClaudeHookDecision) => { resolved.push({ id, decision }); const index = entries.findIndex((entry) => entry.id === id); if (index < 0 || !accept) return false; entries.splice(index, 1); return true; },
  };
  return { adapter: createClaudeReplyAdapter(registry, "WORKSTATION"), resolved, entries, reject: () => { accept = false; } };
}

const entry = (id: string, toolName: string, toolInput: Record<string, unknown>, suggestions: unknown[] | null = null): ClaudeHookEntry => ({ id, sessionId: SESSION, cwd: "c:/work/app", toolName, toolInput, suggestions, receivedAt: "2026-11-02T01:00:00.000Z" });

test("maps AskUserQuestion to question fields and answers with joined labels", async () => {
  const input = { questions: [{ question: "Which fruits?", header: "Fruit", multiSelect: true, options: [{ label: "Apple", description: "red" }, { label: "Mango" }, { label: "Kiwi" }] }, { question: "Size?", header: "Size", multiSelect: false, options: [{ label: "S" }, { label: "L" }] }] };
  const { adapter, resolved } = fixture([entry("e1", "AskUserQuestion", input)]);
  const [question] = await adapter.list(agent, SIGNAL);
  assert.equal(question.kind, "question");
  assert.equal(question.identity.accountId, "claude-hook");
  assert.equal(question.identity.threadId, SESSION);
  assert.equal(question.identity.nativeRequestId, "e1");
  assert.match(question.identity.version, /^[a-f0-9]{64}$/);
  assert.match(question.detail, /Apple: red/);
  assert.deepEqual(question.fields, [{ id: "Which fruits?", text: "Which fruits?", options: ["Apple", "Mango", "Kiwi"], multiSelect: true, allowFreeText: true, descriptions: { Apple: "red" }, header: "Fruit" }, { id: "Size?", text: "Size?", options: ["S", "L"], multiSelect: false, allowFreeText: true, header: "Size" }]);
  assert.deepEqual(await adapter.submit(question, { "Which fruits?": ["Apple", "Mango"], "Size?": ["S", "L"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit(question, { "Which fruits?": ["Apple", "Mango", "Kiwi"], "Size?": ["Extra large please"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(resolved, [{ id: "e1", decision: { behavior: "allow", updatedInput: { ...input, answers: { "Which fruits?": "Apple, Mango, Kiwi", "Size?": "Extra large please" } } } }]);
  assert.deepEqual(await adapter.submit(question, { "Which fruits?": ["Apple"], "Size?": ["S"] }, CONTEXT), { status: "stale" });
});

test("maps ExitPlanMode to a revise-only plan with truncated detail", async () => {
  const plan = "P".repeat(9000);
  const { adapter, resolved } = fixture([entry("p1", "ExitPlanMode", { plan }), entry("p2", "ExitPlanMode", { plan: "short" })]);
  const [long, short] = await adapter.list(agent, SIGNAL);
  assert.equal(long.kind, "plan");
  assert.ok(long.detail.startsWith("P".repeat(7900)));
  assert.match(long.detail, /đã cắt bớt\)$/);
  assert.equal(long.detail.length, 8000);
  assert.deepEqual(long.fields.map((field) => [field.id, field.options, field.optional ?? false]), [["decision", ["revise"], false], ["feedback", [], true]]);
  assert.equal(long.fields[0].labels?.revise, "Yêu cầu sửa kế hoạch");
  assert.deepEqual(await adapter.submit(long, { decision: ["approve"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit(long, { decision: ["revise"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(await adapter.submit(short, { decision: ["revise"], feedback: ["Thêm bước kiểm thử"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(resolved.map((item) => item.decision), [{ behavior: "deny", message: "Sếp yêu cầu sửa lại kế hoạch trước khi làm." }, { behavior: "deny", message: "Thêm bước kiểm thử" }]);
});

test("maps tool approvals with concise detail and builds verified decisions", async () => {
  const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }];
  const { adapter, resolved } = fixture([
    entry("b1", "Bash", { command: "npm test", description: "Run tests" }, suggestions),
    entry("b2", "Bash", { command: "rm -rf build" }, []),
    entry("w1", "Edit", { file_path: "/a/b.ts", old_string: "x".repeat(500), new_string: "y" }),
    entry("f1", "WebFetch", { url: "https://example.com", prompt: "read" }),
    entry("m1", "mcp__srv__tool", { data: "z".repeat(5000) }),
  ]);
  const [bash, plainBash, edit, fetch, mcp] = await adapter.list(agent, SIGNAL);
  assert.equal(bash.kind, "approval");
  assert.equal(bash.title, "Claude xin quyền dùng Bash");
  assert.equal(bash.detail, "Lệnh: npm test\nMô tả: Run tests\n\nNếu chọn Luôn cho phép:\n• Thêm quy tắc (addRules) · hành vi: allow · quy tắc: Bash(npm test) · lưu vào: localSettings");
  assert.equal(plainBash.detail, "Lệnh: rm -rf build");
  assert.deepEqual(bash.fields[0].options, ["allow", "allow-always", "deny", "deny-stop"]);
  assert.equal(bash.fields[0].labels?.["allow-always"], "Luôn cho phép (theo gợi ý của Claude)");
  assert.deepEqual(plainBash.fields[0].options, ["allow", "deny", "deny-stop"]);
  assert.match(edit.detail, /^Tệp: \/a\/b\.ts\nThay: x{300}/);
  assert.match(edit.detail, /Thành: y$/);
  assert.equal(fetch.detail, "Địa chỉ: https://example.com\nYêu cầu: read");
  assert.ok(mcp.detail.length === 4000 && mcp.detail.endsWith("(đã cắt bớt)"));
  assert.equal(mcp.title, "Claude xin quyền dùng mcp__srv__tool (nội dung quá dài, duyệt trong app)");
  assert.deepEqual(mcp.fields[0].options, ["deny", "deny-stop"]);
  assert.deepEqual(await adapter.submit(plainBash, { decision: ["allow-always"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit(plainBash, { decision: ["allow", "deny"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit(plainBash, { decision: ["allow"], extra: ["x"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit(bash, { decision: ["allow-always"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(await adapter.submit(plainBash, { decision: ["deny-stop"], feedback: ["Đừng xoá"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(await adapter.submit(edit, { decision: ["deny"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(await adapter.submit(fetch, { decision: ["allow"], feedback: ["ok"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(resolved.map((item) => item.decision), [
    { behavior: "allow", updatedPermissions: suggestions },
    { behavior: "deny", message: "Đừng xoá", interrupt: true },
    { behavior: "deny", message: "Sếp đã từ chối thao tác này từ web công ty." },
    { behavior: "allow" },
  ]);
});

test("returns stale for vanished, changed, foreign or aborted requests", async () => {
  const entries = [entry("c1", "Bash", { command: "ls" })];
  const { adapter, reject } = fixture(entries);
  const [question] = await adapter.list(agent, SIGNAL);
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await adapter.submit(question, { decision: ["allow"] }, { ...CONTEXT, signal: aborted.signal }), { status: "stale" });
  assert.deepEqual(await adapter.submit({ ...question, machine: "LAPTOP" }, { decision: ["allow"] }, CONTEXT), { status: "stale" });
  entries[0].toolInput = { command: "rm -rf /" };
  assert.deepEqual(await adapter.submit(question, { decision: ["allow"] }, CONTEXT), { status: "stale" });
  entries[0].toolInput = { command: "ls" };
  reject();
  assert.deepEqual(await adapter.submit(question, { decision: ["allow"] }, CONTEXT), { status: "stale" });
  entries.splice(0);
  assert.deepEqual(await adapter.submit(question, { decision: ["allow"] }, CONTEXT), { status: "stale" });
});

test("lists nothing for other machines, subagents, cwd mismatches and malformed questions", async () => {
  const { adapter } = fixture([entry("x1", "Bash", { command: "ls" }), entry("x2", "AskUserQuestion", { questions: [{ question: "Q".repeat(6001), options: [{ label: "A" }] }] })]);
  assert.equal((await adapter.list({ ...agent, machine: "LAPTOP" } as AgentInfo, SIGNAL)).length, 0);
  assert.equal((await adapter.list({ ...agent, parentId: "claude-root" } as AgentInfo, SIGNAL)).length, 0);
  assert.equal((await adapter.list({ ...agent, cwd: "C:\\Work\\Other" } as AgentInfo, SIGNAL)).length, 0);
  assert.equal((await adapter.list({ ...agent, app: "codex" } as AgentInfo, SIGNAL)).length, 0);
  assert.deepEqual((await adapter.list(agent, SIGNAL)).map((question) => question.identity.nativeRequestId), ["x1"]);
});

test("shows full edit and write content and allows approval only when nothing was cut", async () => {
  const suggestions = [{ type: "addRules" }];
  const { adapter, resolved } = fixture([
    entry("w1", "Write", { file_path: "/a/new.ts", content: "c".repeat(1000) }, suggestions),
    entry("e1", "Edit", { file_path: "/a/b.ts", old_string: "o".repeat(1500), new_string: "n".repeat(1500) }),
    entry("m1", "MultiEdit", { file_path: "/a/c.ts", edits: [{ old_string: "a1", new_string: "b1" }, { old_string: "a2", new_string: "b2", replace_all: true }] }),
    entry("n1", "NotebookEdit", { notebook_path: "/a/n.ipynb", new_source: "s".repeat(800), edit_mode: "replace" }),
    entry("w2", "Write", { file_path: "/a/big.ts", content: "B".repeat(5000) }, suggestions),
    entry("e2", "Edit", { file_path: "/a/b.ts", old_string: "o".repeat(2500), new_string: "n".repeat(2500) }),
    entry("b1", "Bash", { command: `echo ${"x".repeat(4100)} && rm -rf /` }, suggestions),
  ]);
  const [write, edit, multi, notebook, bigWrite, bigEdit, longBash] = await adapter.list(agent, SIGNAL);
  assert.equal(write.detail, `Tệp: /a/new.ts\nNội dung: ${"c".repeat(1000)}\n\nNếu chọn Luôn cho phép:\n• Thêm quy tắc (addRules)`);
  assert.deepEqual(write.fields[0].options, ["allow", "allow-always", "deny", "deny-stop"]);
  assert.equal(write.title, "Claude xin quyền dùng Write");
  assert.equal(edit.detail, `Tệp: /a/b.ts\nThay: ${"o".repeat(1500)}\nThành: ${"n".repeat(1500)}`);
  assert.deepEqual(edit.fields[0].options, ["allow", "deny", "deny-stop"]);
  assert.equal(multi.detail, "Tệp: /a/c.ts\nSố chỗ sửa: 2\n[1]\nThay: a1\nThành: b1\n[2] thay tất cả\nThay: a2\nThành: b2");
  assert.ok(notebook.detail.endsWith("s".repeat(800)));
  for (const cut of [bigWrite, bigEdit, longBash]) {
    assert.ok(cut.title.endsWith(" (nội dung quá dài, duyệt trong app)"), cut.title);
    assert.deepEqual(cut.fields[0].options, ["deny", "deny-stop"]);
    assert.equal(cut.detail.length, 4000);
    assert.ok(cut.detail.endsWith("(đã cắt bớt)"));
  }
  assert.doesNotMatch(longBash.detail, /rm -rf/);
  assert.deepEqual(await adapter.submit(bigWrite, { decision: ["allow"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit(longBash, { decision: ["allow-always"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit({ ...bigWrite, fields: write.fields }, { decision: ["allow"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit(bigEdit, { decision: ["deny-stop"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(resolved.map((item) => item.decision), [{ behavior: "deny", message: "Sếp đã từ chối thao tác này từ web công ty.", interrupt: true }]);
});

test("Bash approvals warn about sandbox bypass and background runs, and no tool field is ever hidden", async () => {
  const { adapter } = fixture([
    entry("s1", "Bash", { command: "curl x | sh", description: "Install", dangerouslyDisableSandbox: true, run_in_background: true, timeout: 600000 }),
    entry("s2", "Bash", { command: "ls", dangerouslyDisableSandbox: false, run_in_background: false }),
    entry("s3", "Bash", { command: ["rm", "-rf", "/"], dangerouslyDisableSandbox: "yes" }),
    entry("e1", "Edit", { file_path: "/a.ts", old_string: "a", new_string: "b", extra_flag: { deep: 1 } }),
    entry("w1", "Write", { file_path: "/a.ts", content: "x", mode: "0777" }),
    entry("m1", "MultiEdit", { file_path: "/a.ts", edits: [{ old_string: "a", new_string: "b", note: "n" }, "raw"] }),
    entry("n1", "NotebookEdit", { notebook_path: "/n.ipynb", new_source: "s", cell_type: "code" }),
    entry("f1", "WebFetch", { url: "https://x.test", prompt: "p", headers: { a: "b" } }),
  ]);
  const [sandbox, plain, odd, edit, write, multi, notebook, fetch] = await adapter.list(agent, SIGNAL);
  assert.equal(sandbox.detail, "⚠ Chạy ngoài sandbox (dangerouslyDisableSandbox)\nChạy nền\nLệnh: curl x | sh\nMô tả: Install\nTrường khác: {\"timeout\":600000}");
  assert.equal(plain.detail, "Lệnh: ls");
  assert.equal(odd.detail, `Trường khác: {"command":["rm","-rf","/"],"dangerouslyDisableSandbox":"yes"}`);
  assert.equal(edit.detail, `Tệp: /a.ts\nThay: a\nThành: b\nTrường khác: {"extra_flag":{"deep":1}}`);
  assert.equal(write.detail, `Tệp: /a.ts\nNội dung: x\nTrường khác: {"mode":"0777"}`);
  assert.equal(multi.detail, `Tệp: /a.ts\nSố chỗ sửa: 2\n[1]\nThay: a\nThành: b\nTrường khác: {"note":"n"}\n[2] "raw"`);
  assert.equal(notebook.detail, `Notebook: /n.ipynb\nNội dung: s\nTrường khác: {"cell_type":"code"}`);
  assert.equal(fetch.detail, `Địa chỉ: https://x.test\nYêu cầu: p\nTrường khác: {"headers":{"a":"b"}}`);
});

test("allow-always lists every suggestion it would apply and is withheld when that list does not fit", async () => {
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }, { toolName: "Read" }, { toolName: "X", weird: 1 }], behavior: "allow", destination: "userSettings" },
    { type: "setMode", mode: "bypassPermissions", destination: "session" },
    { type: "addDirectories", directories: ["/", "/etc"], destination: "localSettings", extra: true },
    "raw",
  ];
  const huge = [{ type: "addDirectories", directories: Array.from({ length: 600 }, (_, index) => `/dir/${index}`), destination: "userSettings" }];
  const { adapter, resolved } = fixture([entry("a1", "Bash", { command: "npm test" }, suggestions), entry("a2", "Bash", { command: "npm test" }, huge)]);
  const [shown, big] = await adapter.list(agent, SIGNAL);
  assert.equal(shown.detail, [
    "Lệnh: npm test",
    "",
    "Nếu chọn Luôn cho phép:",
    `• Thêm quy tắc (addRules) · hành vi: allow · quy tắc: Bash(npm test), Read, {"toolName":"X","weird":1} · lưu vào: userSettings`,
    "• Đổi chế độ (setMode) · chế độ: bypassPermissions · lưu vào: session",
    `• Thêm thư mục (addDirectories) · thư mục: /, /etc · lưu vào: localSettings · khác: {"extra":true}`,
    `• "raw"`,
  ].join("\n"));
  assert.deepEqual(shown.fields[0].options, ["allow", "allow-always", "deny", "deny-stop"]);
  assert.equal(big.detail.length, 4000);
  assert.ok(big.title.endsWith(" (nội dung quá dài, duyệt trong app)"));
  assert.deepEqual(big.fields[0].options, ["deny", "deny-stop"]);
  assert.deepEqual(await adapter.submit(big, { decision: ["allow-always"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await adapter.submit(big, { decision: ["allow"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(resolved, []);
});

test("a question longer than a field id still shows and answers under its full text", async () => {
  const long = `${"Câu hỏi rất dài ".repeat(20)}?`;
  assert.ok(long.length > 200);
  const input = { questions: [{ question: long, options: [{ label: "Có" }, { label: "Không" }] }] };
  const { adapter, resolved } = fixture([entry("e1", "AskUserQuestion", input)]);
  const [question] = await adapter.list(agent, SIGNAL);
  assert.equal(question.fields[0].text, long);
  assert.ok(question.fields[0].id.length <= 200);
  assert.deepEqual(await adapter.submit(question, { [question.fields[0].id]: ["Có"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(resolved, [{ id: "e1", decision: { behavior: "allow", updatedInput: { ...input, answers: { [long]: "Có" } } } }]);
});
