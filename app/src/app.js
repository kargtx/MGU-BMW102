/**
 * BMW102 · G-xDrive — плитка в меню МГУ для отключения полного привода.
 *
 * Приложение само ничего не шлёт в шину (песочница OAP). По нажатию кнопки
 * оно стучится в root-демон bmw102-xdrive по unix-сокету, а демон отправляет
 * UDS-команду в раздатку (VTG 0x29) по HSFZ. Одна страница:
 *   заголовок · статус · «Отключить xDrive» · «Проверить связь» · результат.
 * Жизненный цикл повторяет приложения Store (robertn_store, robertn_waze_cluster).
 * Каждый шаг старта уходит в журнал демона (journalctl -u bmw102-xdrive).
 * Только G-кузов.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const { XDriveClient } = require('./client.js');

const logger = logging.getSDKLogger();

const SOCKET = '/dev/shm/bmw102-xdrive/xdrive.sock';
const RECONNECT_MS = 2000;
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 400;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, 'app-secret');

// Имена — как в rhmiData/uiDescription.
const STATE_NAME = 'ST_OnlineApps_BMW102XDrive';
const C = { title: 'xdTitle', status: 'xdStatus', disable: 'xdDisable', probe: 'xdProbe', result: 'xdResult' };

const STR = {
    ready: 'Готов. Нажмите «Отключить xDrive».',
    offline: 'Сервис xDrive не запущен на МГУ.',
    working: 'Выполняю… не выключайте зажигание.',
    probing: 'Проверяю связь с раздаткой…',
    hintG: 'Только G-кузов. Привод вернётся после перезапуска авто.',
    disable: 'Отключить xDrive',
    probe: 'Проверить связь'
};

function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class XDriveApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;             // RHMI state страницы
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._hideTimer = null;
        this._shutdownPromise = null;
        this._xdLink = false;           // демон на связи
        this._xdState = null;           // последнее состояние демона
        this._xdNote = null;            // строка результата
        this._xdLog = [];               // журнал до подключения к демону

        this._xd = new XDriveClient(SOCKET, { reconnectMs: RECONNECT_MS, secret: this._readSecret() });
        this._xd.on('state', (st) => {
            const first = !this._xdLink;
            this._xdLink = true;
            this._xdState = st;
            if (first) {
                this._flushLog();
            }
            this._render();
        });
        this._xd.on('result', (r) => { this._xdNote = r; this._trace(`result ${r.code}: ${r.message}`); this._render(); });
        this._xd.on('down', () => { this._xdLink = false; this._render(); });
        this._xd.on('reply-error', (msg, op) => {
            if (op === 'log') {
                return;
            }
            this._xdNote = { ok: false, message: `Отказ сервиса: ${msg}` };
            this._render();
        });

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => this._trace(`init failed: ${err && err.stack || err}`, 'error'));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => this._trace(`OnlineApp error: ${err && err.message}`, 'warn'));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._setVisible(false);
            }
        });
        this._trace('constructed');
    }

    /* Журнал: в логгер SDK и в журнал демона (видно в journalctl -u bmw102-xdrive). */
    _trace(text, level) {
        const line = String(text);
        try {
            (logger[level || 'info'] || logger.info).call(logger, `bmw102_xdrive: ${line}`);
        } catch (e) { /* логгер недоступен */ }
        if (!this._xd || !this._xdLink || !this._xd.send({ op: 'log', msg: line })) {
            if (this._xdLog && this._xdLog.length < 100) {
                this._xdLog.push(line);
            }
        }
    }

    _flushLog() {
        const lines = this._xdLog.splice(0);
        lines.forEach((l) => this._xd.send({ op: 'log', msg: l }));
    }

    _readSecret() {
        try { return fs.readFileSync(SECRET_FILE, 'utf8').trim() || null; } catch (e) { return null; }
    }

    _version() {
        const pkg = this._packageJson || this.packageJson;
        return pkg && pkg.version;
    }

    _appInitialized() {
        this._trace(`v${this._version()} starting, reason ${this.startReason}`);
        this._xd.connect();
        if (!this.rhmiApplication) {
            this._trace('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
                // Старт с плитки объявляет себя ACTIVE до initialized(), чтобы менеджер не остановил приложение.
                if (foregroundStart) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                this._trace(`initialized (foreground ${foregroundStart})`);
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.includes(reason);
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE_NAME);
        if (!this._state) {
            return Promise.reject(new Error(`uiDescription has no ${STATE_NAME}`));
        }
        Object.keys(C).forEach((k) => {
            const name = C[k];
            this._components[name] = rhmi.getByName(name);
            if (!this._components[name]) {
                this._trace(`BIND MISS: ${name}`, 'warn');
            }
        });
        this._bind(C.disable, () => this._doDisable());
        this._bind(C.probe, () => this._doProbe());
        // Нажатия приходят и как сырой 'userEvent'; оба пути ведут в _press.
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler);
            }
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            this._written = {};
            this._render();
        });
        this._state.on('visible', (event) => this._pageVisible(isTrue(event && event.visible)));
        return Promise.resolve(this._state.updateResources()).then(() => {
            this._trace('page ready');
            this._render();
        });
    }

    _bind(name, handler) {
        const comp = this._components[name];
        if (!comp) {
            return;
        }
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null) {
            this._actionById[Number(id)] = { name, handler };
        }
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[name] = now;
        this._trace(`BUTTON ${name}`);
        try {
            handler();
        } catch (err) {
            this._trace(`${name} failed: ${err && err.message}`, 'warn');
        }
    }

    /* Плитка из application.json приходит от менеджера; SDK шлёт 'entryPointExecute' на нажатие. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => this._trace(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._trace('tile pressed');
        this._sawForeground = true;
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => this._trace(`openEntryState failed: ${err && err.message}`, 'warn'));
    }

    /* ---- видимость ---- */
    _pageVisible(visible) {
        if (this._shutdownPromise) {
            return;
        }
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
        if (visible) {
            this._sawForeground = true;
            this._setVisible(true);
            this._xd.status();
        } else {
            this._hideTimer = setTimeout(() => {
                this._hideTimer = null;
                this._setVisible(false);
            }, HIDE_SETTLE_MS);
        }
    }

    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        this._reportVisibilityStatus(visible);
        if (visible) {
            this._render();
        }
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        const reports = visible ?
            [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report).catch((err) =>
            this._trace(`app status report failed: ${err && err.message}`, 'warn')));
    }

    /* ---- действия ---- */
    _doDisable() {
        this._xdNote = { ok: null, message: STR.working };
        this._render();
        if (!this._xd.disable()) {
            this._xdNote = { ok: false, message: STR.offline };
            this._render();
        }
    }

    _doProbe() {
        this._xdNote = { ok: null, message: STR.probing };
        this._render();
        if (!this._xd.probe()) {
            this._xdNote = { ok: false, message: STR.offline };
            this._render();
        }
    }

    /* ---- вывод ---- */
    _write(name, text) {
        const comp = this._components[name];
        if (!comp || this._written[name] === text) {
            return;
        }
        this._written[name] = text;
        Promise.resolve(comp.setValue(0, 'Text', text, 'Text'))
            .catch((err) => this._trace(`write ${name} failed: ${err && err.message}`, 'warn'));
    }

    _render() {
        if (!this._visible || this._shutdownPromise || !this._state) {
            return;
        }
        let status = STR.ready;
        if (!this._xdLink) {
            status = STR.offline;
        } else if (this._xdState && this._xdState.busy) {
            status = STR.working;
        }
        this._write(C.status, status);
        this._write(C.disable, STR.disable);
        this._write(C.probe, STR.probe);
        const n = this._xdNote;
        const mark = n ? (n.ok === true ? '✓  ' : n.ok === false ? '✗  ' : '·  ') : '';
        this._write(C.result, n ? mark + n.message : STR.hintG);
    }

    /* ---- остановка ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        this._trace(`shutdown ${reason || ''}`);
        clearTimeout(this._hideTimer);
        try { this._xd.close(); } catch (e) { /* уже закрыт */ }
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new XDriveApp();
app.start().catch((err) => {
    /* Остаётся в памяти, чтобы менеджер мог его остановить или перезапустить. */
    logger.error(`bmw102_xdrive failed to start: ${err && err.message}`);
});
