'use strict';
/**
 * BMW102 · Flash — стробоскоп дальним светом и световое шоу. Экран и логика — страница Strobe приложения
 * Ambient config (cauliflowermossgrape/idrive7-apps 2.7.3, MIT), как есть: те же панели, кнопки, проверки и
 * запуск рычагом дальнего (5 нажатий за 10 с — старт, следующее нажатие — стоп); тексты на русском, тема BMW102 (тёмно-синий фон, полосы голубой · синий · красный).
 *
 * Слева — Стробоскоп: найденные фары, проверки (в машине кто-то есть; шоу — только стоя), запуск рычагом,
 * свет / полиция (серия, длина вспышки, порядок) / обучение дальнего, режим, вспышек в секунду или скорость,
 * Старт (первое нажатие взводит, второе запускает). Справа — Световое шоу, 15 с.
 * Только для частной территории. Движок — strobe.js: мигает без ограничения по времени, пока не остановят (Стоп, одно
 * нажатие рычага, проверки); без паузы для отдыха; стоп по перегреву фар FLM01; фары возвращаются машине.
 * Приложение стартует с МГУ (autostart): рычаг работает и с закрытой плиткой.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const Car = require('./kit/car');
const Parked = require('./kit/parked');
const { Strobe } = require('./strobe');
const { Lever, beamOf } = require('./lever');

const W = 1600, H = 520;
const IDLE_MS = 15 * 60000;          // без состояния от машины: не ездили и не трогали приложение столько — закрыли и ушли
const REFIND_MS = 120000;            // фары не ответили: ещё раз через 2 мин, пока машиной пользуются
const BRAND = 'BMW102 · ремонт и обслуживание BMW · +7 965 925 6666 · Telegram @BMW102UFA';

/* Проверки прототипа (gateChecks без «включено в настройках» — у плитки это и есть её назначение). */
const gateChecks = (o) => [
    ['В машине кто-то есть', !o.away],
    ['Машина стоит (световое шоу)', !o.moving, null, 'show'],
];
const gateWhy = (checks, what) => { const c = checks.find((x) => !x[1] && (!x[3] || x[3] === what)); return c ? c[0].toLowerCase() + ': нет' : null; };

/* Параметры Старта и рычага — как на странице (strobeOptions прототипа). */
function strobeOptions(settings, strobe) {
    const cyc = (key, vals, def) => { const v = String(settings.get(key) || def); return vals.indexOf(v) >= 0 ? v : def; };
    const pattern = ['both', 'alternate', 'police'].indexOf(settings.get('strobePattern')) >= 0 ? settings.get('strobePattern') : 'police';
    const o = { lights: strobe && strobe.patterns && settings.get('strobeLights') === 'high' ? 'high' : 'all', pattern,
        rate: settings.get('strobeRate') || 'normal', burst: cyc('policeBurst', ['1', '2', '3', '4'], '4'),
        flashMs: cyc('strobeFlashMs', ['50', '80', '100', '150'], '80'), order: cyc('policeOrder', ['lbr', 'lrb', 'lr'], 'lbr') };
    if (strobe && strobe.kind === 'fn') o.every = +cyc('strobeEvery', ['0', '250', '333', '500', '1000'], '0');
    return o;
}

