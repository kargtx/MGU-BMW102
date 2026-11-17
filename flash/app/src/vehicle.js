'use strict';
/**
 * BMW102 · Flash — сигналы машины по SOME/IP, как в прототипе (idrive7-apps: kit/runtime/signals.js,
 * kit/runtime/parked.js, apps/ambient_config/main.js; MIT):
 *
 *   скорость       Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity × 1/64 км/ч (65535 — нет), перечитывается
 *                  каждые 2 с; тишина после стоянки — стоим, после езды — едем, без скорости вовсе — стоим;
 *   рычаг дальнего Vehicle2.statusLightStatus.statusMainBeam_headlightFlasher (перечитывается каждые 0,5 с);
 *   состояние авто VehicleCondition / vehicleConditionNoCrc: statusConditionVehicle ≤ 3 — машину закрыли и ушли
 *                  («в машине никого»); без него — по частичным сетям (controlBasePartialNetworks).
 *
 * Все вызовы нативной привязки — по одному, через очередь src/tasu.js (иначе она зависает).
 *
 *   const v = new Vehicle(log); v.start();
 *   v.moving()  v.kmh()  v.away  v.on('beam', (on|null, t))  v.on('change')
 */
const EventEmitter = require('events');
const { nativeTick, loadNative, loadConfig } = require('./tasu.js');

const MAX_KMH = 3;
const IDLE_MS = 15 * 60000;   // без состояния от машины: не ездили и не трогали приложение столько — закрыли и ушли
const CONDITIONS = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const conditionOf = (x) => { const n = typeof x === 'number' ? x : CONDITIONS[x]; return n >= 1 && n <= 12 ? n : undefined; };
const conditionFrom = (v) => {
    const n = conditionOf(v && v.statusConditionVehicle);
    if (n !== undefined) return n;
    const p = v && v.controlBasePartialNetworks;
    if (p === 0 || p === 'KEINE_KOMMUNIKATION') return 1;
    return conditionOf(typeof p === 'string' ? p.replace(/^KOM_/, '') : p);
};
const beamOf = (v) => (v === 'EIN' || v === 1 ? true : v === 'AUS' || v === 0 ? false : null);

/* Прокси интерфейса с подпиской на поля; poll — перечитывать поля с геттером так часто (мс). */
async function watch(iface, instance, handlers, log, pollMs) {
    const res = { available: false, error: null };
    try {
        const someip = loadNative();
        const { cfg } = loadConfig(iface);
        const p = await nativeTick(() => someip.buildProxy(cfg, String(instance)).then((px) => px.init().then(() => px)));
        const fields = Object.keys(handlers);
        const fetchAll = () => fields.forEach((f) => {
            if (cfg.fields && cfg.fields[f] && cfg.fields[f].getter && typeof p.getValue === 'function') {
                nativeTick(() => p.getValue(f, 3000)).then((v) => handlers[f](v)).catch(() => {});
            }
        });
        await nativeTick(() => {
            try { return p.subscribeToAvailability((a) => { res.available = !!a; if (a) setImmediate(fetchAll); }); } catch (e) { return null; }
        });
        for (const f of fields) {
            try {
                await nativeTick(() => p.subscribe({ name: f, onReceive: (v) => { try { handlers[f](v); } catch (e) { log(iface + '.' + f + ': ' + e); } } }));
            } catch (e) { log('subscribe ' + iface + '.' + f + ': ' + e); }
        }
        if (p.isAvailable && p.isAvailable()) { res.available = true; fetchAll(); }
        if (pollMs) setInterval(() => { if (res.available) fetchAll(); }, pollMs);
        log(iface + ': подписка есть');
    } catch (e) {
        res.error = String(e && e.message || e);
        log(iface + ': ' + res.error);
    }
    return res;
}

class Vehicle extends EventEmitter {
    constructor(log) {
        super();
        this.log = log || (() => {});
        this.speed = null;
        this.away = false;          // машину закрыли и ушли
        this.conditionSeen = false;
        this._started = false;
        this._activeT = Date.now();
    }

    start() {
        if (this._started) return;
        this._started = true;
        // скорость и рычаг — одно поле на интерфейс в своей подписке, как в прототипе (разные интервалы опроса)
        watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const k = v && v.speedVehicleCentreOfGravity;
                if (typeof k !== 'number' || k === 65535) return;
                const was = this.moving();
                this.speed = k * 0.015625;
                if (this.speed > 1 && this.speed < 400) this.active();
                if (was !== this.moving()) this.emit('change');
            }
        }, this.log, 2000);
        const cond = (field) => (v) => {
            const n = conditionFrom(v);
            if (n === undefined) return;
            if (!this.conditionSeen) this.log('состояние авто: из ' + field + ' (' + n + ')');
            this.conditionSeen = true;
            const away = n <= 3;
            if (away !== this.away) { this.away = away; this.emit('change'); }
        };
        watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: cond('VehicleCondition'),
            vehicleConditionNoCrc: cond('vehicleConditionNoCrc')
        }, this.log);
        setInterval(() => {
            if (this.conditionSeen || this.away || Date.now() - this._activeT <= IDLE_MS) return;
            this.log('состояние авто: нет от машины, не ездили и не пользовались ' + IDLE_MS / 60000 + ' мин — стоянка');
            this.away = true;
            this.emit('change');
        }, 30000);
    }

    /* Кто-то пользуется машиной или приложением (для машин без VehicleCondition). */
    active() {
        this._activeT = Date.now();
        if (!this.conditionSeen && this.away) { this.away = false; this.emit('change'); }
    }

    /* Рычаг дальнего: подписка только когда включён запуск рычагом (как в прототипе). */
    watchBeam() {
        if (this._beam) return;
        this._beam = watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusLightStatus: (v) => this.emit('beam', beamOf(v && v.statusMainBeam_headlightFlasher), Date.now())
        }, this.log, 500).then((r) => { if (r.error) this._beam = null; return r; });
    }

    moving() { return this.speed !== null && this.speed > MAX_KMH; }
    kmh() { return this.speed === null ? null : Math.round(this.speed); }
}

module.exports = { Vehicle, MAX_KMH, conditionFrom, beamOf };
