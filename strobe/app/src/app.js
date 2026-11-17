/**
 * BMW102 · Стробоскопы — плитка в меню МГУ: мигание дальним светом и световое шоу.
 *
 * Только для частной территории и только на стоянке. Команды идут через диагностический транспорт самой МГУ —
 * TASU (src/tasu.js), без адаптера и без движка. Сам стробоскоп — src/strobe.js, перенесённый из idrive7-apps
 * (ambient_config, MIT): три пути к фарам, какой ответит первым —
 *   · функции света блока кузова BDC 0x40 (2E D542: вспышка, которую блок сам гасит через ≤150 мс);
 *   · LED-блоки фар FLM01 / FLE 0x43 / 0x44 (31 01 3000: каналы LED, ток не выше кодировки машины);
 *   · цифровые выходы света BDC (2F 4501 / 2F E3B5, BDC_G05).
 * Защита — из оригинала: ≤30 с на нажатие, отдых после работы, ≤2 мин мигания за 10 мин, остановка при
 * перегреве фар (FLM01 ≥ 90 °C), фары возвращаются машине при остановке или падении приложения.
 * От BMW102 (для safety car на треке): стробоскоп работает и на ходу, но на LED-фарах на ходу — только дальний
 * (ближний не гаснет); световое шоу и обучение — только на стоянке (≤ 3 км/ч, src/speed.js). Запуск — двойным нажатием.
 *
 * Одна страница:
 *   заголовок · статус · Старт/Стоп · Режим · Частота · Свет · Световое шоу · Обучить/Найти фары · результат.
 * Жизненный цикл — как у G-xDrive (по образцу приложений Store).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { Tasu } = require('./tasu.js');
const { Strobe } = require('./strobe.js');
const { Speed, MAX_KMH } = require('./speed.js');

const logger = logging.getSDKLogger();

const PRESS_DEDUPE_MS = 400;
const CONFIRM_MS = 6000;
const HIDE_SETTLE_MS = 400;
const STOP_WAIT_MS = 4000;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'strobe-settings.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'strobe-channels.json');

// Имена — как в rhmiData/uiDescription.
const STATE_NAME = 'ST_OnlineApps_BMW102Strobe';
const C = {
    title: 'stTitle', status: 'stStatus', start: 'stStart', pattern: 'stPattern', rate: 'stRate',
    lights: 'stLights', show: 'stShow', learn: 'stLearn', result: 'stResult'
};

const PATTERNS = [['police', 'Полиция'], ['both', 'Стробоскоп (вместе)'], ['alternate', 'Поочерёдно (лево/право)']];
const RATES = [['fast', 'быстро'], ['normal', 'обычно'], ['slow', 'медленно']];
const LIGHTS = [['all', 'все фонари'], ['high', 'только дальний']];

const STR = {
    linking: 'Подключаю диагностический канал МГУ…',
    noLink: 'Нет диагностического канала МГУ (TASU).',
    finding: 'Ищу фары (только чтение)…',
    notFound: 'Управление фарами не найдено',
    hint: 'Для трека и частной территории. ≤30 с за раз, затем отдых.',
    confirmStart: 'Нажмите «Запустить стробоскоп» ещё раз в течение 6 с. Только трек или частная территория!',
    confirmShow: 'Нажмите «Световое шоу» ещё раз в течение 6 с. Только трек или частная территория!',
    moving: 'машина движется — только на стоянке (≤' + MAX_KMH + ' км/ч)',
    movingAll: 'на ходу на LED-фарах только «Свет: только дальний» — иначе гаснет ближний',
    busy: 'Подождите: идёт другая операция',
    start: '▶  Запустить стробоскоп',
    stop: '■  Остановить',
    show: '✦  Световое шоу (15 с)',
    learn: 'Обучить дальний свет',
    learnStop: '■  Остановить обучение',
    refind: 'Найти фары заново'
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

const label = (list, key) => (list.find((x) => x[0] === key) || list[0])[1];
const nextKey = (list, key, ok) => {
    const keys = list.map((x) => x[0]).filter((k) => !ok || ok(k));
    const i = keys.indexOf(key);
    return keys[(i + 1) % keys.length] || keys[0];
};

class StrobeApp extends OnlineApp {
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
        this._note = null;              // { ok, message } — строка результата
        this._confirm = { what: null, until: 0 };
        this._finding = false;
        this._found = false;            // find() отработал хотя бы раз

        const s = readJson(SETTINGS_FILE, {});
        this._opts = {
            pattern: PATTERNS.some((p) => p[0] === s.pattern) ? s.pattern : 'police',
            rate: RATES.some((r) => r[0] === s.rate) ? s.rate : 'normal',
            lights: LIGHTS.some((l) => l[0] === s.lights) ? s.lights : 'all'
        };

        this._tasu = new Tasu((m) => this._trace(m));
        this._tasu.on('available', () => this._render());
        this._speed = new Speed((m) => this._trace(m));
        this._speed.on('change', () => this._render());
        this._strobe = new Strobe({
            diag: this._tasu,
            log: { info: (m) => this._trace(m), warn: (m) => this._trace(m, 'warn') },
            allowed: (what) => this._allowed(what),
            channels: readJson(CHANNELS_FILE, null)
        });
        this._strobe.on('change', () => {
            if (this._strobe.note) {
                this._note = { ok: this._strobe.noteType === 'warn' ? false : null, message: this._strobe.note };
            }
            this._render();
        });
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
            (logger[level || 'info'] || logger.info).call(logger, `bmw102_strobe: ${text}`);
        } catch (e) { /* логгер недоступен */ }
    }

    _version() {
        const pkg = this._packageJson || this.packageJson;
        return pkg && pkg.version;
    }

    /* Можно ли работать сейчас: null — да, иначе почему нет. Проверяется перед каждой вспышкой.
     * what: 'strobe' | 'show' | 'learn'. Стробоскоп — и на ходу (safety car); на LED-фарах на ходу только дальний,
     * потому что «все фонари» гасят между вспышками и ближний. Шоу (все LED против темноты) и обучение — на стоянке. */
    _allowed(what) {
        if (this._shutdownPromise) return 'приложение закрывается';
        if (!this._speed.moving()) return null;
        if (what === 'strobe') {
            const lights = this._strobe.running === 'strobe' ? this._runLights : this._opts.lights;
            return this._strobe.head && lights !== 'high' ? STR.movingAll : null;
        }
        return STR.moving;
    }

    _saveOpts() {
        writeJson(SETTINGS_FILE, this._opts);
    }

    _appInitialized() {
        this._trace(`v${this._version()} starting, reason ${this.startReason}`);
        this._speed.start();
        this._linkTasu().then(() => this._find()).catch(() => {});
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
        this._bind(C.rate, () => this._doRate());
        this._bind(C.lights, () => this._doLights());
        this._bind(C.show, () => this._doShow());
        this._bind(C.learn, () => this._doLearn());
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

    _find() {
        if (this._finding || this._strobe.running) {
            return Promise.resolve();
        }
        this._finding = true;
        this._note = { ok: null, message: STR.finding };
        this._render();
        return this._linkTasu()
            .then(() => this._strobe.find())
            .then((kind) => {
                this._note = kind
                    ? { ok: true, message: 'Найдено: ' + this._strobe.kindName + this._highText() }
                    : { ok: false, message: STR.notFound + ' (зажигание включено?)' };
            })
            .catch((e) => { this._note = { ok: false, message: STR.noLink + ' ' + (e && e.message || e) }; })
            .then(() => { this._finding = false; this._found = true; this._fixOpts(); this._render(); });
    }

    _highText() {
        const s = this._strobe;
        if (!s.head) return '';
        return s.high ? ' · дальний: канал ' + s.high.map((c) => c.ch).join(', ') : ' · дальний нужно обучить';
    }

    /* Полиция и «только дальний» есть не у всех путей к фарам: подстраховка после find(). */
    _fixOpts() {
        if (!this._strobe.patterns) {
            if (this._opts.pattern === 'police') this._opts.pattern = 'both';
            this._opts.lights = 'all';
        }
    }

    /* Первое нажатие — предупреждение, второе в течение 6 с — запуск. */
    _confirmed(what, text) {
        const now = Date.now();
        if (this._confirm.what === what && now <= this._confirm.until) {
            this._confirm = { what: null, until: 0 };
            return true;
        }
        this._confirm = { what, until: now + CONFIRM_MS };
        this._note = { ok: null, message: text };
        this._render();
        return false;
    }

    _ready(what) {
        if (this._finding) { this._note = { ok: null, message: STR.finding }; this._render(); return false; }
        if (!this._tasu.p) { this._linkTasu().then(() => this._find()).catch(() => {}); return false; }
        if (!this._strobe.kind) { this._find(); return false; }
        const why = this._allowed(what);
        if (why) { this._note = { ok: false, message: 'Нельзя: ' + why }; this._render(); return false; }
        return true;
    }

    /* ---- действия ---- */
    _doStart() {
        const s = this._strobe;
        if (s.running) {
            s.stop();
            return;
        }
        if (!this._ready('strobe') || !this._confirmed('start', STR.confirmStart)) {
            return;
        }
        const o = { pattern: this._opts.pattern, rate: this._opts.rate, lights: this._opts.lights };
        this._runLights = o.lights;
        this._trace(`start ${JSON.stringify(o)}`);
        s.start(o).catch((e) => this._trace(`strobe: ${e && e.stack || e}`, 'warn')).then(() => this._render());
        this._render();
    }

    _doShow() {
        const s = this._strobe;
        if (s.running) {
            s.stop();
            return;
        }
        if (!this._ready('show') || !this._confirmed('show', STR.confirmShow)) {
            return;
        }
        this._trace('light show');
        s.show({ rate: this._opts.rate === 'fast' ? 'fast' : 'normal' })
            .catch((e) => this._trace(`show: ${e && e.stack || e}`, 'warn')).then(() => this._render());
        this._render();
    }

    _doLearn() {
        const s = this._strobe;
        if (s.running === 'learn') {
            s.stop();
            return;
        }
        if (s.running) {
            this._note = { ok: null, message: STR.busy };
            this._render();
            return;
        }
        if (!s.head) {
            this._find();
            return;
        }
        const why = this._allowed('learn');
        if (why) {
            this._note = { ok: false, message: 'Нельзя: ' + why };
            this._render();
            return;
        }
        s.learn().catch((e) => this._trace(`learn: ${e && e.stack || e}`, 'warn')).then(() => this._render());
    }

    _cycle(key, list, ok) {
        if (this._strobe.running) {
            this._note = { ok: null, message: 'Сначала остановите — настройки меняются между запусками' };
            this._render();
            return;
        }
        this._opts[key] = nextKey(list, this._opts[key], ok);
        this._confirm = { what: null, until: 0 };
        this._saveOpts();
        this._render();
    }

    _doPattern() { this._cycle('pattern', PATTERNS, (k) => k !== 'police' || !this._found || !!this._strobe.patterns); }
    _doRate() { this._cycle('rate', RATES); }
    _doLights() { this._cycle('lights', LIGHTS, (k) => k === 'all' || !this._found || !!this._strobe.patterns); }

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
        const kmh = this._speed.kmh();
        const speed = kmh === null ? 'скорость: нет данных' : this._speed.moving() ? 'едем ' + kmh + ' км/ч' : 'стоим';
        const lamps = this._finding ? 'поиск фар…' : s.kind ? 'Фары: ' + s.kindName : STR.notFound;
        const run = s.running === 'strobe' ? ' · РАБОТАЕТ' : s.running === 'show' ? ' · ШОУ' : s.running === 'learn' ? ' · обучение' : '';
        return lamps + ' · ' + speed + run;
    }

    _render() {
        if (!this._visible || this._shutdownPromise || !this._state) {
            return;
        }
        const s = this._strobe;
        this._write(C.status, this._statusText());
        this._write(C.start, s.running === 'strobe' ? STR.stop : STR.start);
        this._write(C.pattern, 'Режим: ' + label(PATTERNS, this._opts.pattern));
        this._write(C.rate, 'Частота: ' + label(RATES, this._opts.rate));
        this._write(C.lights, 'Свет: ' + label(LIGHTS, this._opts.lights));
        this._write(C.show, s.running === 'show' ? STR.stop : STR.show);
        this._write(C.learn, s.running === 'learn' ? STR.learnStop : s.head ? STR.learn : STR.refind);
        const n = this._note;
        const mark = n ? (n.ok === true ? '✓  ' : n.ok === false ? '✗  ' : '·  ') : '';
        this._write(C.result, n ? mark + n.message : STR.hint);
    }

    /* ---- остановка: сначала вернуть фары машине ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        this._trace(`shutdown ${reason || ''}`);
        clearTimeout(this._hideTimer);
        this._strobe.stop();
        this._speed.stop();
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

const app = new StrobeApp();
app.start().catch((err) => {
    logger.error(`bmw102_strobe failed to start: ${err && err.message}`);
});
