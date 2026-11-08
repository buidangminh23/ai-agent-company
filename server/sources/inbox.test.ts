import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { setImmediate as settle } from "node:timers/promises";
import type tls from "node:tls";
import { expandEvents, parseCalendar, parseDuration, zonedToUtc } from "./ical.ts";
import { ResponseReader, allMailBox, decodeMailbox, decodeWords, gmailUrl, isHiddenLabel, messageId, parseFetch, parseGmailLabels, parseHeaders, parseInternalDate, parseLabelList, parseMessageRef, quote, readLabels, readMailbox, readMessage, readMessages, closeMailSessions, searchIds, senderName, senderQueries, suggestLabels } from "./imap.ts";
import { EMPTY_INBOX, inboxContentKey, mergeMailAccount, type InboxSnapshot, type MailAccount } from "../../shared/inbox.ts";
import { calendarIdFromUrl, MailSync, parseAccounts, parseCalendarUrls, vietnamDayStart } from "./inbox.ts";

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Cá nhân\r\nX-WR-TIMEZONE:Asia/Ho_Chi_Minh\r\n${body}END:VCALENDAR\r\n`;
const day = Date.parse("2026-10-30T17:00:00Z");
const week = day + 7 * 86_400_000;

test("encoded words decode across split UTF-8 base64 chunks and drop whitespace between words", () => {
  const bytes = Buffer.from("Hóa đơn tháng 10", "utf8");
  const a = bytes.subarray(0, 2).toString("base64");
  const b = bytes.subarray(2).toString("base64");
  assert.equal(decodeWords(`=?UTF-8?B?${a}?= =?UTF-8?B?${b}?=`), "Hóa đơn tháng 10");
  assert.equal(decodeWords("Re: =?utf-8?Q?Gi=E1=BA=A5y_m=E1=BB=9Di?= now"), "Re: Giấy mời now");
  assert.equal(decodeWords("=?iso-8859-1?Q?caf=E9?="), "café");
  assert.equal(decodeWords("plain subject"), "plain subject");
});

test("headers unfold and sender shows the display name or the address", () => {
  const headers = parseHeaders("From: \"Vercel\" <notifications@vercel.com>\r\nSubject: Deploy\r\n failed\r\n");
  assert.equal(headers.subject, "Deploy failed");
  assert.equal(senderName(headers.from), "Vercel");
  assert.equal(senderName("<a@b.com>"), "a@b.com");
  assert.equal(senderName("a@b.com"), "a@b.com");
});

test("internal dates convert to UTC ISO", () => {
  assert.equal(parseInternalDate("31-Oct-2026 21:05:09 +0700"), "2026-10-31T14:05:09.000Z");
  assert.equal(parseInternalDate(" 1-Nov-2026 00:00:00 -0130"), "2026-11-01T01:30:00.000Z");
  assert.equal(parseInternalDate("bad"), null);
});

test("response reader joins literals and splits tagged lines across chunks", () => {
  const reader = new ResponseReader();
  const header = "From: A <a@x.com>\r\nSubject: Hi\r\n\r\n";
  const raw = `* SEARCH 4 9 12\r\n* 3 FETCH (UID 12 INTERNALDATE "31-Oct-2026 10:00:00 +0000" FLAGS (\\Seen \\Flagged) X-GM-THRID 1846210012345678901 BODY[HEADER.FIELDS (FROM SUBJECT)] {${Buffer.byteLength(header)}}\r\n${header})\r\nm4 OK done\r\n`;
  const buffer = Buffer.from(raw);
  for (let i = 0; i < buffer.length; i += 7) reader.push(buffer.subarray(i, i + 7));
  const responses = reader.drain();
  assert.equal(responses.length, 3);
  assert.deepEqual(searchIds(responses), [4, 9, 12]);
  const [message] = parseFetch(responses, "me@gmail.com");
  assert.equal(message.subject, "Hi");
  assert.equal(message.from, "A");
  assert.equal(message.unread, false);
  assert.equal(message.at, "2026-10-31T10:00:00.000Z");
  assert.equal(message.url, `https://mail.google.com/mail/?authuser=me%40gmail.com#all/${BigInt("1846210012345678901").toString(16)}`);
  assert.equal(responses[2].line, "m4 OK done");
});

