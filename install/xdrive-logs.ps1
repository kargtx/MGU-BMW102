# BMW102 · сбор логов G-xDrive с МГУ в файл xdrive-logs.txt рядом со скриптом (Windows).
#   powershell -ExecutionPolicy Bypass -File xdrive-logs.ps1 -Identity $HOME\.ssh\mgu_root_key
# Ноутбук — в Wi-Fi машины (или ENET). Ничего не меняет на МГУ.
param(
  [Parameter(Mandatory=$true)][string]$Identity,
  [string]$HostAddr = "172.16.222.97",
  [int]$Port = 22
)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$remote = @'
echo "== версия движка =="; grep -m1 "\"version\"" /var/opt/bmw102-xdrive/current/component.json 2>/dev/null || ls -la /var/opt/bmw102-xdrive 2>&1
echo "== сервис движка =="; systemctl --no-pager status bmw102-xdrive.service 2>&1 | head -12
echo; echo "== журнал движка (с журналом плитки [app]) =="; journalctl -u bmw102-xdrive.service --no-pager -n 200 2>&1
echo; echo "== сокет =="; ls -la /dev/shm/bmw102-xdrive/ 2>&1
echo; echo "== упоминания bmw102 в журнале системы =="; journalctl -b --no-pager 2>/dev/null | grep -i -E "bmw102|xdrive" | grep -v "bmw102-xdrive\[" | tail -80
echo; echo "== Store: последние строки mgu-updater =="; journalctl -u mgu-updater.service --no-pager -n 60 2>&1 | grep -i -E "bmw102|xdrive|error|fail" | tail -30
'@
$remote = ($remote -replace "`r", "")
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
$cmd = "echo $b64 | (base64 -d 2>/dev/null || /var/opt/mgu-python/current/bin/python3 -c 'import base64,sys;sys.stdout.write(base64.b64decode(sys.stdin.read()).decode())') | sh"
$out = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "xdrive-logs.txt"
Write-Host "[BMW102] собираю логи с root@${HostAddr} ..." -ForegroundColor Cyan
& ssh -i $Identity -p $Port -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$HostAddr" $cmd 2>&1 | Out-File -Encoding utf8 $out
Write-Host "[BMW102] готово: $out" -ForegroundColor Green
