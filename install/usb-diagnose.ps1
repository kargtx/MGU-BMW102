# BMW102 · почему Store не видит флешку — диагностика и исправление (Windows).
#
#   powershell -ExecutionPolicy Bypass -File usb-diagnose.ps1 -Identity $HOME\.ssh\mgu_root_key
#   powershell -ExecutionPolicy Bypass -File usb-diagnose.ps1 -Identity $HOME\.ssh\mgu_root_key -Fix
#
# Флешка должна быть ВСТАВЛЕНА в машину. Ноутбук — в Wi-Fi машины (или ENET).
# Без -Fix ничего не меняет. С -Fix: если МГУ монтирует флешку не прямо в /media,
# дописывает её папку в usb_roots (/var/opt/mgu-updater/updater.local.conf,
# переживает обновления) и перезапускает mgu-updater.
param(
  [Parameter(Mandatory=$true)][string]$Identity,
  [string]$HostAddr = "172.16.222.97",
  [int]$Port = 22,
  [switch]$Fix
)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$remote = @'
FS='vfat|exfat|ntfs|ntfs3|fuseblk|msdos'
MOUNTS=${MOUNTS:-/proc/mounts}
echo "== 1. Флешки, смонтированные на МГУ (/dev/sd*) =="
awk -v fs="^($FS)$" '$1 ~ /^\/dev\/sd/ && $3 ~ fs {print "  " $1 "  ->  " $2 "  (" $3 ")"}' $MOUNTS
[ -n "$(awk '$1 ~ /^\/dev\/sd/' "$MOUNTS")" ] || echo "  НЕТ ни одной /dev/sd* — МГУ не смонтировала флешку как накопитель"
echo "  все FAT/exFAT/NTFS-монтирования (любое устройство):"
awk -v fs="^($FS)$" '$3 ~ fs {print "    " $1 "  ->  " $2}' "$MOUNTS"
echo
echo "== 2. Где на флешках лежит mgu-repo.json =="
for mp in $(awk -v fs="^($FS)$" '$1 ~ /^\/dev\/sd/ && $3 ~ fs {print $2}' "$MOUNTS"); do
  echo "  флешка $mp:"
  found=$(find "$mp" -maxdepth 5 -name mgu-repo.json 2>/dev/null)
  [ -n "$found" ] || echo "    mgu-repo.json НЕ НАЙДЕН — файлы не скопированы?"
  for f in $found; do
    rel=${f#$mp/}
    case "$rel" in
      mgu-repo.json|mgu-repo/mgu-repo.json|mgu-repo/*/mgu-repo.json)
        case "$rel" in mgu-repo/*/*/*) echo "    $rel  <- СЛИШКОМ ГЛУБОКО";; *) echo "    $rel  <- OK, Store это читает";; esac;;
      *) echo "    $rel  <- НЕ ТОТ ПУТЬ (нужно <флешка>/mgu-repo/g-xdrive/mgu-repo.json)";;
    esac
  done
done
echo
echo "== 3. Где Store ищет флешки (usb_roots) =="
grep -hE '^[[:space:]]*usb_roots' /var/opt/mgu-updater/current/updater.conf /var/opt/mgu-updater/updater.local.conf 2>/dev/null | sed 's/^/  /'
PARENTS=$(awk -v fs="^($FS)$" '$1 ~ /^\/dev\/sd/ && $3 ~ fs {print $2}' "$MOUNTS" | while read m; do dirname "$m"; done | sort -u)
echo "  папки, в которых МГУ монтирует флешки: $(echo $PARENTS)"
echo
echo "== 4. Store / updater =="
systemctl is-active mgu-updater.service 2>/dev/null | sed 's/^/  mgu-updater: /'
journalctl -u mgu-updater.service --no-pager -n 400 2>/dev/null | grep -i 'usb' | tail -10 | sed 's/^/  /'
if [ "$XD_FIX" = 1 ]; then
  echo
  echo "== FIX =="
  ADD=""
  for p in $PARENTS; do [ "$p" = "/media" ] || [ "$p" = "/" ] || ADD="$ADD $p"; done
  if [ -z "$ADD" ]; then
    echo "  Монтирование уже в /media — менять Store не нужно. Дело в путях на флешке (см. пункт 2)."
  else
    L=/var/opt/mgu-updater/updater.local.conf
    touch "$L"
    grep -vE '^[[:space:]]*usb_roots' "$L" > "$L.new" || true
    echo "usb_roots = /media$ADD" >> "$L.new"
    mv -f "$L.new" "$L"
    echo "  записано в $L: usb_roots = /media$ADD"
    systemctl restart mgu-updater.service && echo "  mgu-updater перезапущен — через ~10 c откройте Store -> USB"
  fi
fi
'@
$remote = ($remote -replace "`r", "")
if ($Fix) { $remote = "XD_FIX=1`n" + $remote }
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
$cmd = "echo $b64 | (base64 -d 2>/dev/null || /var/opt/mgu-python/current/bin/python3 -c 'import base64,sys;sys.stdout.write(base64.b64decode(sys.stdin.read()).decode())') | sh"

Write-Host "[BMW102] МГУ: root@${HostAddr}:$Port $(if($Fix){'(с исправлением)'}else{'(только проверка)'})" -ForegroundColor Cyan
& ssh -i $Identity -p $Port -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$HostAddr" $cmd
if ($LASTEXITCODE -ne 0) { Write-Host "[BMW102] нет SSH до МГУ (Wi-Fi машины / ENET, авто проснулось?)" -ForegroundColor Red }
