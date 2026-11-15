"""
BMW102 · G-кузов · отключение полного привода (xDrive -> 100% RWD).

Ядро отправляет ту же UDS-команду, что проверенный sxDrive, но прямо
с головного устройства (МГУ) по протоколу HSFZ через внутренний
диагностический шлюз — без ELM327 и без Bluetooth-адаптера.

    VTG (раздатка, Verteilergetriebe) диаг-адрес 0x29
    2E DB E1 00   WriteDataByIdentifier, DID 0xDBE1 = 0x00 (Disable AWD)
    6E DB E1      положительный ответ -> привод отключён

Работает только для G-кузова (CLAR). На G полный привод возвращается
сам после перезапуска авто.
"""

from .hsfz import (
    EnetClient, HsfzError, UdsReject, X,
    TESTER, GATEWAY, MGU,
    P_MAIN, P_READ_IP, P_SVK,
    match_response, require_response,
)

# --- Диагностические адреса ---
VTG = 0x29  # раздатка (transfer box) — цель команды на G-кузове

# --- UDS ---
REQ_DISABLE_XDRIVE = bytes.fromhex('2E DB E1 00')   # WDBI DID DBE1 = 00
MARK_DISABLE_OK    = bytes.fromhex('6E DB E1')      # положительный ответ
REQ_EXT_SESSION    = bytes.fromhex('10 03')         # extendedDiagnosticSession
REQ_VTG_IDENT      = bytes.fromhex('22 F1 01')      # чтение SVK/идентификации VTG (проверка связи)

# Только G. F/E намеренно не поддерживаем в этом приложении.
SUPPORTED_BODY = 'G'

# Расшифровка типовых отрицательных ответов (NRC) для понятного лога.
NRC_TEXT = {
    0x22: 'ConditionsNotCorrect — не выполнены условия. Нужен режим диагностики '
          '(зажигание ON / 3 нажатия Start без тормоза).',
    0x31: 'RequestOutOfRange — идентификатор/значение вне диапазона.',
    0x7F: 'ServiceNotSupportedInActiveSession — служба недоступна в текущей сессии.',
    0x33: 'SecurityAccessDenied — требуется разблокировка доступа.',
    0x11: 'ServiceNotSupported — служба не поддерживается ЭБУ.',
    0x13: 'IncorrectMessageLengthOrInvalidFormat — неверная длина/формат.',
    0x78: 'ResponsePending — ЭБУ просит подождать (обрабатывается автоматически).',
}


class XDriveResult:
    """Итог операции, пригодный и для лога, и для JSON по сокету."""
    __slots__ = ('ok', 'code', 'message', 'raw')

    def __init__(self, ok, code, message, raw=None):
        self.ok = ok
        self.code = code            # 'done' | 'rejected' | 'no_response' | 'link' | 'body' | 'error'
        self.message = message
        self.raw = raw

    def to_dict(self):
        return {'ok': self.ok, 'code': self.code, 'message': self.message,
                'raw': self.raw.hex() if isinstance(self.raw, (bytes, bytearray)) else self.raw}


class XDrive:
    """
    Высокоуровневое управление отключением xDrive на G-кузове.

    gateway — IP внутреннего диаг-шлюза, видимый с МГУ. По ENET с ноутбука
    это 169.254.0.2; с самой МГУ адрес задаётся конфигом/авто-поиском
    (см. daemon.py: GATEWAY_CANDIDATES).
    """

    def __init__(self, gateway=None, port=None, log=None, body=SUPPORTED_BODY, open_session=True):
        from .hsfz import DEFAULT_GATEWAY, ENET_PORT
        self.gateway = gateway or DEFAULT_GATEWAY
        self.port = port or ENET_PORT
        self.log = log or (lambda msg: None)
        self.body = (body or SUPPORTED_BODY).upper()
        self.open_session = open_session
        self.client = EnetClient(self.gateway, self.port)

    # --- связь ---
    def connect(self):
        self.client.connect()

    def close(self):
        self.client.close()

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *exc):
        self.close()

    # --- проверка связи (безопасно, ничего не меняет) ---
    def probe(self):
        """Прочитать идентификацию VTG. Подтверждает, что с МГУ виден шлюз и
        раздатка отвечает, НИЧЕГО не записывая. Для проверки перед боем."""
        try:
            frames = self.client.request(VTG, REQ_VTG_IDENT, P_SVK)
        except HsfzError as e:
            return XDriveResult(False, 'link', 'Нет связи с диаг-шлюзом/VTG: %s' % e)
        x = match_response(frames, VTG)
        if x is None:
            return XDriveResult(False, 'no_response', 'VTG (0x29) не ответил на идентификацию.')
        if x.negative:
            return XDriveResult(False, 'rejected',
                                'VTG отклонил идентификацию: NRC 0x%02X' % x.nrc, x.data)
        return XDriveResult(True, 'done', 'Связь с VTG есть, раздатка отвечает.', x.data)

    # --- основная операция ---
    def disable(self):
        """Отключить полный привод на G-кузове. Возвращает XDriveResult."""
        if self.body != SUPPORTED_BODY:
            return XDriveResult(False, 'body',
                                'Приложение только для G-кузова (получено: %s).' % self.body)

        # 1) (опц.) открыть расширенную сессию — повышает шанс обойти NRC 0x22.
        if self.open_session:
            try:
                self.client.request(VTG, REQ_EXT_SESSION, P_MAIN)
                self.log('Открыта расширенная диаг-сессия (10 03).')
            except (HsfzError, UdsReject) as e:
                # не фатально: на части конфигураций запись проходит и в default
                self.log('Расш. сессия не открылась (%s) — продолжаю в текущей.' % e)

        # 2) записать DID DBE1 = 00 -> выключить AWD.
        self.log('Отправляю команду отключения xDrive в VTG (0x29): 2E DB E1 00 ...')
        try:
            frames = self.client.request(VTG, REQ_DISABLE_XDRIVE, P_MAIN)
        except HsfzError as e:
            return XDriveResult(False, 'link', 'Сбой связи при отправке: %s' % e)

        x = match_response(frames, VTG)
        if x is None:
            return XDriveResult(False, 'no_response',
                                'VTG не прислал ответ. Если авто было в режиме диагностики, '
                                'команда могла примениться — проверьте поведение.')
        if x.negative:
            hint = NRC_TEXT.get(x.nrc, 'неизвестный код.')
            return XDriveResult(False, 'rejected',
                                'Машина отклонила команду. NRC 0x%02X — %s' % (x.nrc, hint), x.data)

        clean = x.data.hex().upper()
        if MARK_DISABLE_OK.hex().upper() in clean:
            return XDriveResult(True, 'done',
                                'Полный привод ОТКЛЮЧЁН (100% задний). Вернётся после перезапуска авто.',
                                x.data)
        return XDriveResult(False, 'error', 'Неожиданный ответ VTG: %s' % clean, x.data)
