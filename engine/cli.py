"""
BMW102 · командная строка отключения xDrive (G-кузов).

Запуск прямо на МГУ по SSH или из автостарта:

    python3 -m engine.cli probe      # проверить связь с раздаткой (безопасно)
    python3 -m engine.cli disable    # отключить полный привод
    python3 -m engine.cli status     # опросить демон по сокету

probe/disable работают напрямую (своё HSFZ-подключение), демон не нужен.
"""

import json
import socket
import sys

BANNER = r"""
  ____  __  __ __        ___ ___ ___
 | __ )|  \/  |\ \      / / |/ _ \_  )   BMW102 · G-xDrive
 |  _ \| |\/| | \ \ /\ / /| | | | / /    отключение полного привода
 | |_) | |  | |  \ V  V / | | |_| / /_   только G-кузов (CLAR)
 |____/|_|  |_|   \_/\_/  |_|\___/____|  МГУ -> VTG 0x29 по HSFZ, без адаптера
"""

# Трёхцветный акцент M в консоли (ANSI): голубой / синий / красный.
C_LIGHT, C_DARK, C_RED, C_OK, C_OFF = '\033[38;5;39m', '\033[38;5;27m', '\033[38;5;196m', '\033[38;5;46m', '\033[0m'


def _stripe():
    return C_LIGHT + '━━━━━━━━' + C_DARK + '━━━━━━━━' + C_RED + '━━━━━━━━' + C_OFF


def _log(msg):
    print('  ' + msg)


def cmd_probe(args):
    from .xdrive import XDrive
    from .daemon import Daemon
    d = Daemon(log=_log)
    _log('Ищу диаг-шлюз и опрашиваю раздатку (ничего не меняю)...')
    res = d.op_probe()
    _show(res)
    return 0 if res.ok else 2


def cmd_disable(args):
    from .daemon import Daemon
    d = Daemon(log=_log)
    print(_stripe())
    _log(C_RED + 'ОТКЛЮЧЕНИЕ полного привода (G-кузов).' + C_OFF)
    _log('Убедитесь: зажигание включено / режим диагностики (3x Start без тормоза).')
    res = d.op_disable()
    print(_stripe())
    _show(res)
    return 0 if res.ok else 2


def cmd_status(args):
    from .daemon import SOCKET_PATH
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(args.socket or SOCKET_PATH)
        s.sendall(b'{"op":"status"}\n')
        s.settimeout(3)
        data = s.recv(8192).decode('utf-8').splitlines()
        for line in data:
            if line.strip():
                print('  ' + line)
        s.close()
        return 0
    except OSError as e:
        _log(C_RED + 'Демон недоступен: %s' % e + C_OFF)
        return 2


def _show(res):
    mark = (C_OK + '✓ ' + C_OFF) if res.ok else (C_RED + '✗ ' + C_OFF)
    _log(mark + res.message)


def main(argv=None):
    import argparse
    print(BANNER)
    p = argparse.ArgumentParser(prog='xdrive', description='BMW102 G-xDrive')
    p.add_argument('--socket', default=None)
    sub = p.add_subparsers(dest='cmd')
    sub.add_parser('probe')
    sub.add_parser('disable')
    sub.add_parser('status')
    args = p.parse_args(argv)
    if args.cmd == 'probe':
        return cmd_probe(args)
    if args.cmd == 'disable':
        return cmd_disable(args)
    if args.cmd == 'status':
        return cmd_status(args)
    p.print_help()
    return 1


if __name__ == '__main__':
    sys.exit(main())