test("quote escapes IMAP strings and Gmail links fall back to the inbox", () => {
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(gmailUrl("me@gmail.com"), "https://mail.google.com/mail/?authuser=me%40gmail.com#inbox");
});

test("account and calendar settings parse multiple entries without duplicates", () => {
  assert.deepEqual(parseAccounts("A@gmail.com:abcd efgh ijkl mnop, b@gmail.com:qrstuvwxyzabcdef,a@gmail.com:zzz,broken"), [
    { address: "a@gmail.com", password: "abcdefghijklmnop" },
    { address: "b@gmail.com", password: "qrstuvwxyzabcdef" },
  ]);
  assert.deepEqual(parseCalendarUrls("https://x/a.ics, http://bad, https://x/a.ics"), ["https://x/a.ics"]);
  assert.equal(calendarIdFromUrl("https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics"), "me@gmail.com");
});

test("Vietnam day start and zone conversion", () => {
  assert.equal(new Date(vietnamDayStart(Date.parse("2026-10-31T05:00:00Z"))).toISOString(), "2026-10-30T17:00:00.000Z");
  assert.equal(new Date(zonedToUtc(Date.UTC(2026, 6, 1, 9), "Europe/London")).toISOString(), "2026-07-01T08:00:00.000Z");
  assert.equal(new Date(zonedToUtc(Date.UTC(2026, 11, 1, 9), "Europe/London")).toISOString(), "2026-12-01T09:00:00.000Z");
  assert.equal(parseDuration("PT1H30M"), 5_400_000);
  assert.equal(parseDuration("P1D"), 86_400_000);
});

test("single, all-day, UTC and cancelled events land in the window", () => {
  const calendar = parseCalendar(ics([
    "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Họp team\\, sprint\r\nDTSTART;TZID=Asia/Ho_Chi_Minh:20261031T090000\r\nDTEND;TZID=Asia/Ho_Chi_Minh:20261031T100000\r\nLOCATION:Phòng 1\r\nBEGIN:VALARM\r\nSUMMARY:Alarm\r\nEND:VALARM\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Sinh nhật\r\nDTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Call\r\nDTSTART:20261102T020000Z\r\nDURATION:PT30M\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Bỏ\r\nSTATUS:CANCELLED\r\nDTSTART:20261102T020000Z\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:Old\r\nDTSTART:20250102T020000Z\r\nEND:VEVENT\r\n",
  ].join("")));
  assert.equal(calendar.name, "Cá nhân");
  const events = expandEvents(calendar, calendar.name, day, week);
  assert.deepEqual(events.map((event) => [event.title, event.start, event.end, event.allDay]), [
    ["Họp team, sprint", "2026-10-31T02:00:00.000Z", "2026-10-31T03:00:00.000Z", false],
    ["Sinh nhật", "2026-10-31T17:00:00.000Z", "2026-11-01T17:00:00.000Z", true],
    ["Call", "2026-11-02T02:00:00.000Z", "2026-11-02T02:30:00.000Z", false],
  ]);
  assert.equal(events[0].location, "Phòng 1");
});

test("weekly rules expand with exdates, overrides, counts and until", () => {
  const calendar = parseCalendar(ics([
    "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Standup\r\nDTSTART;TZID=Asia/Ho_Chi_Minh:20260105T083000\r\nDTEND;TZID=Asia/Ho_Chi_Minh:20260105T084500\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\nEXDATE;TZID=Asia/Ho_Chi_Minh:20261104T083000\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:w\r\nRECURRENCE-ID;TZID=Asia/Ho_Chi_Minh:20261102T083000\r\nSUMMARY:Standup dời\r\nDTSTART;TZID=Asia/Ho_Chi_Minh:20261102T100000\r\nDTEND;TZID=Asia/Ho_Chi_Minh:20261102T101500\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Count\r\nDTSTART:20261029T010000Z\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:u\r\nSUMMARY:Until\r\nDTSTART:20261030T010000Z\r\nRRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261103T010000Z\r\nEND:VEVENT\r\n",
  ].join("")));
  const events = expandEvents(calendar, "Lịch", day, week);
  const list = (title: string) => events.filter((event) => event.title === title).map((event) => event.start);
  assert.deepEqual(list("Standup"), ["2026-11-06T01:30:00.000Z"]);
  assert.deepEqual(list("Standup dời"), ["2026-11-02T03:00:00.000Z"]);
  assert.deepEqual(list("Count"), ["2026-10-31T01:00:00.000Z", "2026-11-01T01:00:00.000Z"]);
  assert.deepEqual(list("Until"), ["2026-11-01T01:00:00.000Z", "2026-11-03T01:00:00.000Z"]);
});

