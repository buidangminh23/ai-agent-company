import assert from "node:assert/strict";
import test from "node:test";
import type { MailAccount, MailMessage } from "../shared/inbox.ts";
import { labelColor, labelKey, labelRows, labelUrl, mergeLabels, messageChips } from "./mail-labels.ts";

function mail(id: string, at: string, extra: Partial<MailMessage> = {}): MailMessage {
  return { id, from: "A", subject: "S", at, url: "", unread: true, ...extra };
}

function account(address: string, labels: MailAccount["labels"]): MailAccount {
  return { address, connected: true, note: "", unread: 0, unreadAll: 0, recent: [], url: `https://mail.google.com/mail/?authuser=${address}#inbox`, labels };
}

const accounts = [
  account("a@gmail.com", [
    { path: "university", unread: 11, total: 289, recent: [mail("a:L1.1", "2026-10-30T01:00:00Z"), mail("a:L1.2", "2026-10-31T01:00:00Z")] },
    { path: "university/Rewards", unread: 0, total: 10, recent: [] },
    { path: "Hoá đơn", unread: 0, total: 55, recent: [] },
  ]),
  account("b@gmail.com", [{ path: "University", unread: 8, total: 84, recent: [mail("b:L1.9", "2026-10-30T12:00:00Z"), mail("a:L1.2", "2026-10-31T01:00:00Z")] }]),
];

test("labels merge across accounts by case-insensitive path, sorted and nested", () => {
  const nodes = mergeLabels(accounts);
  assert.deepEqual(nodes.map((node) => [node.path, node.name, node.depth, node.unread, node.total]), [
    ["Hoá đơn", "Hoá đơn", 0, 0, 55],
    ["university", "university", 0, 19, 373],
    ["university/Rewards", "Rewards", 1, 0, 10],
  ]);
  assert.equal(nodes[1].url, "https://mail.google.com/mail/?authuser=a@gmail.com#label/university");
  assert.equal(labelUrl(accounts[0].url, "Hoá đơn"), "https://mail.google.com/mail/?authuser=a@gmail.com#label/Ho%C3%A1+%C4%91%C6%A1n");
  assert.equal(labelColor("University"), labelColor("university"));
});

test("a label view lists mail from every account newest first without duplicates", () => {
  const rows = labelRows(accounts, labelKey("UNIVERSITY"));
  assert.deepEqual(rows.map((row) => [row.message.id, row.account]), [["a:L1.2", 0], ["b:L1.9", 1], ["a:L1.1", 0]]);
});

test("row chips hide the open label, cap at two, and fall back to a suggestion", () => {
  const tagged = mail("x", "2026-10-30T01:00:00Z", { labels: ["work", "Hoá đơn", "git", "vercel"] });
  assert.deepEqual(messageChips(tagged, labelKey("hoá đơn")).chips.map((chip) => chip.name), ["work", "git"]);
  assert.equal(messageChips(tagged, labelKey("hoá đơn")).more, 1);
  const guess = messageChips(mail("y", "2026-10-30T01:00:00Z", { suggested: "payment" }), null);
  assert.deepEqual(guess, { chips: [{ name: "payment", color: labelColor("payment"), suggested: true }], more: 0 });
  assert.deepEqual(messageChips(mail("z", "2026-10-30T01:00:00Z", { labels: ["git"], suggested: "payment" }), null).chips.map((chip) => chip.suggested), [false]);
});
