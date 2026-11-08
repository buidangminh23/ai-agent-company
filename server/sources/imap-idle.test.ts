import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type tls from "node:tls";
import { watchMailbox } from "./imap-idle.ts";

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  serve(line: string): void {
    this.emit("data", Buffer.from(`${line}\r\n`));
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(): this {
    return this;
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
  lastTag(): string {
    return this.written[this.written.length - 1].split(" ")[0];
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const account = { address: "me@gmail.com", password: "abcd efgh ijkl mnop" };

function handshake(socket: FakeSocket): void {
  socket.serve("* OK Gimap ready");
  assert.match(socket.written[0], /^i1 LOGIN "me@gmail.com" "abcdefghijklmnop"\r\n$/);
  socket.serve("i1 OK authenticated");
  assert.equal(socket.written[1], "i2 EXAMINE INBOX\r\n");
  socket.serve("* 12 EXISTS");
  socket.serve("i2 OK [READ-ONLY] done");
  assert.equal(socket.written[2], "i3 IDLE\r\n");
  socket.serve("+ idling");
}

test("idle refreshes after connecting, reports mailbox changes and renews before Gmail times out", async () => {
  const sockets: FakeSocket[] = [];
  let changes = 0;
  const watcher = watchMailbox(account, () => changes++, { renewMs: 30, connect: () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as tls.TLSSocket; } });
  handshake(sockets[0]);
  assert.equal(changes, 1);
  sockets[0].serve("* 13 EXISTS");
  sockets[0].serve("* 4 EXPUNGE");
  assert.equal(changes, 3);
  await wait(60);
  assert.equal(sockets[0].written[3], "DONE\r\n");
  sockets[0].serve("i3 OK idle done");
  assert.equal(sockets[0].written[4], "i4 IDLE\r\n");
  watcher.stop();
  assert.equal(sockets.length, 1);
});

test("idle reconnects with backoff after a dropped or rejected connection", async () => {
  const sockets: FakeSocket[] = [];
  const watcher = watchMailbox(account, () => {}, { minRetryMs: 10, maxRetryMs: 40, connect: () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as tls.TLSSocket; } });
  handshake(sockets[0]);
  sockets[0].destroy();
  await wait(30);
  assert.equal(sockets.length, 2);
  sockets[1].serve("* OK ready");
  sockets[1].serve("i1 NO [AUTHENTICATIONFAILED] Invalid credentials");
  assert.equal(sockets[1].destroyed, true);
  await wait(40);
  assert.equal(sockets.length, 3);
  watcher.stop();
  await wait(60);
  assert.equal(sockets.length, 3);
});

test("reconnecting resyncs mail changed while disconnected, and BYE reconnects without waiting for socket close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: FakeSocket[] = [];
  let changes = 0;
  const watcher = watchMailbox(account, () => changes++, { minRetryMs: 10, connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as tls.TLSSocket; } });
  try {
    handshake(sockets[0]);
    assert.equal(changes, 1);
    sockets[0].serve("* BYE server maintenance");
    assert.equal(sockets[0].destroyed, true);
    sockets[0].serve("* 14 EXISTS");
    assert.equal(changes, 1);
    t.mock.timers.tick(10);
    assert.equal(sockets.length, 2);
    handshake(sockets[1]);
    assert.equal(changes, 2);
  } finally { watcher.stop(); }
});

test("unsolicited flag changes are captured before the IDLE continuation and while renewing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new FakeSocket();
  let changes = 0;
  const watcher = watchMailbox(account, () => changes++, { renewMs: 30, connect: () => socket as unknown as tls.TLSSocket });
  try {
    handshake(socket);
    socket.serve("* 3 FETCH (FLAGS (\\Seen))");
    t.mock.timers.tick(30);
    assert.equal(socket.written.at(-1), "DONE\r\n");
    socket.serve("* 4 EXPUNGE");
    socket.serve("i3 OK idle done");
    socket.serve("* 12 EXISTS");
    socket.serve("* 2 FETCH (FLAGS ())");
    socket.serve("+ idling");
    assert.equal(changes, 5);
    assert.equal(socket.written.at(-1), "i4 IDLE\r\n");
  } finally { watcher.stop(); }
});

test("stopping an active watcher clears renewal and command timers and ignores stale socket events", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let connects = 0;
  let changes = 0;
  const socket = new FakeSocket();
  const watcher = watchMailbox(account, () => changes++, { renewMs: 20, commandTimeoutMs: 30, minRetryMs: 5, connect: () => { connects++; return socket as unknown as tls.TLSSocket; } });
  handshake(socket);
  watcher.stop();
  socket.serve("* 13 EXISTS");
  socket.emit("error", new Error("late socket error"));
  t.mock.timers.tick(1000);
  assert.equal(changes, 1);
  assert.equal(connects, 1);
  assert.equal(socket.written.length, 3);
  assert.equal(socket.destroyed, true);
});

test("a stalled greeting or DONE acknowledgement reconnects on the command deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: FakeSocket[] = [];
  const watcher = watchMailbox(account, () => {}, { renewMs: 20, commandTimeoutMs: 30, minRetryMs: 5, connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as tls.TLSSocket; } });
  try {
    t.mock.timers.tick(30);
    assert.equal(sockets[0].destroyed, true);
    t.mock.timers.tick(5);
    handshake(sockets[1]);
    t.mock.timers.tick(20);
    assert.equal(sockets[1].written.at(-1), "DONE\r\n");
    t.mock.timers.tick(30);
    assert.equal(sockets[1].destroyed, true);
    t.mock.timers.tick(5);
    assert.equal(sockets.length, 3);
  } finally { watcher.stop(); }
});