test("monthly and yearly rules pick ordinal weekdays and month days", () => {
  const calendar = parseCalendar(ics([
    "BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:Review\r\nDTSTART:20260106T020000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=1TU\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:l\r\nSUMMARY:Lương\r\nDTSTART;VALUE=DATE:20260131\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1\r\nEND:VEVENT\r\n",
    "BEGIN:VEVENT\r\nUID:y\r\nSUMMARY:Kỷ niệm\r\nDTSTART;VALUE=DATE:20201105\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\n",
  ].join("")));
  const events = expandEvents(calendar, "Lịch", day, week);
  assert.deepEqual(events.map((event) => [event.title, event.start]), [
    ["Lương", "2026-10-30T17:00:00.000Z"],
    ["Review", "2026-11-03T02:00:00.000Z"],
    ["Kỷ niệm", "2026-11-04T17:00:00.000Z"],
  ]);
});

test("mime picks the html part, decodes charset and transfer encoding, and lists attachments", async () => {
  const { parseMime } = await import("./mime.ts");
  const html = Buffer.from("<p>Xin chào sếp</p>", "utf8").toString("base64");
  const raw = [
    "From: =?UTF-8?B?" + Buffer.from("Demo Sender", "utf8").toString("base64") + "?= <a@b.com>",
    "Subject: Test",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Xin ch=C3=A0o s=E1=BA=BFp",
    "--inner",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    html,
    "--inner--",
    "--outer",
    'Content-Type: application/pdf; name="hoa-don.pdf"',
    "Content-Disposition: attachment; filename=\"hoa-don.pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0=",
    "--outer--",
    "",
  ].join("\r\n");
  const mime = parseMime(Buffer.from(raw, "utf8"));
  assert.equal(mime.headers.from, "Demo Sender <a@b.com>");
  assert.equal(mime.html, "<p>Xin chào sếp</p>");
  assert.equal(mime.text, "Xin chào sếp");
  assert.deepEqual(mime.attachments, ["hoa-don.pdf"]);
});

test("message ids resolve only configured accounts and numeric uids", async () => {
  const { parseMessageId } = await import("./inbox.ts");
  const accounts = parseAccounts("a@gmail.com:abcdabcdabcdabcd");
  assert.deepEqual(parseMessageId("a@gmail.com:42", accounts), { account: accounts[0], uid: 42, box: "INBOX" });
  assert.equal(parseMessageId("b@gmail.com:42", accounts), null);
  assert.equal(parseMessageId("a@gmail.com:4 2", accounts), null);
  assert.equal(parseMessageId("a@gmail.com:", accounts), null);
});

test("Gmail label names decode from modified UTF-7 and system or address labels stay hidden", () => {
  assert.equal(decodeMailbox("Ho&AOE- &AREBoQ-n"), "Hoá đơn");
  assert.equal(decodeMailbox("T&AOA-i kho&HqM-n"), "Tài khoản");
  assert.equal(decodeMailbox("R&-D"), "R&D");
  assert.equal(isHiddenLabel("owner.alias@gmail.com"), true);
  assert.equal(isHiddenLabel("owner.alias@gmail.com/Hóa đơn"), true);
  assert.equal(isHiddenLabel("[Gmail]/Thư đã gửi"), true);
  assert.equal(isHiddenLabel("work"), false);
  const list = [
    '* LIST (\HasNoChildren) "/" "INBOX"',
    '* LIST (\HasChildren \Noselect) "/" "[Gmail]"',
    '* LIST (\All \HasNoChildren) "/" "[Gmail]/All Mail"',
    '* LIST (\HasNoChildren) "/" "owner.alias@gmail.com"',
    '* LIST (\HasChildren) "/" "university"',
    '* LIST (\HasNoChildren) "/" "university/Rewards"',
    '* LIST (\HasNoChildren) "/" "Ho&AOE- &AREBoQ-n"',
    '* LIST (\HasNoChildren) "/" vercel',
  ].map((line) => ({ line, literals: [] }));
  assert.deepEqual(parseLabelList(list), [
    { raw: "Ho&AOE- &AREBoQ-n", path: "Hoá đơn" },
    { raw: "university", path: "university" },
    { raw: "university/Rewards", path: "university/Rewards" },
    { raw: "vercel", path: "vercel" },
  ]);
});

