/**
 * BMW102 · Контакты — плитка в меню МГУ.
 *
 * Одна страница без сети и без диагностики:
 *   заголовок · вступление · «Ремонт и обслуживание» · «Техподдержка приложений» · подробности.
 * Нажатие на контакт показывает внизу телефон и Telegram.
 * Жизненный цикл — тот же, что у G-xDrive (по образцу приложений Store).
 */
'use strict';
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');

const logger = logging.getSDKLogger();

const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 400;

// Имена — как в rhmiData/uiDescription.
const STATE_NAME = 'ST_OnlineApps_BMW102Contacts';
const C = { title: 'bcTitle', intro: 'bcIntro', service: 'bcService', support: 'bcSupport', detail: 'bcDetail' };

const CONTACTS = {
    service: {
        button: 'Ремонт и обслуживание · +7 965 925 6666',
        detail: 'BMW102 — ремонт и обслуживание.  Тел.: +7 965 925 6666  ·  Telegram: @BMW102UFA'
    },
    support: {
        button: 'Техподдержка приложений · Telegram @KARGTX',
        detail: 'KARGTX — техподдержка приложений МГУ.  Telegram: @KARGTX'
    }
};

const STR = {
    intro: 'Контакты BMW102. Выберите, кому позвонить или написать.',
    hint: 'Telegram: @BMW102UFA — сервис, @KARGTX — приложения.'
};

function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class ContactsApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._hideTimer = null;
        this._shutdownPromise = null;
        this._selected = null;          // 'service' | 'support' | null

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

    _trace(text, level) {
        try {
            (logger[level || 'info'] || logger.info).call(logger, `bmw102_contacts: ${text}`);
        } catch (e) { /* логгер недоступен */ }
    }

    _version() {
        const pkg = this._packageJson || this.packageJson;
        return pkg && pkg.version;
    }

    _appInitialized() {
        this._trace(`v${this._version()} starting, reason ${this.startReason}`);
        if (!this.rhmiApplication) {
            this._trace('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
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
        this._bind(C.service, () => this._select('service'));
        this._bind(C.support, () => this._select('support'));
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
    _select(key) {
        this._selected = key;
        this._render();
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
        this._write(C.intro, STR.intro);
        this._write(C.service, CONTACTS.service.button);
        this._write(C.support, CONTACTS.support.button);
        const sel = this._selected && CONTACTS[this._selected];
        this._write(C.detail, sel ? sel.detail : STR.hint);
    }

    /* ---- остановка ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        this._trace(`shutdown ${reason || ''}`);
        clearTimeout(this._hideTimer);
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new ContactsApp();
app.start().catch((err) => {
    /* Остаётся в памяти, чтобы менеджер мог его остановить или перезапустить. */
    logger.error(`bmw102_contacts failed to start: ${err && err.message}`);
});