test("synchronous connection failure backs off and PREAUTH does not attempt a second login", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new FakeSocket();
  let attempts = 0;
  let changes = 0;
  const watcher = watchMailbox(account, () => changes++, { minRetryMs: 10, connect: () => { if (++attempts === 1) throw new Error("network unavailable"); return socket as unknown as tls.TLSSocket; } });
  try {
    assert.equal(attempts, 1);
    t.mock.timers.tick(10);
    socket.serve("* PREAUTH already authenticated");
    assert.equal(socket.written[0], "i1 EXAMINE INBOX\r\n");
    socket.serve("i1 OK selected");
    socket.serve("+ idling");
    assert.equal(changes, 1);
    assert.equal(socket.written.some(command => command.includes("LOGIN")), false);
  } finally { watcher.stop(); }
});

test("an early IDLE completion clears the previous renewal timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new FakeSocket();
  const watcher = watchMailbox(account, () => {}, { renewMs: 30, connect: () => socket as unknown as tls.TLSSocket });
  try {
    handshake(socket);
    t.mock.timers.tick(20);
    socket.serve("i3 OK idle ended");
    socket.serve("+ idling");
    t.mock.timers.tick(10);
    assert.equal(socket.written.at(-1), "i4 IDLE\r\n");
    t.mock.timers.tick(20);
    assert.equal(socket.written.at(-1), "DONE\r\n");
    assert.equal(socket.written.filter(command => command === "DONE\r\n").length, 1);
  } finally { watcher.stop(); }
});

test("all-mail watcher discovers the localized raw mailbox by its special-use flag", () => {
  const socket = new FakeSocket();
  let changes = 0;
  const watcher = watchMailbox(account, () => changes++, { allMail: true, connect: () => socket as unknown as tls.TLSSocket });
  try {
    socket.serve("* OK ready");
    socket.serve("i1 OK authenticated");
    assert.equal(socket.written[1], 'i2 LIST "" "*"\r\n');
    socket.serve('* LIST (\\HasNoChildren) "/" "INBOX"');
    socket.serve('* LIST (\\HasNoChildren \\All) "/" "[Gmail]/T&AMM-t c&HgM- th&AbA-"');
    socket.serve("i2 OK listed");
    assert.equal(socket.written[2], 'i3 EXAMINE "[Gmail]/T&AMM-t c&HgM- th&AbA-"\r\n');
    socket.serve("i3 OK selected");
    socket.serve("+ idling");
    socket.serve("* 4 FETCH (FLAGS (\\Seen) X-GM-LABELS ())");
    assert.equal(changes, 2);
  } finally { watcher.stop(); }
});

test("all-mail discovery handles literal names and PREAUTH", () => {
  const socket = new FakeSocket();
  const watcher = watchMailbox(account, () => {}, { allMail: true, connect: () => socket as unknown as tls.TLSSocket });
  try {
    socket.serve("* PREAUTH ready");
    assert.equal(socket.written[0], 'i1 LIST "" "*"\r\n');
    const mailbox = '[Gmail]/Tous les messages';
    socket.emit("data", Buffer.from(`* LIST (\\All) "/" {${Buffer.byteLength(mailbox)}}\r\n${mailbox}\r\n`));
    socket.serve("i1 OK listed");
    assert.equal(socket.written[1], 'i2 EXAMINE "[Gmail]/Tous les messages"\r\n');
  } finally { watcher.stop(); }
});

test("all-mail watcher falls back to INBOX when LIST fails or the special mailbox is absent", () => {
  for (const response of ["i2 NO list unavailable", "i2 BAD list unsupported", "i2 OK listed"]) {
    const socket = new FakeSocket();
    const watcher = watchMailbox(account, () => {}, { allMail: true, connect: () => socket as unknown as tls.TLSSocket });
    try {
      socket.serve("* OK ready");
      socket.serve("i1 OK authenticated");
      socket.serve('* LIST (\\HasNoChildren) "/" "INBOX"');
      socket.serve(response);
      assert.equal(socket.written[2], "i3 EXAMINE INBOX\r\n");
      assert.equal(socket.destroyed, false);
      socket.serve("i3 OK selected");
      assert.equal(socket.written[3], "i4 IDLE\r\n");
    } finally { watcher.stop(); }
  }
});

test("an unavailable discovered all-mail mailbox falls back once, without a reconnect loop", () => {
  const socket = new FakeSocket();
  const watcher = watchMailbox(account, () => {}, { allMail: true, connect: () => socket as unknown as tls.TLSSocket });
  try {
    socket.serve("* PREAUTH ready");
    socket.serve('* LIST (\\All) "/" "[Gmail]/All Mail"');
    socket.serve("i1 OK listed");
    socket.serve("i2 NO mailbox unavailable");
    assert.equal(socket.written[2], "i3 EXAMINE INBOX\r\n");
    socket.serve("i3 OK selected");
    assert.equal(socket.written[3], "i4 IDLE\r\n");
    assert.equal(socket.destroyed, false);
  } finally { watcher.stop(); }
});
