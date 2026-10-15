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
$nodeMajor = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) { throw "Node.js $nodeMajor is too old. Install the LTS version (18 or newer) from https://nodejs.org and run this again." }
if (-not (Test-Path $config)) { throw 'config.json is missing. Copy config.example.json to config.json and fill it in first.' }
$settings_json = Get-Content $config -Raw | ConvertFrom-Json
$port = $settings_json.port
if (-not $port) { $port = 8922 }

# Lets Node.js open older .pfx certificates (RC2 / 3DES encryption, which Windows used to export by default).
# It makes no difference to a modern certificate.
$nodeFlags = '--openssl-legacy-provider'

if ($settings_json.pfxPath -and ($settings_json.pfxPath -match '^[A-Za-z]:[\\/]+Users[\\/]')) {
  Write-Warning 'The certificate is inside a user folder. The scheduled task runs as SYSTEM, which usually cannot read files there. If the guard reports it cannot read the certificate, copy the .pfx into this folder and point "pfxPath" at the copy.'
}

# Only Administrators and the system may read the folder: config.json holds the Emby API key and the
# certificate password, and data\ holds the limits.
icacls $here /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null

# Try the certificate and the Emby API key now, so a problem is explained here and not found later as a dead port.
Write-Host 'Checking the certificate and the Emby API key...'
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'   # Node's warnings go to stderr, which would otherwise stop this script
$checkOutput = & $node $nodeFlags $script --check 2>&1
$checkCode = $LASTEXITCODE
$ErrorActionPreference = $previous
$checkOutput | ForEach-Object { Write-Host "  $_" }
if ($checkCode -eq 1) { throw 'Aurora Guard found a problem (above). Fix config.json or the certificate and run this again.' }
if ($checkCode -eq 2) { Write-Warning 'Emby could not be reached right now. The guard keeps trying once it is running.' }

$action = New-ScheduledTaskAction -Execute $node -Argument "$nodeFlags `"$script`"" -WorkingDirectory $here
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
Write-Host 'Look for "listening on https://" below. "CERTIFICATE PROBLEM" means the https endpoint is not running, and says why.'
Get-Content (Join-Path $here 'data\guard.log') -Tail 8 -ErrorAction SilentlyContinue
