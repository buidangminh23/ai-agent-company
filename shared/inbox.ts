export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  at: string;
  url: string;
  unread: boolean;
  fromAddress?: string;
  labels?: string[];
  suggested?: string;
}

export interface MailLabel {
  path: string;
  unread: number;
  total: number;
  recent: MailMessage[];
}

export interface MailContent {
  id: string;
  account: string;
  from: string;
  to: string;
  subject: string;
  at: string;
  url: string;
  html: string | null;
  text: string | null;
  attachments: string[];
  truncated: boolean;
}

export interface MailAccount {
  address: string;
  connected: boolean;
  note: string;
  unread: number | null;
  unreadAll: number | null;
  recent: MailMessage[];
  url: string;
  labels?: MailLabel[];
}

export interface CalendarEvent {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description?: string;
  local?: boolean;
}

export interface CalendarFeed {
  label: string;
  connected: boolean;
  note: string;
}

export interface InboxSnapshot {
  configured: boolean;
  fetchedAt: string | null;
  accounts: MailAccount[];
  calendars: CalendarFeed[];
  events: CalendarEvent[];
}

export const EMPTY_INBOX: InboxSnapshot = { configured: false, fetchedAt: null, accounts: [], calendars: [], events: [] };

export function inboxContentKey(value: InboxSnapshot): string {
  return JSON.stringify([value.configured, value.accounts, value.calendars, value.events]);
}

export function mergeMailAccount(snapshot: InboxSnapshot, account: MailAccount, at: string): InboxSnapshot {
  const previous = snapshot.accounts.find((entry) => entry.address === account.address);
  const merged = account.labels === undefined && previous?.labels ? { ...account, labels: previous.labels } : account;
  return { ...snapshot, configured: true, fetchedAt: at, accounts: previous ? snapshot.accounts.map((entry) => entry.address === account.address ? merged : entry) : [...snapshot.accounts, merged] };
}
