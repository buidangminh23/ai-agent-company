param(
  [string[]]$Accounts = @(),
  [string]$EnvFile = "",
  [switch]$Replace,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $EnvFile) { $EnvFile = Join-Path $RepoRoot ".env" }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$EmailPattern = '^[^@\s,:]+@[^@\s,:]+\.[^@\s,:]+$'

function Get-SavedAddresses {
  if (-not (Test-Path $EnvFile)) { return @() }
  $row = Get-Content $EnvFile | Where-Object { $_ -like "MSC_GMAIL_ACCOUNTS=*" } | Select-Object -First 1
  if (-not $row) { return @() }
  @($row.Substring("MSC_GMAIL_ACCOUNTS=".Length).Split(",") | ForEach-Object { $_.Split(":")[0].Trim().ToLower() } | Where-Object { $_ })
}

function Open-Page([string]$Url) {
  if ($NoBrowser) { Write-Host "  Open: $Url"; return }
  if ($IsMacOS) { & open $Url } elseif ($IsLinux) { & xdg-open $Url } else { Start-Process $Url }
}

function Test-GmailLogin([string]$Email, [string]$Password) {
  $env:MSC_PROBE_EMAIL = $Email
  $env:MSC_PROBE_PASS = $Password
  Push-Location $RepoRoot
  try {
    $probeJson = & node --input-type=module -e "import { readMailbox } from './server/sources/imap.ts'; const r = await readMailbox({ address: process.env.MSC_PROBE_EMAIL, password: process.env.MSC_PROBE_PASS }); process.stdout.write(JSON.stringify(r));"
  } finally {
    Pop-Location
    Remove-Item Env:MSC_PROBE_EMAIL, Env:MSC_PROBE_PASS -ErrorAction SilentlyContinue
  }
  if ($LASTEXITCODE -ne 0 -or -not $probeJson) { return [pscustomobject]@{ connected = $false; note = "could not run the Gmail check" } }
  $probeJson | ConvertFrom-Json
}

function Read-AppPassword([string]$Email) {
  Open-Page "https://myaccount.google.com/apppasswords?authuser=$([uri]::EscapeDataString($Email))"
  while ($true) {
    $secure = Read-Host "  App Password for $Email (press Enter to skip this account)" -AsSecureString
    $password = [Net.NetworkCredential]::new("", $secure).Password -replace '\s+', ''
    if (-not $password) { Write-Host "  Skipped $Email."; return $null }
    if ($password.Length -ne 16) { Write-Warning "That is $($password.Length) characters; an App Password has 16. Paste it again."; continue }
    $probe = Test-GmailLogin $Email $password
    if ($probe.connected) {
      Write-Host "  Connected $Email ($($probe.unread) unread in Primary)."
      return $password
    }
    Write-Warning "Gmail rejected ${Email}: $($probe.note). Check the avatar on that page is $Email, then paste a new one."
  }
}

function Read-CalendarFeed([string]$Email) {
  Open-Page "https://calendar.google.com/calendar/u/0/r/settings?authuser=$([uri]::EscapeDataString($Email))"
  while ($true) {
    $secureUrl = Read-Host "  Secret iCal URL for $Email (left menu: your calendar > Integrate calendar; Enter to skip)" -AsSecureString
    $calUrl = [Net.NetworkCredential]::new("", $secureUrl).Password.Trim()
    if (-not $calUrl) { return $null }
    if ($calUrl -notmatch '^https://[^\s,]+$') { Write-Warning "The link must start with https:// and have no spaces or commas."; continue }
    try {
      $res = Invoke-WebRequest -SkipHttpErrorCheck -TimeoutSec 20 -Headers @{ Accept = "text/calendar" } -Uri $calUrl
    } catch {
      Write-Warning "Could not reach that link ($($_.Exception.Message))."; continue
    }
    if ($res.StatusCode -eq 200 -and $res.Content -match 'BEGIN:VCALENDAR') {
      Write-Host "  Connected the calendar of $Email."
      return $calUrl
    }
    Write-Warning "That link did not return a calendar (HTTP $($res.StatusCode)). Copy the 'Secret address in iCal format'."
  }
}

