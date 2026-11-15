#!/bin/sh
# BMW102 G-xDrive — установка движка (root-сервиса) на МГУ по SSH.
#
#   sh install.sh --identity ~/.ssh/mgu_root_key [--host 172.16.222.97] [--port 22]
#
# Что делает: кладёт engine/* в /var/opt/bmw102-xdrive/current, ставит и
# включает systemd-юнит bmw102-xdrive.service, запускает его. Rootfs на МГУ
# read-only — юнит ставится с временным remount rw (как sshd-always-on.sh).
#
# Плитку в меню (bmw102_xdrive) ставьте через Магазин: добавьте эту папку/репозиторий
# как источник (в нём есть mgu-repo.json) и установите «G-xDrive». См. README.md.
set -u

HOST=172.16.222.97
PORT=22
USER=root
IDENTITY=""
HERE=$(cd "$(dirname "$0")/.." && pwd)
ENGINE="$HERE/engine"

while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2;;
    --host) HOST="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --user) USER="$2"; shift 2;;
    *) echo "неизвестный аргумент: $1"; exit 1;;
  esac
done
[ -n "$IDENTITY" ] || { echo "нужен --identity <ключ root>"; exit 1; }
[ -f "$ENGINE/daemon.py" ] || { echo "не найден engine/ рядом с install/"; exit 1; }

SSH="ssh -i $IDENTITY -p $PORT -o StrictHostKeyChecking=accept-new $USER@$HOST"
SCP="scp -i $IDENTITY -P $PORT -o StrictHostKeyChecking=accept-new"
DEST=/var/opt/bmw102-xdrive/current

echo "[BMW102] цель: $USER@$HOST:$PORT"
echo "[BMW102] создаю $DEST ..."
$SSH "mkdir -p $DEST/engine" || { echo "нет связи с МГУ (кабель/Wi-Fi, авто проснулось?)"; exit 2; }

echo "[BMW102] копирую движок ..."
$SCP "$ENGINE/__init__.py" "$ENGINE/hsfz.py" "$ENGINE/xdrive.py" \
     "$ENGINE/daemon.py" "$ENGINE/cli.py" "$ENGINE/__main__.py" \
     "$USER@$HOST:$DEST/engine/" || exit 2
$SCP "$ENGINE/run_daemon.py" "$USER@$HOST:$DEST/" || exit 2

echo "[BMW102] ставлю и включаю сервис (temp remount rw) ..."
$SSH "sh -s" <<'REMOTE'
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
REMOTE

echo "[BMW102] проверка связи с раздаткой (probe) ..."
$SSH "/var/opt/mgu-python/current/bin/python3 /var/opt/bmw102-xdrive/current/run_daemon.py >/dev/null 2>&1 & sleep 1; /var/opt/mgu-python/current/bin/python3 -c \"import socket;s=socket.socket(1,1);s.connect('/dev/shm/bmw102-xdrive/xdrive.sock');s.sendall(b'{\\\"op\\\":\\\"probe\\\"}\\n');import time;time.sleep(6);print(s.recv(8192).decode())\"" || true
echo "[BMW102] готово. Движок установлен и запущен."
echo "          Плитку ставьте через Магазин (источник с mgu-repo.json) — см. README.md."