test("message labels come from X-GM-LABELS and label message ids round-trip their mailbox", () => {
  assert.deepEqual(parseGmailLabels('* 4 FETCH (UID 9 X-GM-LABELS ("\\\\Important" \\Inbox work "Ho&AOE- &AREBoQ-n" "a@b.com") FLAGS ())'), ["work", "Hoá đơn"]);
  assert.deepEqual(parseGmailLabels("* 4 FETCH (UID 9 X-GM-LABELS () FLAGS ())"), []);
  const id = messageId("me@gmail.com", "Ho&AOE- &AREBoQ-n", 77);
  assert.match(id, /^me@gmail\.com:L[0-9a-f]+\.77$/);
  assert.deepEqual(parseMessageRef(id.slice("me@gmail.com:".length)), { box: "Ho&AOE- &AREBoQ-n", uid: 77 });
  assert.deepEqual(parseMessageRef("42"), { box: "INBOX", uid: 42 });
  assert.equal(parseMessageRef("Lzz.1"), null);
  assert.equal(parseMessageRef(`L${Buffer.from("a\r\nb").toString("hex")}.1`), null);
  const header = "From: Vercel <ship@vercel.com>\r\nSubject: Deploy\r\n\r\n";
  const [message] = parseFetch([{ line: '* 1 FETCH (UID 5 FLAGS () INTERNALDATE "01-Nov-2026 09:00:00 +0700" X-GM-LABELS (vercel) BODY[HEADER.FIELDS (FROM SUBJECT)] \u0000)', literals: [Buffer.from(header)] }], "me@gmail.com", "vercel");
  assert.equal(message.id, messageId("me@gmail.com", "vercel", 5));
  assert.equal(message.fromAddress, "ship@vercel.com");
  assert.deepEqual(message.labels, ["vercel"]);
});

test("unlabelled mail gets a label suggestion from the sender's or the company domain's history", () => {
  const at = "2026-11-01T00:00:00.000Z";
  const mail = (id: string, fromAddress: string, labels?: string[]) => ({ id, from: fromAddress, subject: "s", at, url: "", unread: true, fromAddress, ...(labels ? { labels } : {}) });
  const history = [
    mail("1", "ship@vercel.com", ["vercel"]),
    mail("2", "billing@vercel.com", ["vercel", "Hoá đơn"]),
    mail("3", "billing@vercel.com", ["Hoá đơn"]),
    mail("4", "teacher@uni.example.edu", ["university"]),
    mail("5", "friend@gmail.com", ["Tài khoản"]),
  ];
  const inbox = [
    mail("a", "ship@vercel.com"),
    mail("b", "news@uni.example.edu"),
    mail("c", "other@gmail.com"),
    mail("d", "ship@vercel.com", ["work"]),
    mail("e", "team@vercel.com"),
  ];
  const out = suggestLabels(inbox, history);
  assert.equal(out[0].suggested, "vercel");
  assert.equal(out[1].suggested, undefined);
  assert.equal(out[2].suggested, undefined);
  assert.equal(out[3].suggested, undefined);
  assert.equal(out[4].suggested, undefined);
  const more = suggestLabels([mail("f", "news@uni.example.edu")], [...history, mail("6", "staff@uni.example.edu", ["university"])]);
  assert.equal(more[0].suggested, "university");
});

test("the All Mail box is found by its special-use flag whatever its localized name", () => {
  const list = (line: string) => ({ line, literals: [] as Buffer[] });
  assert.equal(allMailBox([list('* LIST (\\HasNoChildren) "/" "INBOX"'), list('* LIST (\\All \\HasNoChildren) "/" "[Gmail]/T&AOk-t c&AOM- th&AbA-"')]), "[Gmail]/T&AOk-t c&AOM- th&AbA-");
  assert.equal(allMailBox([list('* LIST (\\HasNoChildren) "/" "INBOX"')]), null);
});

