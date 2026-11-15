/**
 * BMW102 · G-xDrive — плитка в меню МГУ для отключения полного привода.
 *
 * Приложение само ничего не шлёт в шину (песочница OAP). По нажатию кнопки
 * оно стучится в root-демон (engine/daemon.py) по unix-сокету, а демон
 * отправляет UDS-команду в раздатку (VTG 0x29) по HSFZ. Одна страница:
 *   заголовок · строка статуса · «Отключить xDrive» · «Проверить связь» · результат.
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
// Секрет (если демон запущен с --require-secret) кладётся установщиком
// в data-папку приложения; читается при каждом использовании.
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, 'app-secret');

// Имя state и компонентов — должны совпадать с rhmiData/uiDescription.
const STATE = 'ST_BMW102_XDrive';
const C = { title: 'xdTitle', status: 'xdStatus', disable: 'xdDisable', probe: 'xdProbe', result: 'xdResult' };

// Крошечный i18n: ru по умолчанию, en как запасной.
const STR = {
    ru: {
        ready: 'Готов. Нажмите «Отключить xDrive».',
        connecting: 'Подключение к сервису…',
        offline: 'Сервис xDrive не запущен на МГУ.',
        working: 'Выполняю… не выключайте зажигание.',
        probing: 'Проверяю связь с раздаткой…',
        hintG: 'Только G-кузов. Привод вернётся после перезапуска авто.',
        disable: 'Отключить xDrive',
        probe: 'Проверить связь',
    },
    en: {
        ready: 'Ready. Press “Disable xDrive”.',
        connecting: 'Connecting to service…',
        offline: 'xDrive service is not running on the head unit.',
        working: 'Working… keep the ignition on.',
        probing: 'Checking link to transfer box…',
        hintG: 'G-chassis only. AWD returns after a car restart.',
        disable: 'Disable xDrive',
        probe: 'Check link',
    },
};

class XDriveApp extends OnlineApp {
    constructor() {
        super();
        this._states = {};
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._shutdown = false;
        this._lang = 'ru';
        this._entryUuid = null;
        this._connected = false;
        this._state = null;         // последнее состояние демона
        this._note = null;          // текущая строка результата (перекрывает статус)

        this._client = new XDriveClient(SOCKET, { reconnectMs: RECONNECT_MS, secret: this._readSecret() });
        this._client.on('state', (st) => { this._connected = true; this._state = st; this._render(); });
        this._client.on('result', (r) => { this._note = r; this._render(); });
        this._client.on('down', () => { this._connected = false; this._render(); });
        this._client.on('reply-error', (msg, op) => {
            this._note = { ok: false, message: (op === 'disable' ? 'Отказ: ' : '') + String(msg) };
            this._render();
        });

        this.on('initialized', () => this._boot().catch((e) => logger.error('init: ' + (e && e.message))));
        this.on('shutdown', () => { this._shutdown = true; try { this._client.close(); } catch (e) {} });
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._openEntry(uuid));
        this.on('changeVisibility', (d) => { if (d && d.visible === false) this._setVisible(false); });
    }

    t(key) { return (STR[this._lang] && STR[this._lang][key]) || STR.en[key] || key; }

    _readSecret() {
        try { return fs.readFileSync(SECRET_FILE, 'utf8').trim() || null; } catch (e) { return null; }
    }

    _version() { const pkg = this._packageJson || this.packageJson; return pkg && pkg.version; }

    _boot() {
        logger.info('BMW102 xDrive ' + this.getAppId() + ' v' + this._version() + ' starting');
        this._client.connect();
        if (!this.rhmiApplication) { return this.initialized(); }
        const fg = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => { if (fg) this.registerActive(); return this.initialized(); })
            .then(() => {
                if (fg) this._setVisible(true);
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return last ? this._openEntry(last) : undefined;
            });
    }

    _startedForeground() {
        const F = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        return F.includes((data && data.reason) || this.startReason);
    }

    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._states[STATE] = rhmi.getByName(STATE);
        if (!this._states[STATE]) return Promise.reject(new Error('uiDescription has no ' + STATE));
        this._state = this._states[STATE];
        Object.values(C).forEach((name) => {
            this._components[name] = rhmi.getByName(name);
            if (!this._components[name]) logger.warn('BIND MISS: ' + name);
        });
        this._bind(C.disable, () => this._doDisable());
        this._bind(C.probe, () => this._doProbe());

        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) this._press(entry.name, entry.handler);
        });
        this._states[STATE].on('visible', (ev) => {
            const vis = !!(ev && ev.visible);
            this._visible = vis;
            if (vis) { this._render(); this._client.status(); }
        });
        return Promise.resolve(this._states[STATE].updateResources());
    }

    _registerEntryPoints() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) return Promise.reject(new Error('no entry point handed over by the manager'));
        const d = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(d.uuid, this._states[STATE]))
            .then(() => { this._entryUuid = d.uuid; })
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info('entry point ' + d.name + ' ENABLED'));
    }

    _openEntry(uuid) {
        if (this._shutdown || !this.rhmiApplication || !uuid) return Promise.resolve();
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((e) => logger.warn('openEntryState: ' + (e && e.message)));
    }

    _setVisible(v) { this._visible = v; if (v) this._render(); }

    _bind(name, handler) {
        const comp = this._components[name];
        if (!comp) return;
        let id = null;
        try { id = comp.getId(); } catch (e) { id = null; }
        if (id !== null) this._actionById[Number(id)] = { name, handler };
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < 400) return;
        this._lastPress[name] = now;
        logger.info('BUTTON ' + name);
        try { handler(); } catch (e) { logger.warn(name + ': ' + (e && e.message)); }
    }

    _doDisable() {
        this._note = { ok: null, message: this.t('working') };
        this._render();
        if (!this._client.disable()) {
            this._note = { ok: false, message: this.t('offline') };
            this._render();
        }
    }

    _doProbe() {
        this._note = { ok: null, message: this.t('probing') };
        this._render();
        if (!this._client.probe()) {
            this._note = { ok: false, message: this.t('offline') };
            this._render();
        }
    }

    /* ---- вывод ---- */
    _set(name, cell, value, type) {
        const comp = this._components[name];
        const key = name + '.' + cell;
        if (!comp || this._written[key] === value) return;
        this._written[key] = value;
        Promise.resolve(comp.setValue(0, cell, value, type))
            .catch((e) => logger.warn('set ' + key + ': ' + (e && e.message)));
    }

    _statusText() {
        if (!this._connected) return this.t('offline');
        if (this._state && this._state.busy) return this.t('working');
        return this.t('ready');
    }

    _render() {
        if (!this._visible || this._shutdown) return;
        this._set(C.status, 'Text', this._statusText(), 'Text');
        this._set(C.disable, 'Text', this.t('disable'), 'Text');
        this._set(C.probe, 'Text', this.t('probe'), 'Text');
        const note = this._note;
        const mark = note ? (note.ok === true ? '✓  ' : note.ok === false ? '✗  ' : '·  ') : '';
        this._set(C.result, 'Text', note ? (mark + note.message) : this.t('hintG'), 'Text');
    }
}

const app = new XDriveApp();
app.start().catch((err) => logger.error('start failed: ' + (err && err.message)));
