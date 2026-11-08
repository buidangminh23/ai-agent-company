param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Machine = "SERVER",
  [string]$InstallDir = "$env:USERPROFILE\msc-collector",
  [int]$Port = 5190,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "AIAgentCompany-Collector"
$MinNodeMajor = 23

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Output "Removed task $TaskName (folder $InstallDir kept)"
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
$major = [int]((& $node -v).TrimStart("v").Split(".")[0])
if ($major -lt $MinNodeMajor) { throw "Node $major is too old; need >= $MinNodeMajor for TypeScript type stripping and node:sqlite" }

$tailscaleIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like "100.*" } | Select-Object -First 1).IPAddress
if (-not $tailscaleIp) { throw "No Tailscale 100.x address found on this machine" }

$source = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $source "server") $InstallDir
Copy-Item -Recurse -Force (Join-Path $source "shared") $InstallDir
Set-Content -Path (Join-Path $InstallDir "package.json") -Value '{ "name": "msc-collector", "private": true, "type": "module" }' -Encoding utf8NoBOM
$envText = "MSC_ROLE=collector`nMSC_MACHINE=$Machine`nMSC_HOST=$tailscaleIp`nMSC_PORT=$Port`nMSC_TOKEN=$($Token.Trim())`n"
Set-Content -Path (Join-Path $InstallDir ".env") -Value $envText -Encoding utf8NoBOM -NoNewline
icacls (Join-Path $InstallDir ".env") /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$node`" server\hub.ts" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent()).Name
$trigger.Delay = "PT40S"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 4
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $TaskName -Direction Inbound -Protocol TCP -LocalPort $Port -LocalAddress $tailscaleIp -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
} else {
  Write-Warning "Not elevated: inbound firewall rule for port $Port on $tailscaleIp was not created"
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6
$health = Invoke-RestMethod -Uri "http://${tailscaleIp}:$Port/healthz" -TimeoutSec 5
Write-Output "Collector $($health.machine) role=$($health.role) on http://${tailscaleIp}:$Port"
