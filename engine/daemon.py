"""
BMW102 · root-демон отключения xDrive на МГУ.

Слушает локальный unix-сокет и по запросу плитки-приложения (или CLI)
отправляет команду отключения полного привода в раздатку по HSFZ.
Протокол — построчный JSON, в том же духе, что у mgu-updater:

  запрос :  {"op": "disable"}              выключить xDrive (G-кузов)
            {"op": "probe"}                проверить связь с VTG (ничего не меняет)
            {"op": "status"}               текущее состояние демона
  ответ  :  {"type": "state", ...}         шлётся при подключении и на изменения
            {"type": "result", "ok": bool, "code": "...", "message": "..."}
            {"type": "error", "error": "...", "op": "..."}

Привилегированная операция disable может требовать секрет
(config.require_secret): {"op":"disable","secret":"..."} — секрет
создаётся установщиком и читается приложением из своей data-папки.
"""

import json
import os
import socket
import threading
import time

from .xdrive import XDrive, XDriveResult, SUPPORTED_BODY

RUN_DIR = '/dev/shm/bmw102-xdrive'
SOCKET_PATH = os.path.join(RUN_DIR, 'xdrive.sock')
SECRET_PATH = os.path.join(RUN_DIR, 'app-secret')
# группа OAP-приложений: ей открыт сокет (так же у mgu-updater: socket_group)
SOCKET_GROUP = os.environ.get('XDRIVE_SOCKET_GROUP', 'tm_oap_app')

# Кандидаты адреса внутреннего диаг-шлюза, видимого с самой МГУ.
# Проверяются по очереди командой probe; используется первый ответивший.
# Порядок: ENET link-local (ноут), затем типовые внутренние адреса шлюза.
GATEWAY_CANDIDATES = [
    os.environ.get('XDRIVE_GATEWAY') or None,
    '127.0.0.1',
    '169.254.0.2',
    '160.48.199.99',
    '160.48.0.1',
]