test("sender queries dedupe, drop malformed addresses and split into batches", () => {
  assert.deepEqual(senderQueries(["A@x.com", "a@x.com", "bad", 'q"@x.com', "b@y.vn"], 1), ["from:(a@x.com)", "from:(b@y.vn)"]);
  assert.deepEqual(senderQueries([]), []);
  assert.equal(senderQueries(["a@x.com", "b@x.com"])[0], "from:(a@x.com OR b@x.com)");
});

class MailSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(value: string): boolean { this.written.push(value); return true; }
  end(value: string): void { this.write(value); }
  destroy(): void { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
  serve(value: string): void { this.emit("data", Buffer.from(`${value}\r\n`)); }
  complete(lines = ""): void {
    const tag = this.written.at(-1)!.split(" ")[0];
    this.serve(`${lines ? `${lines}\r\n` : ""}${tag} OK done`);
  }
}

const mailCredentials = { address: "test@gmail.com", password: "test-password" };

test("healthy label commands may take longer overall than one command deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new MailSocket();
  const reading = readLabels(mailCredentials, { timeoutMs: 20, connect: () => socket as unknown as tls.TLSSocket });
  socket.serve("* OK ready");
  await settle();
  for (const response of ["", '* LIST (\\HasNoChildren) "/" "Work"', "* 3 EXISTS", '* STATUS "Work" (UNSEEN 2)', ""]) {
    t.mock.timers.tick(15);
    socket.complete(response);
    await settle();
  }
  const labels = await reading;
  assert.equal(labels[0].unread, 2);
  assert.equal(labels[0].total, 3);
  assert.equal(socket.written.some((command) => command.includes("UID SEARCH")), false);
});

test("a stalled command still times out after earlier commands completed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new MailSocket();
  const reading = readLabels(mailCredentials, { timeoutMs: 20, connect: () => socket as unknown as tls.TLSSocket });
  const rejected = assert.rejects(reading, /không phản hồi kịp/);
  socket.serve("* OK ready");
  await settle();
  t.mock.timers.tick(15);
  socket.complete();
  await settle();
  t.mock.timers.tick(21);
  await rejected;
  assert.equal(socket.destroyed, true);
});

test("label scan has a total budget even with a longer per-command timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new MailSocket();
  const reading = readLabels(mailCredentials, { timeoutMs: 120_000, connect: () => socket as unknown as tls.TLSSocket });
  const rejected = assert.rejects(reading, /closed/);
  socket.serve("* OK ready");
  await settle();
  socket.complete();
  await settle();
  t.mock.timers.tick(60_001);
  await rejected;
});

test("primary mail publishes before slow labels and completed labels publish afterward", async () => {
  const sockets: MailSocket[] = [];
  const updates: MailAccount[] = [];
  let finished = false;
  const reading = readMailbox(mailCredentials, {
    connect: () => { const socket = new MailSocket(); sockets.push(socket); return socket as unknown as tls.TLSSocket; },
    onUpdate: (account) => updates.push(account),
  }).then((account) => { finished = true; return account; });
  for (const socket of sockets) socket.serve("* OK ready");
  await settle();
  for (const socket of sockets) socket.complete();
  await settle();
  const primary = sockets[0];
  for (const response of ["* 0 EXISTS", "* SEARCH", "* SEARCH"]) {
    primary.complete(response);
    await settle();
  }
  assert.equal(updates.length, 1);
  assert.equal(updates[0].connected, true);
  assert.equal(updates[0].labels, undefined);
  assert.equal(finished, false);
  sockets[1].complete();
  const account = await reading;
  assert.equal(updates.length, 2);
  assert.deepEqual(account.labels, []);
});

