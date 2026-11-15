# G-xDrive · архитектура

## Поток

```
Нажатие «Отключить xDrive» (OAP-плитка, песочница SOME/IP)
        │  JSON по строкам: {"op":"disable"}
        ▼
/dev/shm/bmw102-xdrive/xdrive.sock   (unix-сокет, root-демон)
        │
        ▼
engine/daemon.py  → engine/xdrive.py  → engine/hsfz.py (EnetClient)
        │                                   │
        │  TCP :6801 (HSFZ)                 ▼
        └────────────────────────▶  внутренний диаг-шлюз авто
                                            │ TESTER 0xF4 → dst 0x29 (VTG)
                                            ▼
                                     раздатка (Verteilergetriebe)
                                     2E DB E1 00  →  6E DB E1 (ok)
```

## Почему движок отдельно от плитки

OAP-приложения линкуются против `oap-sdk` и общаются с системой только
через SOME/IP-прокси HMI-сервисов. Прямого доступа к диагностической шине
(сырые UDS-кадры) у них нет. Поэтому плитка — это тонкий клиент, а всю
диагностику делает root-сервис. Та же схема у Store ↔ mgu-updater
(`/dev/shm/mgu-updater/updater.sock`).

## Протокол сокета (построчный JSON)

Запрос → ответ:

| op | действие | ответ |
|---|---|---|
| `status` | состояние демона | `{"type":"state", body, gateway, busy, last}` |
| `probe` | опрос раздатки (без записи) | `{"type":"result", ok, code, message}` |
| `disable` | отключить xDrive (G) | `{"type":"result", ok, code, message}` |

`code`: `done` · `rejected` (NRC) · `no_response` · `link` · `body` · `error`.
При подключении и на изменения демон сам шлёт `{"type":"state",...}`.

## UDS / HSFZ

- Адресация HSFZ: `TESTER=0xF4`, шлюз `0xDF`, МГУ `0x63`, цель **VTG `0x29`**.
- Команда: `2E DB E1 00` (WDBI, DID `0xDBE1`=00 → выключить AWD).
- Успех: `6E DB E1`. Перед записью опционально открывается расширенная
  сессия `10 03` (повышает шанс обойти `NRC 0x22`).
- Только G-кузов: F/E намеренно не поддерживаются этим приложением
  (`engine/xdrive.py → SUPPORTED_BODY='G'`).

## Установка (где что лежит на МГУ)

- Движок: `/var/opt/bmw102-xdrive/current/` (rootfs read-only, пишем в `/var/opt`).
- Сервис: `bmw102-xdrive.service` (systemd, `WantedBy=multi-user.target`).
- Python: `/var/opt/mgu-python/current/bin/python3` (компонент `mgu-python`).
- Плитка: ставится/собирается штатным deploy-инструментом Магазина из `app/`.
