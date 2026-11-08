param(
  [switch]$Uninstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$TaskName = "AIAgentCompany-Hub"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Port = 5190

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed task $TaskName"
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
if (-not $SkipBuild) {
  Push-Location $ProjectDir
  try {
    & $node node_modules/typescript/bin/tsc --noEmit -p .
    if ($LASTEXITCODE -ne 0) { throw "Typecheck failed" }
    & $node node_modules/vite/bin/vite.js build --logLevel warn
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
  } finally {
    Pop-Location
  }
}

$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$node`" server\hub.ts" -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.UserId = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$trigger.Delay = "PT30S"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 4 -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent()).Name -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) { Write-Warning "Port $Port already in use by PID $($busy.OwningProcess); stop it before starting the task" }
else {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 5
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 5
  Write-Output "Hub $($health.machine) role=$($health.role) on http://127.0.0.1:$Port"
}