test("inbox includes new mail outside Gmail Primary and counts all unread inbox mail", async () => {
  const socket = new MailSocket();
  const reading = readMailbox(mailCredentials, { includeLabels: false, connect: () => socket as unknown as tls.TLSSocket });
  socket.serve("* OK ready");
  await settle();
  socket.complete();
  await settle();
  socket.complete("* 2 EXISTS");
  await settle();
  assert.match(socket.written.at(-1)!, /UID SEARCH UNSEEN/);
  socket.complete("* SEARCH 2");
  await settle();
  assert.match(socket.written.at(-1)!, /UID SEARCH ALL/);
  socket.complete("* SEARCH 1 2");
  await settle();
  assert.match(socket.written.at(-1)!, /UID FETCH 1,2/);
  const header = "From: Updates <updates@example.com>\r\nSubject: New update\r\n";
  socket.complete(`* 2 FETCH (UID 2 FLAGS () INTERNALDATE "02-Nov-2026 12:00:00 +0000" BODY[HEADER.FIELDS (FROM SUBJECT)] {${Buffer.byteLength(header)}}\r\n${header})`);
  const result = await reading;
  assert.equal(result.connected, true);
  assert.equal(result.unread, 1);
  assert.equal(result.unreadAll, 1);
  assert.deepEqual(result.recent.map((mail) => mail.id), ["test@gmail.com:2"]);
  assert.equal(result.recent[0].unread, true);
  assert.equal(socket.written.some((command) => command.includes("category:primary")), false);
});

test("label progress publishes before a later label stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new MailSocket();
  const updates: string[] = [];
  const reading = readLabels(mailCredentials, { timeoutMs: 20, onLabel: (label) => updates.push(label.path), connect: () => socket as unknown as tls.TLSSocket });
  const rejected = assert.rejects(reading, /không phản hồi kịp/);
  socket.serve("* OK ready");
  await settle();
  for (const response of ["", '* LIST (\\HasNoChildren) "/" "A"\r\n* LIST (\\HasNoChildren) "/" "B"', "* 0 EXISTS"]) {
    socket.complete(response);
    await settle();
  }
  assert.deepEqual(updates, ["A"]);
  t.mock.timers.tick(21);
  await rejected;
  assert.deepEqual(updates, ["A"]);
});

