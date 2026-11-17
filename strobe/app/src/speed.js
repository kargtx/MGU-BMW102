'use strict';
/**
 * BMW102 · Стробоскопы — «машина стоит?» по скорости.
 *
 * Скорость — SOME/IP Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity (× 1/64 км/ч, 65535 — нет значения),
 * как kit/runtime/parked.js в idrive7-apps (MIT). Перечитывается каждые 2 с: стоящая машина может не присылать
 * скорость, которая не меняется. Тишина после стоянки — стоим; тишина после езды — едем (безопасная сторона),
 * пока снова не придёт скорость. Без скорости вовсе (стенд) машина считается стоящей, а экран это показывает.
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

    stop() { clearInterval(this._timer); this._timer = null; }

    moving() { return this.speed !== null && this.speed > MAX_KMH; }
    kmh() { return this.speed === null ? null : Math.round(this.speed); }
}

module.exports = { Speed, MAX_KMH };