async function background(bg) {
    const { settings, signals, log } = bg;
    const diag = await new Diag(signals, log).init();
    diag.quiet = true; diag.busyLog = false;

    // машину закрыли и ушли (стоянка, никого внутри): по VehicleCondition, без него — по частичным сетям; машина,
    // которая не говорит своё состояние: не ездили и не трогали приложение IDLE_MS — закрыли и ушли
    let away = false, stateSeen = false, activeT = Date.now();
    const active = () => { activeT = Date.now(); if (!stateSeen && away) away = false; };
    const conditionFrom = (v) => {
        const n = Car.conditionOf(v && v.statusConditionVehicle);
        if (n !== undefined) return n;
        const p = v && v.controlBasePartialNetworks;
        if (p === 0 || p === 'KEINE_KOMMUNIKATION') return 1;
        return Car.conditionOf(typeof p === 'string' ? p.replace(/^KOM_/, '') : p);
    };
    const sources = new Set();
    const onCondition = (field) => (v) => {
        const n = conditionFrom(v);
        if (n === undefined) return;
        if (!sources.has(field)) { sources.add(field); log.info('vehicle state: from ' + field + ' (' + n + ')'); }
        stateSeen = true;
        away = n <= 3;
    };
    signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
        VehicleCondition: onCondition('VehicleCondition'),
        vehicleConditionNoCrc: onCondition('vehicleConditionNoCrc'),
    }, log).catch((e) => log.warn('vehicle state: ' + (e && e.message || e)));
    setInterval(() => {
        if (stateSeen || away || Date.now() - activeT <= IDLE_MS) return;
        log.info('vehicle state: none from the car, not driven or used for ' + IDLE_MS / 60000 + ' min: parked');
        away = true;
    }, 30000);

    const parked = Parked.watch(bg, log);
    const checks = () => gateChecks({ away, moving: parked.moving() });
    const gate = (what) => gateWhy(checks(), what);
    // езда — машиной пользуются
    setInterval(() => { if (parked.moving()) active(); }, 5000);

    // каналы дальнего, изученные на блоке фар, — в папке данных
    const chFile = bg.dataDir ? path.join(bg.dataDir, 'strobe_channels.json') : null;
    let channels = null;
    try { channels = chFile ? JSON.parse(fs.readFileSync(chFile, 'utf8')) : null; } catch (e) { channels = null; }
    const strobe = new Strobe({ diag, log, allowed: gate, channels });
    strobe.on('learned', (c) => { try { if (chFile) fs.writeFileSync(chFile, JSON.stringify(c)); } catch (e) { log.warn('strobe: ' + e); } });
    const again = () => setTimeout(() => { if (away) again(); else find(); }, REFIND_MS);
    const find = () => strobe.find().then((k) => { if (!k) again(); }, (e) => { log.warn('strobe: ' + e); again(); });
    find();

    // рычаг дальнего (lever.js): 5 нажатий за 10 с на стоянке (на ходу — с настройкой strobeLeverDriving) запускают
    // стробоскоп с настройками страницы, пока включён «Запуск рычагом»; следующее нажатие во время мигания — останавливает
    const lever = new Lever();
    let leverWatch = null;
    const watchLever = () => {
        if (leverWatch || settings.get('strobeLever') !== true) return;
        leverWatch = Promise.resolve(signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusLightStatus: (v) => {
                const t = Date.now();
                const got = lever.beam(beamOf(v && v.statusMainBeam_headlightFlasher), t);
                if (!got) return;
                if (strobe.running === 'strobe') {
                    lever.cool(t);
                    log.info('strobe: stopped with the flasher lever');
                    strobe.stop();
                    return;
                }
                if (got !== 'start') return;
                const parkedOk = parked.moving() === false || settings.get('strobeLeverDriving') === true;
                if (settings.get('strobeLever') !== true || !strobe.kind || strobe.running || gate('strobe') !== null || !parkedOk) return;
                lever.cool(t);
                log.info('strobe: started with the flasher lever (5 pulls in 10 s)');
                strobe.start(strobeOptions(settings, strobe)).catch((e) => log.warn('strobe: ' + e));
            },
        }, log, { pollMs: 500 })).catch((e) => { leverWatch = null; log.warn('flasher lever: ' + (e && e.message || e)); });
    };
    watchLever();
    settings.onChange((key) => { if (key === 'strobeLever') watchLever(); });
    return { strobe, checks, active, find };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const { strobe, checks, active, find } = ctx.background || await background(ctx);
        let dirty = true;
        const redraw = () => { dirty = true; if (active) active(); return render(); };

        /*
         * Стробоскоп (только частная территория): дальний через блоки фар или блок кузова (strobe.js), обе фары
         * вместе или по очереди, без ограничения по времени — до Стоп или нажатия рычага; обучение дальнего; световое шоу 15 с. Только когда в машине
         * кто-то есть; нажатие взводит, второе запускает; Стоп или машину закрыли и ушли — остановка, фары машине.
         */
        function drawStrobe(cv, t) {
            G.panel(cv, t, 24, 44, 736, 468, 'Стробоскоп');
            const kindText = !strobe ? 'Недоступно' : strobe.kind ? 'Свет: ' + strobe.kindName
                + (strobe.head ? (strobe.high ? ' · дальний: канал ' + strobe.high.map((c) => c.ch).join(', ') : ' · дальний ещё не изучен') : '')
                : 'Ищу управление фарами…';
            cv.text(kindText, 44, 112, 18, t.dim);
            checks().forEach(([label, ok, why], i) => {
                const y = 146 + i * 30;
                cv.arc(52, y - 6, 0, 7, 0, 360, ok ? t.ok : t.crit);
                cv.text(label + (!ok && why ? ' · ' + why : ''), 70, y, 20, ok ? t.text : t.dim);
            });
            cv.text('Только для частной территории.', 44, 222, 20, t.warn, { font: 'bold' });
            // 5 нажатий рычага дальнего за 10 с запускают (lever.js), следующее — останавливает; только пока это включено
            const lever = settings.get('strobeLever') === true;
            G.button(cv, t, 520, 190, 220, 42, lever ? 'Рычаг: Вкл' : 'Рычаг: Выкл', () => { settings.set('strobeLever', !lever); return redraw(); },
                { primary: lever, key: 'strobe-lever', busy: !strobe });
            if (strobe && strobe.note) cv.text(strobe.note, 44, 248, 18, strobe.noteType === 'warn' ? t.warn : t.dim);
            else if (lever) cv.text('Рычаг дальнего: 5 нажатий за 10 с — старт, ещё нажатие — стоп', 44, 248, 18, t.dim);
            const pat = ['both', 'alternate', 'police'].indexOf(settings.get('strobePattern')) >= 0 ? settings.get('strobePattern') : 'police';
            const rate = settings.get('strobeRate') || 'normal';
            // блоки фар мигают всем передним светом; блок кузова — только дальним
            const lights = strobe && strobe.patterns && settings.get('strobeLights') === 'high' ? 'high' : 'all';
            // полиция дальним (функции света при блоках фар): её настройки вместо «Свет»
            const policeTune = strobe && strobe.kind === 'fn' && strobe.mask && pat === 'police';
            const cyc = (key, vals, def) => { const v = String(settings.get(key) || def); return vals.indexOf(v) >= 0 ? v : def; };
            const burst = cyc('policeBurst', ['1', '2', '3', '4'], '4'), flashMs = cyc('strobeFlashMs', ['50', '80', '100', '150'], '80');
            const order = cyc('policeOrder', ['lbr', 'lrb', 'lr'], 'lbr');
            const next = (vals, v) => vals[(vals.indexOf(v) + 1) % vals.length];
            if (policeTune) {
                cv.text('Полиция: вспышек в серии · вспышка · порядок (нажмите, чтобы сменить)', 44, 274, 18, t.dim);
                const ORDER_NAMES = { lrb: 'Л · П · Оба', lr: 'Л · П', lbr: 'Л · Оба · П' };
                [['policeBurst', burst + (burst === '1' ? ' вспышка' : ' вспышки'), ['1', '2', '3', '4'], burst],
                    ['strobeFlashMs', flashMs + ' мс', ['50', '80', '100', '150'], flashMs],
                    ['policeOrder', ORDER_NAMES[order], ['lbr', 'lrb', 'lr'], order]].forEach(([key, label, vals, v], i) => {
                    G.button(cv, t, 44 + i * 150, 284, 140, 42, label, () => { settings.set(key, next(vals, v)); return redraw(); }, { key: 'tune-' + key });
                });
            } else if (strobe && strobe.patterns) {
                cv.text('Свет', 44, 274, 18, t.dim);
                [['all', 'Все фонари'], ['high', 'Дальний']].forEach(([k, n], i) => {
                    G.button(cv, t, 44 + i * 236, 284, 224, 42, n, () => { settings.set('strobeLights', k); return redraw(); }, { primary: lights === k, key: 'lights-' + k });
                });
                // вспышки блока кузова берут свою длину в любом режиме, не только в полиции
                if (strobe.kind === 'fn') {
                    cv.text('Длина вспышки (нажмите, чтобы сменить)', 520, 274, 18, t.dim);
                    G.button(cv, t, 520, 284, 220, 42, flashMs + ' мс', () => { settings.set('strobeFlashMs', next(['50', '80', '100', '150'], flashMs)); return redraw(); }, { key: 'tune-strobeFlashMs' });
                }
            }
            if (strobe && strobe.head) {
                // какие каналы — дальний: смотрим, пока его включают рычагом
                const learning = strobe.running === 'learn';
                G.button(cv, t, 520, 284, 220, 42, learning ? 'Стоп' : 'Обучить дальний', () => {
                    if (learning) strobe.stop(); else strobe.learn().catch((e) => log.warn('strobe: ' + e));
                    return redraw();
                }, { primary: learning, key: 'strobe-learn', busy: !learning && !!strobe.running });
            }
            cv.text('Режим', 44, 346, 18, t.dim);
            // полиция: одна фара, потом другая, быстрее некуда (только блоки фар)
            const pats = [['police', 'Полиция'], ['both', 'Стробоскоп'], ['alternate', 'Поочерёдно']].filter(([k]) => k !== 'police' || (strobe && strobe.patterns));
            pats.forEach(([k, n], i) => {
                G.button(cv, t, 44 + i * 150, 356, 140, 42, n, () => { settings.set('strobePattern', k); return redraw(); }, { primary: pat === k, key: 'pat-' + k });
            });
            // вспышки блока кузова по таймеру: сколько в секунду (Макс — как быстро их пропускает МГУ)
            const timed = strobe && strobe.kind === 'fn';
            const every = cyc('strobeEvery', ['0', '250', '333', '500', '1000'], '0');
            if (timed) {
                cv.text('Вспышек в секунду', 44, 418, 18, t.dim);
                [['0', 'Макс'], ['250', '4'], ['333', '3'], ['500', '2'], ['1000', '1']].forEach(([k, n], i) => {
                    G.button(cv, t, 44 + i * 94, 428, 86, 48, n, () => { settings.set('strobeEvery', k); return redraw(); }, { primary: every === k, key: 'every-' + k });
                });
            } else {
                cv.text('Скорость', 44, 418, 18, t.dim);
                [['fast', 'Быстро'], ['normal', 'Обычно'], ['slow', 'Медленно']].forEach(([k, n], i) => {
                    G.button(cv, t, 44 + i * 150, 428, 140, 48, n, () => { settings.set('strobeRate', k); return redraw(); }, { primary: rate === k, key: 'rate-' + k });
                });
            }
            const on = strobe && strobe.running === 'strobe';
            G.button(cv, t, 520, 428, 220, 48, on ? 'Стоп' : 'Старт', () => {
                if (on) strobe.stop(); else strobe.start(strobeOptions(settings, strobe)).catch((e) => log.warn('strobe: ' + e));
                return redraw();
            }, { primary: on, key: 'strobe-go', confirm: !on, busy: !strobe || !strobe.kind || strobe.running === 'show' || strobe.running === 'learn' });

            G.panel(cv, t, 776, 44, 800, 468, 'Световое шоу');
            (strobe && strobe.kind === 'fn' ? ['Все наружные огни мигают по очереди 15 с: дальний,', 'поворотные, противотуманные, поворотники, стоп, задний ход…']
                : strobe && strobe.head ? ['Фары мигают полностью и гаснут, левая и правая', 'по очереди, 15 с.']
                : ['Все выходы света мигают 15 с, сам блок кузова', '(BDC_G11 и BDC_G05).']).forEach((l, i) => cv.text(l, 796, 112 + i * 26, 18, t.dim));
            cv.text('Только для частной территории.', 796, 190, 20, t.warn, { font: 'bold' });
            ['Мигание фарами на дорогах общего пользования запрещено', 'и опасно для других водителей.'].forEach((l, i) => cv.text(l, 796, 220 + i * 26, 18, t.text));
            if (!strobe || !strobe.kind) {
                cv.text('Фары не найдены? Включите зажигание.', 796, 300, 18, t.dim);
                G.button(cv, t, 1336, 284, 220, 42, 'Найти фары', () => { find(); return redraw(); }, { key: 'refind', busy: !!(strobe && strobe.running) });
            }
            const srate = settings.get('showRate') === 'fast' ? 'fast' : 'normal';
            cv.text('Скорость', 796, 414, 18, t.dim);
            [['fast', 'Быстро'], ['normal', 'Обычно']].forEach(([k, n], i) => {
                G.button(cv, t, 796 + i * 150, 426, 140, 48, n, () => { settings.set('showRate', k); return redraw(); }, { primary: srate === k, key: 'srate-' + k });
            });
            const showing = strobe && strobe.running === 'show';
            G.button(cv, t, 1336, 426, 220, 48, showing ? 'Стоп' : 'Старт шоу', () => {
                if (showing) strobe.stop(); else strobe.show({ rate: srate }).catch((e) => log.warn('light show: ' + e));
                return redraw();
            }, { primary: showing, key: 'show-go', confirm: !showing, busy: !strobe || !strobe.kind || strobe.running === 'strobe' || strobe.running === 'learn' });
            // BMW102: подпись внизу панели
            G.stripes(cv, t, 796, 488, 760);
            cv.text(BRAND, 796, 506, 15, t.dim);
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            drawStrobe(cv, t);
            G.frame(cv, t, ['Стробоскоп'], 0, []);
            dirty = false;
            await ui.image('MAIN_GFX', cv);
        }

        // проверки следуют за машиной — рисуем на каждом тике
        const tick = () => render();
        ctx.onTab(() => redraw());
        if (strobe) strobe.on('change', () => { dirty = true; });
        settings.onChange(() => { dirty = true; });
        ctx.loop('MAIN', 8, tick);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