test("repeated early label timeouts do not starve labels later in the list", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const credentials = { ...mailCredentials, address: "rotation@gmail.com" };
  const listing = '* LIST (\\HasNoChildren) "/" "A"\r\n* LIST (\\HasNoChildren) "/" "B"';
  const first = new MailSocket();
  const stalled = readLabels(credentials, { timeoutMs: 20, connect: () => first as unknown as tls.TLSSocket });
  const rejected = assert.rejects(stalled, /không phản hồi kịp/);
  first.serve("* OK ready");
  await settle();
  for (const response of ["", listing]) { first.complete(response); await settle(); }
  assert.match(first.written.at(-1)!, /EXAMINE "A"/);
  t.mock.timers.tick(21);
  await rejected;
  const second = new MailSocket();
  const updates: string[] = [];
  const retried = readLabels(credentials, { onLabel: (label) => updates.push(label.path), connect: () => second as unknown as tls.TLSSocket });
  second.serve("* OK ready");
  await settle();
  for (const response of ["", listing]) { second.complete(response); await settle(); }
  assert.match(second.written.at(-1)!, /EXAMINE "B"/);
  second.complete("* 0 EXISTS");
  await settle();
  assert.deepEqual(updates, ["B"]);
  second.complete("* 0 EXISTS");
  assert.deepEqual((await retried).map((label) => label.path), ["A", "B"]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function syncedAccount(address = mailCredentials.address, unread = 0): MailAccount {
  return { address, connected: true, note: "", unread, unreadAll: unread, recent: [], url: "" };
}

test("new-mail refresh bypasses pending label scans and keeps the newest primary result", async () => {
  const labels = deferred<NonNullable<MailAccount["labels"]>>();
  const updates: MailAccount[] = [];
  let reads = 0;
  const sync = new MailSync([mailCredentials], (account) => updates.push(account), {
    readMail: async () => syncedAccount(undefined, ++reads),
    readLabels: () => labels.promise,
  });
  await sync.refresh();
  await sync.refresh(mailCredentials.address, false);
  assert.equal(reads, 2);
  assert.equal(updates.at(-1)?.unread, 2);
  labels.resolve([{ path: "Work", unread: 0, total: 0, recent: [] }]);
  await settle();
  assert.equal(updates.at(-1)?.unread, 2);
  assert.equal(updates.at(-1)?.labels?.[0].path, "Work");
});

test("a busy account cannot block another account and overlapping changes coalesce into a trailing read", async () => {
  const first = deferred<MailAccount>();
  const slow = { ...mailCredentials, address: "slow@gmail.com" };
  let fastReads = 0;
  let slowReads = 0;
  const updates: MailAccount[] = [];
  const sync = new MailSync([slow, mailCredentials], (account) => updates.push(account), {
    readMail: async (account) => account.address === slow.address && ++slowReads === 1 ? first.promise : syncedAccount(account.address, account.address === slow.address ? 1 : ++fastReads),
  });
  const initial = sync.refresh(undefined, false);
  await settle();
  await sync.refresh(mailCredentials.address, false);
  assert.equal(fastReads, 2);
  const queued = sync.refresh(slow.address, false);
  void sync.refresh(slow.address, false);
  assert.equal(slowReads, 1);
  first.resolve(syncedAccount(slow.address));
  await Promise.all([initial, queued]);
  assert.equal(slowReads, 2);
  assert.equal(updates.at(-1)?.unread, 1);
});

test("label errors preserve published progress and future syncs recover without replacing new mail", async () => {
  let scans = 0;
  let reads = 0;
  let errors = 0;
  const updates: MailAccount[] = [];
  const sync = new MailSync([mailCredentials], (account) => updates.push(account), {
    readMail: async () => syncedAccount(undefined, ++reads),
    readLabels: async (_account, onLabel) => {
      scans++;
      const label = { path: "Work", unread: scans, total: scans, recent: [] };
      onLabel(label);
      if (scans === 1) throw new Error("stalled label");
      return [label];
    },
    onError: () => errors++,
  });
  await sync.refresh();
  await settle();
  assert.equal(updates.at(-1)?.labels?.[0].unread, 1);
  assert.equal(errors, 1);
  await sync.refresh();
  await settle();
  assert.equal(updates.at(-1)?.labels?.[0].unread, 2);
  assert.equal(updates.at(-1)?.unread, 2);
});

test("inbox fingerprints include label content and calendar updates but ignore fetch time", () => {
  const message = { id: "m1", from: "Sender", subject: "Subject", at: "2026-11-02T01:00:00Z", url: "", unread: false, labels: ["Work"] };
  const account: MailAccount = { address: "test@gmail.com", connected: true, note: "", unread: 0, unreadAll: 0, url: "", recent: [message], labels: [{ path: "Work", unread: 0, total: 2, recent: [message, { ...message, id: "m2" }] }] };
  const snapshot: InboxSnapshot = { ...EMPTY_INBOX, configured: true, accounts: [account] };
  assert.equal(inboxContentKey(snapshot), inboxContentKey({ ...snapshot, fetchedAt: "2026-11-02T02:00:00Z" }));
  const changedLabel = structuredClone(snapshot);
  changedLabel.accounts[0].recent[0].labels = ["Invoices"];
  assert.notEqual(inboxContentKey(snapshot), inboxContentKey(changedLabel));
  const changedFlag = structuredClone(snapshot);
  changedFlag.accounts[0].labels![0].recent[1].unread = true;
  assert.notEqual(inboxContentKey(snapshot), inboxContentKey(changedFlag));
  assert.notEqual(inboxContentKey(snapshot), inboxContentKey({ ...snapshot, calendars: [{ label: "Shared", connected: true, note: "Updated" }] }));
});

test("progressive account merge retains other accounts and old labels until a complete replacement", () => {
  const first: MailAccount = { address: "a@gmail.com", connected: true, note: "", unread: 1, unreadAll: 1, recent: [], url: "", labels: [{ path: "Work", unread: 1, total: 1, recent: [] }] };
  const second: MailAccount = { ...first, address: "b@gmail.com" };
  const snapshot: InboxSnapshot = { ...EMPTY_INBOX, accounts: [first, second] };
  const primary = { ...first, unread: 2, labels: undefined };
  const merged = mergeMailAccount(snapshot, primary, "2026-11-02T02:00:00Z");
  assert.deepEqual(merged.accounts.map((account) => account.address), [first.address, second.address]);
  assert.equal(merged.accounts[0].unread, 2);
  assert.deepEqual(merged.accounts[0].labels, first.labels);
  assert.deepEqual(merged.accounts[1], second);
  assert.deepEqual(mergeMailAccount(merged, { ...primary, labels: [] }, "2026-11-02T02:01:00Z").accounts[0].labels, []);
});

const mailBody = (uid: number) => `From: Khach <khach@example.com>\r\nSubject: Mail ${uid}\r\n\r\nHello ${uid}\r\n`;
const fetchedBody = (uid: number) => `* ${uid} FETCH (UID ${uid} INTERNALDATE "02-Nov-2026 12:00:00 +0000" X-GM-THRID 7 BODY[]<0> {${Buffer.byteLength(mailBody(uid))}}\r\n${mailBody(uid)})`;

function pooledSockets(): { sockets: MailSocket[]; connect: () => tls.TLSSocket } {
  const sockets: MailSocket[] = [];
  return { sockets, connect: () => { const socket = new MailSocket(); sockets.push(socket); return socket as unknown as tls.TLSSocket; } };
}

async function greetAndLogin(socket: MailSocket): Promise<void> {
  socket.serve("* OK ready");
  await settle();
  assert.match(socket.written.at(-1)!, /^m\d+ LOGIN /);
  socket.complete();
  await settle();
}

test("opening mail reuses one logged-in Gmail session and skips re-examining the same box", async () => {
  const account = { address: "pool-reuse@gmail.com", password: "test-password" };
  const { sockets, connect } = pooledSockets();
  try {
    const first = readMessage(account, 5, { connect }, "Box");
    await settle();
    await greetAndLogin(sockets[0]);
    assert.match(sockets[0].written.at(-1)!, /EXAMINE "Box"/);
    sockets[0].complete("* 9 EXISTS");
    await settle();
    assert.match(sockets[0].written.at(-1)!, /UID FETCH 5 /);
    sockets[0].complete(fetchedBody(5));
    assert.equal((await first)?.subject, "Mail 5");

    const second = readMessage(account, 6, { connect }, "Box");
    await settle();
    assert.equal(sockets.length, 1);
    assert.match(sockets[0].written.at(-1)!, /UID FETCH 6 /);
    sockets[0].complete(fetchedBody(6));
    const mail = await second;
    assert.equal(mail?.subject, "Mail 6");
    assert.equal(mail?.id, `${account.address}:L426f78.6`);
    assert.equal(sockets[0].written.filter((command) => /LOGIN|EXAMINE/.test(command)).length, 2);
  } finally {
    closeMailSessions();
  }
});

test("a pooled session closed by Gmail is replaced and the read retried once", async () => {
  const account = { address: "pool-retry@gmail.com", password: "test-password" };
  const { sockets, connect } = pooledSockets();
  try {
    const first = readMessage(account, 5, { connect }, "Box");
    await settle();
    await greetAndLogin(sockets[0]);
    sockets[0].complete();
    await settle();
    sockets[0].complete(fetchedBody(5));
    await first;
    sockets[0].destroy();

    const second = readMessage(account, 6, { connect }, "Box");
    await settle();
    assert.equal(sockets.length, 2);
    await greetAndLogin(sockets[1]);
    assert.match(sockets[1].written.at(-1)!, /EXAMINE "Box"/);
    sockets[1].complete();
    await settle();
    sockets[1].complete(fetchedBody(6));
    assert.equal((await second)?.subject, "Mail 6");
  } finally {
    closeMailSessions();
  }
});

test("overlapping reads on one account queue on the same session and batch reads return every body", async () => {
  const account = { address: "pool-queue@gmail.com", password: "test-password" };
  const { sockets, connect } = pooledSockets();
  try {
    const batch = readMessages(account, [5, 6, 5], { connect }, "Box");
    const single = readMessage(account, 7, { connect }, "Box");
    await settle();
    assert.equal(sockets.length, 1);
    await greetAndLogin(sockets[0]);
    sockets[0].complete();
    await settle();
    assert.match(sockets[0].written.at(-1)!, /UID FETCH 5,6 /);
    sockets[0].complete(`${fetchedBody(5)}\r\n${fetchedBody(6)}`);
    assert.deepEqual((await batch).map((mail) => mail.subject), ["Mail 5", "Mail 6"]);
    await settle();
    assert.match(sockets[0].written.at(-1)!, /UID FETCH 7 /);
    sockets[0].complete(fetchedBody(7));
    assert.equal((await single)?.subject, "Mail 7");
    assert.equal(sockets.length, 1);
  } finally {
    closeMailSessions();
  }
});
