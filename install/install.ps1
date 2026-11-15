# BMW102 G-xDrive - установка движка на МГУ по SSH (Windows PowerShell).
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Identity $HOME\.ssh\mgu_root_key [-Host 172.16.222.97]
# Плитку в меню ставьте через Магазин (источник с mgu-repo.json). См. README.md.
param(
  [Parameter(Mandatory=$true)][string]$Identity,
  [string]$HostAddr = "172.16.222.97",
  [int]$Port = 22,
  [string]$User = "root"
)
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Here   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Engine = Join-Path $Here "engine"
if (-not (Test-Path (Join-Path $Engine "daemon.py"))) { throw "не найден engine\ рядом с install\" }

$Dest = "/var/opt/bmw102-xdrive/current"
$sshArgs = @("-i", $Identity, "-p", "$Port", "-o", "StrictHostKeyChecking=accept-new", "$User@$HostAddr")
function SSH([string]$cmd) { & ssh @sshArgs $cmd }
function SCP([string[]]$files, [string]$to) { & scp -i $Identity -P $Port -o StrictHostKeyChecking=accept-new @files "$User@${HostAddr}:$to" }

Write-Host "[BMW102] цель: $User@${HostAddr}:$Port" -ForegroundColor Cyan
Write-Host "[BMW102] создаю $Dest ..."
SSH "mkdir -p $Dest/engine"

Write-Host "[BMW102] копирую движок ..."
$files = @("__init__.py","hsfz.py","xdrive.py","daemon.py","cli.py","__main__.py") | ForEach-Object { Join-Path $Engine $_ }
SCP $files "$Dest/engine/"
SCP @((Join-Path $Engine "run_daemon.py")) "$Dest/"

Write-Host "[BMW102] ставлю и включаю сервис ..." -ForegroundColor Cyan
$remote = @'
set -e
UNIT=/etc/systemd/system/bmw102-xdrive.service
RW=0
if ! touch /etc/.xd-rw-test 2>/dev/null; then mount -o remount,rw / ; RW=1; else rm -f /etc/.xd-rw-test; fi
cat > "$UNIT" <<UNITEOF
[Unit]
Description=BMW102 G-xDrive daemon (MGU -> VTG via HSFZ)
RequiresMountsFor=/var/opt
After=local-fs.target network.target
[Service]
ExecStart=/var/opt/mgu-python/current/bin/python3 /var/opt/bmw102-xdrive/current/run_daemon.py
Restart=always
RestartSec=5
Nice=5
StandardOutput=journal
[Install]
WantedBy=multi-user.target
UNITEOF
chmod 0644 "$UNIT"
systemctl daemon-reload
systemctl enable bmw102-xdrive.service
systemctl restart bmw102-xdrive.service
if [ "$RW" = 1 ]; then sync; mount -o remount,ro / 2>/dev/null || true; fi
sleep 1
systemctl --no-pager --full status bmw102-xdrive.service | head -8 || true
'@
$remote = ($remote -replace "`r", "")
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
SSH "echo $b64 | (base64 -d 2>/dev/null || /var/opt/mgu-python/current/bin/python3 -c 'import base64,sys;sys.stdout.write(base64.b64decode(sys.stdin.read()).decode())') | sh"

Write-Host "[BMW102] готово. Движок установлен и запущен." -ForegroundColor Green
Write-Host "          Плитку ставьте через Магазин (источник с mgu-repo.json) — см. README.md." -ForegroundColor Yellow
