# Sets up Aurora Guard to run on this PC: starts with Windows (before anyone signs in), restarts itself if it
# stops, and lets the port through Windows Firewall. Run it in PowerShell "as Administrator" from this folder:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
# Run it again after changing the port; it replaces the old setup.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'aurora-guard.js'
$config = Join-Path $here 'config.json'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.' }
if (-not (Test-Path $config)) { throw 'config.json is missing. Copy config.example.json to config.json and fill it in first.' }
$port = (Get-Content $config -Raw | ConvertFrom-Json).port
if (-not $port) { $port = 8922 }

# Only Administrators and the system may read the folder: config.json holds the Emby API key and the
# certificate password, and data\ holds the limits.
icacls $here /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Aurora Guard' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Get-NetFirewallRule -DisplayName 'Aurora Guard' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Aurora Guard' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null

Stop-ScheduledTask -TaskName 'Aurora Guard' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'Aurora Guard'
Start-Sleep -Seconds 3
Write-Host "Aurora Guard is set up on port $port. Its log is $here\data\guard.log"
Get-Content (Join-Path $here 'data\guard.log') -Tail 5 -ErrorAction SilentlyContinue
