const TOOL_VERBS: [RegExp, string][] = [
  [/^(bash|powershell|shell|exec_command|local_shell|run_in_terminal)$/i, "Chạy lệnh"],
  [/^read$|read_file|view_image/i, "Đọc file"],
  [/^(edit|multiedit|notebookedit|apply_patch)$/i, "Sửa file"],
  [/^write$|write_file/i, "Ghi file"],
  [/^(grep|glob|search|find)$/i, "Tìm trong code"],
  [/^(webfetch|websearch|web_search|fetch)$/i, "Tra web"],
  [/^(agent|task)$/i, "Giao việc cho subagent"],
  [/^(askuserquestion|request_user_input|request_user_input_async)$/i, "Hỏi sếp"],
  [/^(spawn_agent|followup_task)$/i, "Giao việc cho subagent"],
  [/^(send_message|send_message_to_thread)$/i, "Trao đổi với agent"],
  [/^(wait_agent|wait|sleep)$/i, "Chờ kết quả"],
  [/^(update_plan|todowrite)$|ccd_turn/i, "Cập nhật kế hoạch"],
  [/^skill$/i, "Dùng skill"],
  [/browser|chrome|playwright/i, "Dùng trình duyệt"],
  [/codex-bridge|codex_bridge/i, "Nhắn Codex"],
  [/claude-bridge|claude_bridge/i, "Nhắn Claude"],
  [/supabase/i, "Truy vấn Supabase"],
  [/vercel/i, "Làm việc với Vercel"],
  [/artifact/i, "Xuất bản trang"],
  [/computer-use|computer_use|cua_repl/i, "Điều khiển màn hình"],
];

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function mcpLabel(name: string): string | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!m) return null;
  const server = m[1].replace(/^[0-9a-f]{8}-[0-9a-f-]+$/i, "connector");
  return `Gọi ${server}: ${m[2].replace(/_/g, " ")}`;
}

function safeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|Bearer\s+[\w.\/+~-]+)/gi, "[đã ẩn]")
    .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[đã ẩn]")
    .replace(/https?:\/\/[^\s]+/gi, (value) => {
      try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return "[liên kết]"; }
    });
}

function commandLabel(source: string): string {
  if (/\b(?:vitest|pytest|playwright\s+test|jest|node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test)\b/i.test(source)) return "Chạy test";
  if (/\btsc(?:\b|[./\\])|typescript[/\\]bin[/\\]tsc/i.test(source)) return "Kiểm tra TypeScript (tsc)";
  if (/\b(?:npm|pnpm)\s+(?:run\s+)?build\b|vite(?:\.js)?\s+build\b/i.test(source)) return "Build dự án";
  if (/\bgit\s+(?:status|diff|log|show)\b/i.test(source)) return "Kiểm tra thay đổi Git";
  if (/\b(?:rg|grep|Get-Content|cat)\b/i.test(source)) return "Đọc và tìm trong file";
  return "Chạy lệnh";
}

export function describeTool(name: string, input: Record<string, unknown>): string {
  name = name.replace(/^functions\.|^collaboration\./, "");
  if (/^(bash|powershell|shell|exec_command|local_shell|run_in_terminal)$/i.test(name)) return commandLabel(String(input.command ?? input.cmd ?? ""));
  if (name === "exec") {
    const source = String(input.command ?? input.code ?? "");
    const calls = [...source.matchAll(/tools\.([\w]+)\s*\(/g)].map((match) => match[1]);
    const labels = [...new Set(calls.map((call) => call === "exec_command" ? commandLabel(source) : TOOL_VERBS.find(([re]) => re.test(call))?.[1] ?? mcpLabel(call) ?? "Thực hiện tác vụ"))];
    return labels.length ? labels.join(" · ") : "Thực hiện tác vụ";
  }
  const verb = TOOL_VERBS.find(([re]) => re.test(name))?.[1] ?? mcpLabel(name) ?? name;
  const file = input.file_path ?? input.path ?? input.notebook_path;
  const target = input.description ?? input.title ?? (file ? baseName(String(file)) : "");
  const text = Array.isArray(target) ? target.join(" ") : String(target);
  return text ? `${verb}: ${safeText(text).replace(/\s+/g, " ").trim()}` : verb;
}