class Daemon:
    def __init__(self, socket_path=SOCKET_PATH, require_secret=False, log=print):
        self.socket_path = socket_path
        self.require_secret = require_secret
        self.log = log
        self.gateway = None
        self.last = None          # последний XDriveResult (dict)
        self.busy = False
        self._lock = threading.Lock()
        self._clients = []
        self._secret = self._read_secret()

    # --- секрет ---
    def _read_secret(self):
        try:
            with open(SECRET_PATH, 'r') as f:
                return f.read().strip() or None
        except OSError:
            return None

    def _check_secret(self, req):
        if not self.require_secret:
            return True
        self._secret = self._read_secret()
        return bool(self._secret) and req.get('secret') == self._secret

    # --- выбор шлюза ---
    def discover_gateway(self):
        """Найти адрес шлюза, с которого VTG отвечает. Возвращает (ip|None, result)."""
        for ip in [c for c in GATEWAY_CANDIDATES if c]:
            try:
                with XDrive(gateway=ip, log=self.log) as xd:
                    res = xd.probe()
                if res.ok:
                    self.gateway = ip
                    self.log('[BMW102] шлюз найден: %s' % ip)
                    return ip, res
            except Exception as e:  # noqa: BLE001 — перебор кандидатов
                self.log('[BMW102] %s не подошёл: %s' % (ip, e))
        return None, XDriveResult(False, 'link',
                                  'Диаг-шлюз не найден ни по одному адресу. '
                                  'Проверьте, что авто проснулось и задайте XDRIVE_GATEWAY.')

    # --- операции ---
    def op_probe(self):
        ip, res = self.discover_gateway()
        self.last = res.to_dict()
        return res

    def op_disable(self):
        with self._lock:
            if self.busy:
                return XDriveResult(False, 'error', 'Уже выполняется операция.')
            self.busy = True
        try:
            ip = self.gateway
            if ip is None:
                ip, pres = self.discover_gateway()
                if ip is None:
                    self.last = pres.to_dict()
                    return pres
            self.log('[BMW102] выключаю xDrive через шлюз %s ...' % ip)
            with XDrive(gateway=ip, log=self.log, body=SUPPORTED_BODY) as xd:
                res = xd.disable()
            self.last = res.to_dict()
            self.log('[BMW102] результат: %s — %s' % (res.code, res.message))
            return res
        finally:
            self.busy = False
            self._broadcast_state()

    def state(self):
        return {'type': 'state', 'body': SUPPORTED_BODY, 'gateway': self.gateway,
                'busy': self.busy, 'last': self.last}

    # --- сетевой слой ---
    def _broadcast_state(self):
        line = json.dumps(self.state()) + '\n'
        for c in list(self._clients):
            try:
                c.sendall(line.encode('utf-8'))
            except OSError:
                pass

    def _handle(self, conn):
        self._clients.append(conn)
        buf = b''
        try:
            conn.sendall((json.dumps(self.state()) + '\n').encode('utf-8'))
            while True:
                data = conn.recv(4096)
                if not data:
                    break
                buf += data
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    if not line.strip():
                        continue
                    self._dispatch(conn, line)
        except OSError:
            pass
        finally:
            try:
                self._clients.remove(conn)
            except ValueError:
                pass
            try:
                conn.close()
            except OSError:
                pass

    def _reply(self, conn, obj):
        try:
            conn.sendall((json.dumps(obj) + '\n').encode('utf-8'))
        except OSError:
            pass

    def _dispatch(self, conn, line):
        try:
            req = json.loads(line.decode('utf-8'))
        except ValueError:
            return self._reply(conn, {'type': 'error', 'error': 'bad json'})
        op = req.get('op')
        if op == 'status':
            return self._reply(conn, self.state())
        if op == 'log':
            # журнал плитки: в systemd-журнал этого сервиса (journalctl -u bmw102-xdrive)
            self.log('[app] %s' % str(req.get('msg', ''))[:500])
            return None
        if op == 'probe':
            res = self.op_probe()
            return self._reply(conn, dict({'type': 'result'}, **res.to_dict()))
        if op == 'disable':
            if not self._check_secret(req):
                return self._reply(conn, {'type': 'error', 'error': 'forbidden', 'op': op})
            # запускаем в отдельном потоке, чтобы сокет не блокировался
            def run():
                res = self.op_disable()
                self._reply(conn, dict({'type': 'result'}, **res.to_dict()))
            threading.Thread(target=run, daemon=True).start()
            return None
        return self._reply(conn, {'type': 'error', 'error': 'unknown op: %s' % op, 'op': op})

    def _safe_dir(self, d):
        """Папка сокета в /dev/shm (sticky, общая): используем её, только если
        она принадлежит нам и никто другой не может в неё писать — как mgu-updater."""
        try:
            st = os.lstat(d)
        except OSError:
            return False
        import stat as _stat
        return _stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not (st.st_mode & 0o022)

    def serve_forever(self):
        d = os.path.dirname(self.socket_path)
        if os.path.lexists(d) and not self._safe_dir(d):
            os.rename(d, '%s.untrusted-%d' % (d, int(time.time())))
        if not os.path.exists(d):
            os.mkdir(d, 0o755)
            os.chmod(d, 0o755)
        if not self._safe_dir(d):
            raise RuntimeError('%s: папка не только для root' % d)
        try:
            os.unlink(self.socket_path)
        except OSError:
            pass
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.socket_path)
        # Плитка работает как OAP-приложение (не root), в группе tm_oap_app.
        if os.getuid() == 0 and SOCKET_GROUP:
            try:
                import grp
                os.chown(self.socket_path, 0, grp.getgrnam(SOCKET_GROUP).gr_gid)
            except (KeyError, ImportError, OSError) as e:
                self.log('[BMW102] группа %s недоступна (%s): сокет только для root' % (SOCKET_GROUP, e))
        os.chmod(self.socket_path, 0o660)
        srv.listen(8)
        self.log('[BMW102] демон xDrive слушает %s' % self.socket_path)
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                time.sleep(0.2)
                continue
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()


def main():
    import argparse
    p = argparse.ArgumentParser(description='BMW102 G-xDrive daemon')
    p.add_argument('--socket', default=SOCKET_PATH)
    p.add_argument('--require-secret', action='store_true')
    args = p.parse_args()
    Daemon(socket_path=args.socket, require_secret=args.require_secret).serve_forever()


if __name__ == '__main__':
    main()
