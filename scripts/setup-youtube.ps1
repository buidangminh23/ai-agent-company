param(
  [string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) ".env")
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Set-EnvValues([hashtable]$Values) {
  $lines = if (Test-Path $EnvFile) { @(Get-Content $EnvFile | Where-Object { $_ -notmatch "^($($Values.Keys -join '|'))=" }) } else { @() }
  $lines += $Values.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
  Set-Content -Path $EnvFile -Value $lines -Encoding utf8NoBOM
}

Write-Output "1. Enable YouTube Data API v3: https://console.cloud.google.com/apis/library/youtube.googleapis.com"
Write-Output "2. OAuth consent screen: External, add the scope .../auth/youtube.readonly, then set Publishing status to 'In production' (Testing mode logs out every 7 days)."
Write-Output "3. Credentials -> Create credentials -> OAuth client ID -> Application type 'TVs and Limited Input devices'."
$clientId = (Read-Host "Client ID").Trim()
if ($clientId -notmatch '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$') { throw "That does not look like a Google OAuth client ID" }
$secure = Read-Host "Client secret" -AsSecureString
$secret = [Net.NetworkCredential]::new("", $secure).Password.Trim()
if ($secret.Length -lt 20) { throw "Client secret looks too short" }

$probe = Invoke-WebRequest -SkipHttpErrorCheck -Method Post -Uri "https://oauth2.googleapis.com/device/code" -Body @{ client_id = $clientId; scope = "https://www.googleapis.com/auth/youtube.readonly" }
if ($probe.StatusCode -ne 200) { throw "Google rejected the client (HTTP $($probe.StatusCode)): $($probe.Content). Use the 'TVs and Limited Input devices' type." }

Set-EnvValues @{ MSC_YOUTUBE_CLIENT_ID = $clientId; MSC_YOUTUBE_CLIENT_SECRET = $secret }
Write-Output "Saved the YouTube OAuth client to $EnvFile. Restart the hub, open the CEO screen and press Đăng nhập."
