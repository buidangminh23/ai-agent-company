import tls from "node:tls";
import { allMailBox, type GmailCredentials, quote, ResponseReader } from "./imap.ts";

export interface IdleOptions {
  host?: string;
  port?: number;
  renewMs?: number;
  minRetryMs?: number;
  maxRetryMs?: number;
  commandTimeoutMs?: number;
  allMail?: boolean;
  connect?: (host: string, port: number) => tls.TLSSocket;
}

export interface IdleWatcher {
  stop(): void;
}

const DEFAULT_RENEW_MS = 25 * 60_000;
const DEFAULT_MIN_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 5 * 60_000;
const SOCKET_IDLE_MS = 30 * 60_000;
const CHANGE = /^\* \d+ (EXISTS|EXPUNGE|FETCH)\b/i;

type Phase = "greeting" | "login" | "list" | "select" | "idle-start" | "idling" | "done";

export function watchMailbox(account: GmailCredentials, onChange: () => void, options: IdleOptions = {}): IdleWatcher {
  const host = options.host ?? "imap.gmail.com";
  const port = options.port ?? 993;
  const renewMs = options.renewMs ?? DEFAULT_RENEW_MS;
  const minRetry = options.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
  const maxRetry = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  const connect = options.connect ?? ((h, p) => tls.connect({ host: h, port: p, servername: h }));
  let stopped = false;
  let retry = minRetry;
  let closeCurrent: (() => void) | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  const notify = () => { try { onChange(); } catch {} };
  const schedule = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, retry);
    retryTimer.unref();
    retry = Math.min(maxRetry, retry * 2);
  };

  function open(): void {
    if (stopped) return;
    const reader = new ResponseReader();
    let current: tls.TLSSocket;
    try { current = connect(host, port); } catch { schedule(); return; }
    let phase: Phase = "greeting";
    let counter = 0;
    let tag = "";
    let closed = false;
    let synced = false;
    let discoveredMailbox: string | null = null;
    let selectingAllMail = false;
    let renewTimer: NodeJS.Timeout | null = null;
    let commandTimer: NodeJS.Timeout | null = null;
    const clearRenew = () => { if (renewTimer) clearTimeout(renewTimer); renewTimer = null; };
    const clearCommand = () => { if (commandTimer) clearTimeout(commandTimer); commandTimer = null; };
    const close = () => {
      if (closed) return;
      closed = true;
      clearRenew();
      clearCommand();
      current.setTimeout(0);
      if (closeCurrent === close) closeCurrent = null;
      current.destroy();
    };
    const fail = () => { if (closed) return; close(); schedule(); };
    const armCommand = () => {
      clearCommand();
      commandTimer = setTimeout(fail, commandTimeoutMs);
      commandTimer.unref();
    };
    const write = (command: string) => {
      if (stopped || closed) return;
      armCommand();
      try { current.write(command); } catch { fail(); }
    };
    const send = (command: string) => {
      tag = `i${++counter}`;
      write(`${tag} ${command}\r\n`);
    };
    const startIdle = () => {
      clearRenew();
      phase = "idle-start";
      send("IDLE");
    };
    const selectMailbox = (mailbox: string | null = null) => {
      phase = "select";
      selectingAllMail = Boolean(mailbox && mailbox.toUpperCase() !== "INBOX");
      send(mailbox ? `EXAMINE ${quote(mailbox)}` : "EXAMINE INBOX");
    };
    const findMailbox = () => {
      if (!options.allMail) { selectMailbox(); return; }
      phase = "list";
      send('LIST "" "*"');
    };
    closeCurrent = close;
    current.setKeepAlive(true, 60_000);
    current.setTimeout(SOCKET_IDLE_MS, fail);
    current.on("error", fail);
    current.on("close", fail);
    current.on("end", fail);
    armCommand();
    current.on("data", (chunk: Buffer) => {
      if (stopped || closed) return;
      try { reader.push(chunk); } catch { fail(); return; }
      for (const response of reader.drain()) {
        const { line } = response;
        if (stopped || closed) return;
        if (/^\* BYE\b/i.test(line)) return fail();
        if (phase === "greeting") {
          if (/^\* PREAUTH\b/i.test(line)) {
            findMailbox();
          } else if (/^\* OK\b/i.test(line)) {
            phase = "login";
            send(`LOGIN ${quote(account.address)} ${quote(account.password.replace(/\s+/g, ""))}`);
          } else return fail();
          continue;
        }
        if (line.startsWith(`${tag} `)) {
          const success = /^\S+ OK\b/i.test(line);
          clearCommand();
          if (phase === "list") selectMailbox(success ? discoveredMailbox : null);
          else if (!success && phase === "select" && selectingAllMail) selectMailbox();
          else if (!success) return fail();
          else if (phase === "login") findMailbox();
          else startIdle();
          continue;
        }
        if (phase === "list" && !discoveredMailbox) {
          const mailbox = allMailBox([response]);
          if (mailbox && !/[\r\n\0]/.test(mailbox)) discoveredMailbox = mailbox;
        }
        if (phase === "idle-start" && line.startsWith("+")) {
          phase = "idling";
          clearCommand();
          retry = minRetry;
          renewTimer = setTimeout(() => {
            renewTimer = null;
            if (stopped || closed) return;
            phase = "done";
            write("DONE\r\n");
          }, renewMs);
          renewTimer.unref();
          if (!synced) { synced = true; notify(); }
          continue;
        }
        if ((phase === "idle-start" || phase === "idling" || phase === "done") && CHANGE.test(line)) notify();
      }
    });
  }

  open();
  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      closeCurrent?.();
    },
  };
}
