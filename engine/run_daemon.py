#!/usr/bin/env python3
"""Точка входа сервиса BMW102 G-xDrive на МГУ (запускается systemd-юнитом).
Ставит каталог установки в sys.path и поднимает демон."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine.daemon import Daemon  # noqa: E402

if __name__ == '__main__':
    # Секрет не требуется: сокет лежит в /dev/shm с правами 0660 и доступен
    # только владельцу/группе приложений на самой МГУ.
    Daemon(require_secret=False, log=lambda m: print(m, flush=True)).serve_forever()
