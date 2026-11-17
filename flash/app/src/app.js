/**
 * BMW102 · Flash — плитка в меню МГУ: стробоскоп дальним светом и световое шоу, полностью как в прототипе —
 * странице Strobe приложения Ambient config из cauliflowermossgrape/idrive7-apps (2.7.3, MIT).
 *
 * Как в прототипе:
 *   · движок src/strobe.js (тот же, что у BMW102 · Strobe): функции света BDC (2E D542), LED-каналы фар
 *     FLM01/FLE (31 01 3000), цифровые выходы BDC (2F 4501 / 2F E3B5); ≤30 с за нажатие, отдых, ≤2 мин за 10 мин,
 *     перегрев фар FLM01 ≥ 90 °C, фары возвращаются машине;
 *   · стробоскоп работает и на ходу; световое шоу — только когда машина стоит; всё — только когда в машине кто-то
 *     есть (VehicleCondition; закрыли и ушли — остановка);
 *   · настройки страницы: режим Полиция / Стробоскоп / Поочерёдно; свет все / дальний; длина вспышки 50–150 мс;
 *     для полиции — вспышек в серии 1–4 и порядок Л·Оба·П / Л·П·Оба / Л·П; вспышек в секунду Макс/4/3/2/1 (BDC)
 *     или скорость быстро/обычно/медленно; обучение дальнего; скорость шоу;
 *   · запуск рычагом: короткий рывок рычага дальнего (src/lever.js) запускает стробоскоп с настройками страницы,
 *     ещё рывок — останавливает; на стоянке, а на ходу — только с «Рычаг на ходу: Вкл»;
 *   · приложение стартует вместе с МГУ (autostart), чтобы рычаг работал без открытия плитки.
 * Отличие от прототипа — только экран: список BMW (RHMI) вместо холста, тексты на русском.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { Tasu } = require('./tasu.js');
const { Strobe } = require('./strobe.js');
const { Vehicle } = require('./vehicle.js');
const { Lever } = require('./lever.js');

const logger = logging.getSDKLogger();

const PRESS_DEDUPE_MS = 400;
const CONFIRM_MS = 6000;
const HIDE_SETTLE_MS = 400;
const STOP_WAIT_MS = 4000;
const REFIND_MS = 120000;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'flash-settings.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'strobe_channels.json');

// Имена — как в rhmiData/uiDescription.
const STATE_NAME = 'ST_OnlineApps_BMW102Flash';
const C = {
    title: 'fTitle', status: 'fStatus', checks: 'fChecks', start: 'fStart', pattern: 'fPattern',
    opt1: 'fOpt1', opt2: 'fOpt2', opt3: 'fOpt3', opt4: 'fOpt4', learn: 'fLearn', lever: 'fLever',
    leverDrive: 'fLeverDrive', result: 'fResult', showRate: 'fShowRate', show: 'fShow', warn: 'fWarn'
};

// Настройки — те же ключи и значения, что у прототипа.
const DEFAULTS = {
    strobePattern: 'police', strobeRate: 'normal', strobeLights: 'all', policeBurst: '4', strobeFlashMs: '80',
    policeOrder: 'lbr', strobeEvery: '0', strobeLever: false, strobeLeverDriving: false, showRate: 'normal'
};
const VALUES = {
    strobePattern: ['police', 'both', 'alternate'], strobeRate: ['fast', 'normal', 'slow'], strobeLights: ['all', 'high'],
    policeBurst: ['1', '2', '3', '4'], strobeFlashMs: ['50', '80', '100', '150'], policeOrder: ['lbr', 'lrb', 'lr'],
    strobeEvery: ['0', '250', '333', '500', '1000'], showRate: ['fast', 'normal']
};
const NAMES = {
    strobePattern: { police: 'Полиция', both: 'Стробоскоп', alternate: 'Поочерёдно' },
    strobeRate: { fast: 'быстро', normal: 'обычно', slow: 'медленно' },
    strobeLights: { all: 'все фонари', high: 'дальний' },
    policeOrder: { lbr: 'Л · Оба · П', lrb: 'Л · П · Оба', lr: 'Л · П' },
    strobeEvery: { 0: 'Макс', 250: '4', 333: '3', 500: '2', 1000: '1' },
    showRate: { fast: 'быстро', normal: 'обычно' }
};
const OPT_TEXT = {
    strobeLights: (v) => 'Свет: ' + NAMES.strobeLights[v],
    strobeFlashMs: (v) => 'Длина вспышки: ' + v + ' мс',
    policeBurst: (v) => 'Серия: ' + v + (v === '1' ? ' вспышка' : ' вспышки'),
    policeOrder: (v) => 'Порядок: ' + NAMES.policeOrder[v],
    strobeEvery: (v) => 'Вспышек в секунду: ' + NAMES.strobeEvery[v],
    strobeRate: (v) => 'Скорость: ' + NAMES.strobeRate[v]
};

const STR = {
    linking: 'Подключаю диагностический канал МГУ…',
    noLink: 'Нет диагностического канала МГУ (TASU).',
    finding: 'Ищу управление фарами…',
    notFound: 'Управление фарами не найдено',
    confirmStart: 'Нажмите «Старт стробоскопа» ещё раз в течение 6 с',
    confirmShow: 'Нажмите «Старт шоу» ещё раз в течение 6 с',
    busy: 'Подождите: идёт другая операция',
    start: '▶  Старт стробоскопа',
    stop: '■  Стоп',
    showGo: '✦  Старт шоу (15 с)',
    learn: 'Обучить дальний свет',
    refind: 'Найти фары заново',
    unused: '—',
    warn: 'Только для частной территории. Мигание фарами на дорогах общего пользования запрещено и опасно для других водителей.'
};

function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, value) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value));
        return true;
    } catch (e) { return false; }
}

class FlashApp extends OnlineApp {
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
        this._confirm = { what: null, until: 0 };
        this._finding = false;

        const saved = readJson(SETTINGS_FILE, {});
        this._cfg = Object.assign({}, DEFAULTS);
        Object.keys(DEFAULTS).forEach((k) => {
            const v = saved[k];
            if (typeof DEFAULTS[k] === 'boolean' ? typeof v === 'boolean' : VALUES[k].indexOf(String(v)) >= 0) {
                this._cfg[k] = typeof DEFAULTS[k] === 'boolean' ? v : String(v);
            }
        });

        this._tasu = new Tasu((m) => this._trace(m));
        this._tasu.on('available', () => this._render());
        this._vehicle = new Vehicle((m) => this._trace(m));
        this._vehicle.on('change', () => this._render());
        this._lever = new Lever();
        this._vehicle.on('beam', (on, t) => this._onBeam(on, t));
        this._strobe = new Strobe({
            diag: this._tasu,
            log: { info: (m) => this._trace(m), warn: (m) => this._trace(m, 'warn') },
            allowed: (what) => this._gate(what),
            channels: readJson(CHANNELS_FILE, null)
        });
        this._strobe.on('change', () => this._render());
        this._strobe.on('learned', (c) => {
            if (!writeJson(CHANNELS_FILE, c)) this._trace('learned channels not saved', 'warn');
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

    _trace(text, level) {
        try {
            (logger[level || 'info'] || logger.info).call(logger, `bmw102_flash: ${text}`);
        } catch (e) { /* логгер недоступен */ }
    }

    _version() {
        const pkg = this._packageJson || this.packageJson;
        return pkg && pkg.version;
    }

    /* ---- проверки прототипа (gateChecks / gateWhy): [текст, ок, только для] ---- */
    _checks() {
        return [
            ['В машине кто-то есть', !this._vehicle.away],
            ['Машина стоит (для шоу)', !this._vehicle.moving(), 'show']
        ];
    }

    _gate(what) {
        if (this._shutdownPromise) return 'приложение закрывается';
        const c = this._checks().find((x) => !x[1] && (!x[2] || x[2] === what));
        return c ? c[0].toLowerCase() + ': нет' : null;
    }

    /* Параметры запуска — как strobeOptions() прототипа. */
    _strobeOptions() {
        const s = this._strobe, st = this._cfg;
        const o = {
            lights: s.patterns && st.strobeLights === 'high' ? 'high' : 'all', pattern: st.strobePattern,
            rate: st.strobeRate, burst: st.policeBurst, flashMs: st.strobeFlashMs, order: st.policeOrder
        };
        if (s.kind === 'fn') o.every = +st.strobeEvery;
        return o;
    }

    /* Какие настройки видны сейчас (как на странице прототипа), по порядку — в кнопки fOpt1..4. */
    _optKeys() {
        const s = this._strobe, st = this._cfg;
        const fn = s.kind === 'fn';
        const tail = fn ? ['strobeEvery'] : ['strobeRate'];
        if (fn && s.mask && st.strobePattern === 'police') return ['policeBurst', 'strobeFlashMs', 'policeOrder'].concat(tail);
        return (s.patterns ? ['strobeLights'] : []).concat(fn ? ['strobeFlashMs'] : [], tail);
    }

    _patterns() {
        return VALUES.strobePattern.filter((k) => k !== 'police' || this._strobe.patterns);
    }

    _save() {
        writeJson(SETTINGS_FILE, this._cfg);
    }

    _appInitialized() {
        this._trace(`v${this._version()} starting, reason ${this.startReason}`);
        this._vehicle.start();
        if (this._cfg.strobeLever) this._vehicle.watchBeam();
        this._linkTasu().then(() => this._find()).catch(() => this._refindLater());
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
        this._bind(C.start, () => this._doStart());
        this._bind(C.pattern, () => this._doPattern());
        ['opt1', 'opt2', 'opt3', 'opt4'].forEach((k, i) => this._bind(C[k], () => this._doOpt(i)));
        this._bind(C.learn, () => this._doLearn());
        this._bind(C.lever, () => this._toggle('strobeLever'));
        this._bind(C.leverDrive, () => this._toggle('strobeLeverDriving'));
        this._bind(C.showRate, () => this._toggle('showRate'));
        this._bind(C.show, () => this._doShow());
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
        this._vehicle.active();
        try {
            handler();
        } catch (err) {
            this._trace(`${name} failed: ${err && err.message}`, 'warn');
        }
    }

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

    /* ---- диагностический канал и поиск фар ---- */
    _linkTasu() {
        if (this._tasu.p || this._tasuStarting) {
            return this._tasuStarting || Promise.resolve();
        }
        this._tasuStarting = this._tasu.init()
            .then(() => { this._tasuStarting = null; this._render(); })
            .catch((e) => { this._tasuStarting = null; this._render(); throw e; });
        this._render();
        return this._tasuStarting;
    }

    /* Фары не ответили: ещё раз через 2 мин, пока машиной пользуются (как в прототипе). */
    _refindLater() {
        if (this._refindTimer || this._shutdownPromise) return;
        this._refindTimer = setTimeout(() => {
            this._refindTimer = null;
            if (this._vehicle.away) { this._refindLater(); return; }
            this._linkTasu().then(() => this._find()).catch(() => this._refindLater());
        }, REFIND_MS);
    }

    _find() {
        if (this._finding || this._strobe.running) {
            return Promise.resolve();
        }
        this._finding = true;
        this._render();
        return this._linkTasu()
            .then(() => this._strobe.find())
            .then((kind) => { if (!kind) this._refindLater(); })
            .catch((e) => { this._trace(`find: ${e && e.message || e}`, 'warn'); this._refindLater(); })
            .then(() => {
                this._finding = false;
                if (this._patterns().indexOf(this._cfg.strobePattern) < 0) this._cfg.strobePattern = this._patterns()[0];
                this._render();
            });
    }

    _confirmed(what) {
        const now = Date.now();
        if (this._confirm.what === what && now <= this._confirm.until) {
            this._confirm = { what: null, until: 0 };
            return true;
        }
        this._confirm = { what, until: now + CONFIRM_MS };
        this._render();
        setTimeout(() => this._render(), CONFIRM_MS + 50);
        return false;
    }

    _confirming(what) {
        return this._confirm.what === what && Date.now() <= this._confirm.until;
    }

    _usable() {
        if (this._finding || !this._strobe.kind) {
            if (!this._finding) this._linkTasu().then(() => this._find()).catch(() => {});
            return false;
        }
        return true;
    }

    /* ---- рычаг дальнего (как в прототипе) ---- */
    _onBeam(on, t) {
        if (!this._lever.beam(on, t)) return;
        const s = this._strobe;
        // рывок во время стробоскопа останавливает его (как бы он ни был запущен; остановке проверки не нужны)
        if (s.running === 'strobe') {
            this._lever.cool(t);
            this._trace('strobe: stopped with the flasher lever');
            s.stop();
            return;
        }
        const parkedOk = this._vehicle.moving() === false || this._cfg.strobeLeverDriving === true;
        if (this._cfg.strobeLever !== true || !s.kind || s.running || this._gate('strobe') !== null || !parkedOk) return;
        this._lever.cool(t);
        this._trace('strobe: started with the flasher lever');
        s.start(this._strobeOptions()).catch((e) => this._trace(`strobe: ${e}`, 'warn'));
    }

    /* ---- действия ---- */
    _doStart() {
        const s = this._strobe;
        if (s.running === 'strobe') { s.stop(); return; }
        if (s.running || !this._usable()) return;
        if (!this._confirmed('start')) return;
        s.start(this._strobeOptions()).catch((e) => this._trace(`strobe: ${e && e.stack || e}`, 'warn'));
    }

    _doShow() {
        const s = this._strobe;
        if (s.running === 'show') { s.stop(); return; }
        if (s.running || !this._usable()) return;
        if (!this._confirmed('show')) return;
        s.show({ rate: this._cfg.showRate }).catch((e) => this._trace(`light show: ${e && e.stack || e}`, 'warn'));
    }

    _doLearn() {
        const s = this._strobe;
        if (s.running === 'learn') { s.stop(); return; }
        if (s.running) return;
        if (!s.head) { this._find(); return; }
        s.learn().catch((e) => this._trace(`strobe: ${e}`, 'warn'));
    }

    _doPattern() {
        const list = this._patterns();
        this._cfg.strobePattern = list[(list.indexOf(this._cfg.strobePattern) + 1) % list.length];
        this._save();
        this._render();
    }

    _doOpt(i) {
        const key = this._optKeys()[i];
        if (!key) return;
        const vals = VALUES[key];
        this._cfg[key] = vals[(vals.indexOf(this._cfg[key]) + 1) % vals.length];
        this._save();
        this._render();
    }

    _toggle(key) {
        if (key === 'showRate') {
            this._cfg.showRate = this._cfg.showRate === 'fast' ? 'normal' : 'fast';
        } else {
            this._cfg[key] = !this._cfg[key];
            if (key === 'strobeLever' && this._cfg.strobeLever) this._vehicle.watchBeam();
        }
        this._save();
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

    _statusText() {
        const s = this._strobe;
        if (this._tasuStarting) return STR.linking;
        if (!this._tasu.p) return STR.noLink + (this._tasu.error ? ' ' + this._tasu.error : '');
        if (this._finding) return STR.finding;
        if (!s.kind) return STR.notFound + ' (повтор через 2 мин или «Найти фары заново»)';
        return 'Фары: ' + s.kindName + (s.head ? (s.high ? ' · дальний: канал ' + s.high.map((c) => c.ch).join(', ') : ' · дальний ещё не изучен') : '');
    }

    _render() {
        if (!this._visible || this._shutdownPromise || !this._state) {
            return;
        }
        const s = this._strobe, st = this._cfg;
        this._write(C.status, this._statusText());
        const kmh = this._vehicle.kmh();
        this._write(C.checks, this._checks().map((c) => (c[1] ? '✓ ' : '✗ ') + c[0]).join('   ·   ')
            + (kmh === null ? '' : '   ·   ' + kmh + ' км/ч'));
        this._write(C.start, s.running === 'strobe' ? STR.stop : this._confirming('start') ? '▶  Нажмите ещё раз — старт' : STR.start);
        this._write(C.pattern, 'Режим: ' + NAMES.strobePattern[st.strobePattern]);
        const keys = this._optKeys();
        ['opt1', 'opt2', 'opt3', 'opt4'].forEach((k, i) => {
            const key = keys[i];
            this._write(C[k], key ? OPT_TEXT[key](st[key]) : STR.unused);
        });
        this._write(C.learn, s.running === 'learn' ? STR.stop : s.head ? STR.learn : STR.refind);
        this._write(C.lever, 'Запуск рычагом: ' + (st.strobeLever ? 'Вкл' : 'Выкл'));
        this._write(C.leverDrive, 'Рычаг на ходу: ' + (st.strobeLeverDriving ? 'Вкл' : 'Выкл'));
        const note = this._confirming('start') ? STR.confirmStart : this._confirming('show') ? STR.confirmShow : s.note;
        this._write(C.result, note ? (s.noteType === 'warn' && note === s.note ? '✗  ' : '·  ') + note : '·  Готов');
        this._write(C.showRate, 'Скорость шоу: ' + NAMES.showRate[st.showRate]);
        this._write(C.show, s.running === 'show' ? STR.stop : this._confirming('show') ? '✦  Нажмите ещё раз — шоу' : STR.showGo);
        this._write(C.warn, STR.warn);
    }

    /* ---- остановка: сначала вернуть фары машине ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        this._trace(`shutdown ${reason || ''}`);
        clearTimeout(this._hideTimer);
        clearTimeout(this._refindTimer);
        this._strobe.stop();
        const lightsBack = new Promise((resolve) => {
            const t0 = Date.now();
            const check = () => (!this._strobe.running || Date.now() - t0 > STOP_WAIT_MS ? resolve() : setTimeout(check, 100));
            check();
        });
        this._shutdownPromise = lightsBack
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new FlashApp();
app.start().catch((err) => {
    logger.error(`bmw102_flash failed to start: ${err && err.message}`);
});