$targets = [System.Collections.Generic.List[string]]::new()
foreach ($raw in ($Accounts -join ",") -split '[,;\s]+') {
  $email = $raw.Trim().ToLower()
  if (-not $email) { continue }
  if ($email -notmatch $EmailPattern) { throw "Invalid email address: $email" }
  if (-not $targets.Contains($email)) { $targets.Add($email) }
}
if ($targets.Count -eq 0) {
  $typed = Read-Host "Gmail addresses to connect, separated by commas"
  foreach ($raw in $typed -split '[,;\s]+') {
    $email = $raw.Trim().ToLower()
    if ($email -and $email -match $EmailPattern -and -not $targets.Contains($email)) { $targets.Add($email) }
  }
}

$saved = if ($Replace) { @() } else { Get-SavedAddresses }
$mailAccounts = [System.Collections.Generic.List[hashtable]]::new()
$calendars = [System.Collections.Generic.List[string]]::new()
$index = 0
foreach ($email in $targets) {
  $index++
  Write-Output ""
  Write-Output "[$index/$($targets.Count)] $email"
  if ($saved -contains $email) {
    Write-Output "  Gmail already saved in $EnvFile."
  } else {
    $password = Read-AppPassword $email
    if ($password) { $mailAccounts.Add(@{ address = $email; password = $password }) }
  }
  $feed = Read-CalendarFeed $email
  if ($feed) { $calendars.Add($feed) }
}
Write-Output ""

if ($mailAccounts.Count -eq 0 -and $calendars.Count -eq 0 -and -not $Replace) {
  Write-Output "Nothing entered; $EnvFile was not changed."
  return
}

$payload = @{
  replace   = [bool]$Replace
  accounts  = $mailAccounts
  calendars = $calendars
} | ConvertTo-Json -Compress -Depth 4

$writer = @'
import fs from "node:fs";
const target = process.env.MSC_ENV_TARGET;
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const lines = fs.existsSync(target) ? fs.readFileSync(target, "utf8").split(/\r?\n/) : [];
const get = (key) => {
  const row = lines.find((line) => line.startsWith(`${key}=`));
  return row ? row.slice(key.length + 1).trim() : "";
};
const mailMap = new Map();
if (!input.replace) {
  for (const part of get("MSC_GMAIL_ACCOUNTS").split(",")) {
    const idx = part.indexOf(":");
    if (idx > 0) mailMap.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim());
  }
}
for (const item of input.accounts) mailMap.set(item.address, item.password);
const calSet = new Set(input.replace ? [] : get("MSC_CALENDAR_ICS").split(",").map((s) => s.trim()).filter(Boolean));
for (const url of input.calendars) calSet.add(url);
const kept = lines.filter((line) => line && !line.startsWith("MSC_GMAIL_ACCOUNTS=") && !line.startsWith("MSC_CALENDAR_ICS="));
if (mailMap.size) kept.push(`MSC_GMAIL_ACCOUNTS=${[...mailMap].map(([k, v]) => `${k}:${v}`).join(",")}`);
if (calSet.size) kept.push(`MSC_CALENDAR_ICS=${[...calSet].join(",")}`);
fs.writeFileSync(`${target}.tmp`, `${kept.join("\n")}\n`, { mode: 0o600 });
fs.renameSync(`${target}.tmp`, target);
console.log(`Saved ${mailMap.size} Gmail account(s) and ${calSet.size} calendar feed(s).`);
'@

$env:MSC_ENV_TARGET = $EnvFile
try {
  $payload | & node --input-type=module -e $writer
  if ($LASTEXITCODE -ne 0) { throw "Could not update $EnvFile" }
} finally {
  Remove-Item Env:MSC_ENV_TARGET -ErrorAction SilentlyContinue
}
Write-Output "Restart the hub to load the new Gmail and Calendar settings."
