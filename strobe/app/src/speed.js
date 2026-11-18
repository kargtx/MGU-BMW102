'use strict';
/**
 * BMW102 · Стробоскопы — «машина стоит?» по скорости.
 *
 * Скорость — SOME/IP Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity (× 1/64 км/ч, 65535 — нет значения),
 * как kit/runtime/parked.js в idrive7-apps (MIT). Перечитывается каждые 2 с: стоящая машина может не присылать
 * скорость, которая не меняется. Тишина после стоянки — стоим; тишина после езды — едем (безопасная сторона),
 * пока снова не придёт скорость. Без скорости вовсе (стенд) машина считается стоящей, а экран это показывает.
 *
 * Рычаг дальнего: Vehicle2.statusLightStatus.statusMainBeam_headlightFlasher, по подписке и каждые 0,5 с
 * (после watchBeam()); событие 'beam' (true | false | null, t).
 *
 *   const sp = new Speed(log); sp.start();   sp.moving() -> true | false   sp.kmh() -> число | null   sp.error
 * Нужен в manifest.json: "de.bmw.infotainment.vehicle.Vehicle2": { instances ["1"], attributes { statusCarSpeed2 "rs" } }.
 */
const EventEmitter = require('events');
const { nativeTick, loadNative, loadConfig } = require('./tasu.js');

const IFACE = 'de.bmw.infotainment.vehicle.Vehicle2';
const FIELD = 'statusCarSpeed2';
const MAX_KMH = 3;
const POLL_MS = 2000;
const BEAM = 'statusLightStatus';
const BEAM_POLL_MS = 500;
const beamOf = (v) => (v === 'EIN' || v === 1 ? true : v === 'AUS' || v === 0 ? false : null);

class Speed extends EventEmitter {
    constructor(log) {
        super();
        this.log = log || (() => {});
        this.speed = null;
        this.error = null;
        this.p = null;
        this.available = false;
        this._timer = null;
    }

    _take(v) {
        const k = v && (v.speedVehicleCentreOfGravity !== undefined ? v.speedVehicleCentreOfGravity
            : v[FIELD] && v[FIELD].speedVehicleCentreOfGravity);
        if (typeof k !== 'number' || k === 65535) return;
        const was = this.moving();
        this.speed = k * 0.015625;
        if (this.moving() !== was) this.emit('change');
    }

    _fetch() {
        if (!this.p || !this.available || typeof this.p.getValue !== 'function') return;
        nativeTick(() => this.p.getValue(FIELD, 3000)).then((v) => this._take(v)).catch(() => {});
    }

    start() {
        if (this.p || this._starting) return this._starting || Promise.resolve(this);
        this._starting = Promise.resolve().then(() => {
            const someip = loadNative();
            const { cfg } = loadConfig(IFACE);
            return nativeTick(() => someip.buildProxy(cfg, '1').then((p) => p.init().then(() => p)));
        }).then((p) => {
            this.p = p;
            return nativeTick(() => {
                try { return p.subscribeToAvailability((a) => { this.available = !!a; if (a) setImmediate(() => this._fetch()); }); } catch (e) { return null; }
            });
        }).then(() => nativeTick(() => this.p.subscribe({ name: FIELD, onReceive: (v) => { try { this._take(v); } catch (e) { /* кадр без скорости */ } } })))
            .then(() => {
                if (this.p.isAvailable && this.p.isAvailable()) { this.available = true; this._fetch(); }
                this._timer = setInterval(() => this._fetch(), POLL_MS);
                this.error = null;
                this._starting = null;
                this.log('скорость: подписка есть');
                return this;
            })
            .catch((e) => {
                this._starting = null;
                this.error = String(e && e.message || e);
                this.log('скорость: ' + this.error);
                return this;
            });
        return this._starting;
    }

    /* Рычаг дальнего: подписка и опрос (после start()). */
    watchBeam() {
        if (this._beamOn) return;
        this._beamOn = true;
        const take = (v) => this.emit('beam', beamOf(v && v.statusMainBeam_headlightFlasher), Date.now());
        const go = () => {
            if (!this.p) return;
            nativeTick(() => this.p.subscribe({ name: BEAM, onReceive: (v) => { try { take(v); } catch (e) { /* кадр без рычага */ } } }))
                .catch((e) => this.log('рычаг: ' + (e && e.message || e)));
            this._beamTimer = setInterval(() => {
                if (this.p && this.available && typeof this.p.getValue === 'function') {
                    nativeTick(() => this.p.getValue(BEAM, 3000)).then(take).catch(() => {});
                }
            }, BEAM_POLL_MS);
            this.log('рычаг: подписка есть');
        };
        Promise.resolve(this._starting || this.start()).then(go);
    }

    stop() { clearInterval(this._timer); this._timer = null; clearInterval(this._beamTimer); this._beamTimer = null; }

    moving() { return this.speed !== null && this.speed > MAX_KMH; }
    kmh() { return this.speed === null ? null : Math.round(this.speed); }
}

module.exports = { Speed, MAX_KMH, beamOf };
