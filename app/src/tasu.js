'use strict';
/**
 * UDS через TASU — собственный диагностический транспорт МГУ (SOME/IP
 * com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu), так же как
 * BMW ts_diagnostic_service и приложения idrive7-apps (kit/runtime/diag.js):
 *
 *   запрос : sendTasuRequest{ sourceAddress 0xF2, targetAddress (адрес ЭБУ), serviceID,
 *            subroutineID 0, udsDataLength, udsData = байты после service id, deadlockTime 0 }
 *   ответ  : событие sendTasuResponse{ udsResponse, errorCode }. Кадр с 9-байтовым заголовком:
 *            [2] 0x7F = отказ транспорта (код в [4]), [6] = адрес ответившего ЭБУ, UDS с [9].
 *
 * Настройки интерфейса установщик МГУ генерирует из manifest.json приложения в
 * <приложение>/someipInterfaces/. Нативный модуль someip — модуль самой МГУ (не Node).
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const TESTER = 0xF2;
const NATIVE_MODULE = 'someip';   // имя переменной: не литерал, линкер его не трогает

const hex = (n) => (n & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const bytesHex = (b) => (b || []).map(hex).join(' ');

function toBytes(b) {
    if (!b) return [];
    if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Array.prototype.slice.call(b);
    if (Array.isArray(b)) return b.slice();
    if (b.data) return toBytes(b.data);
    if (typeof b === 'object' && typeof b.length === 'number') return Array.prototype.slice.call(b);
    return [];
}

/* Нативная привязка зависает, если buildProxy/init/callMethod идут прямо внутри цепочек
 * промисов рядом с SOME/IP-трафиком SDK. SDK всегда зовёт их из нового setImmediate, по одному. */
let chain = Promise.resolve();
function nativeTick(fn) {
    const run = () => new Promise((resolve, reject) => setImmediate(() => {
        try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); }
    }));
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
}

function loadNative() {
    const tries = [
        () => process.mainModule && process.mainModule.require(NATIVE_MODULE),
        () => { const r = require; return r(NATIVE_MODULE); },
        () => module.constructor && module.constructor._load && module.constructor._load(NATIVE_MODULE)
    ];
    const errors = [];
    for (const t of tries) {
        try {
            const m = t();
            if (m && typeof m.buildProxy === 'function') return m;
        } catch (e) { errors.push(String(e && e.message || e)); }
    }
    throw new Error('нет модуля someip: ' + errors.join(' | '));
}

function configDirs() {
    const out = [];
    let d = __dirname;
    for (let i = 0; i < 5; i++) {
        out.push(path.join(d, 'someipInterfaces'));
        d = path.dirname(d);
    }
    return out;
}

function loadConfig() {
    const f = IFACE.replace(/\./g, '_') + '.json';
    for (const d of configDirs()) {
        try { return { cfg: JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')), file: path.join(d, f) }; } catch (e) { /* дальше */ }
    }
    throw new Error('нет настроек ' + f + ' (искал: ' + configDirs().join(', ') + ')');
}

class Tasu extends EventEmitter {
    constructor(log) {
        super();
        this.log = log || (() => {});
        this.p = null;
        this.available = false;
        this.error = null;
    }

    init() {
        if (this.p) return Promise.resolve(this);
        return Promise.resolve().then(() => {
            const someip = loadNative();
            const { cfg, file } = loadConfig();
            this.log('TASU: настройки ' + file);
            return nativeTick(() => someip.buildProxy(cfg, INSTANCE).then((p) => p.init().then(() => p)));
        }).then((p) => {
            this.p = p;
            return nativeTick(() => p.subscribe({ name: 'sendTasuResponse', onReceive: (v) => { try { this._onResponse(v); } catch (e) { this.log('TASU frame: ' + e); } } }));
        }).then(() => nativeTick(() => {
            try { return this.p.subscribeToAvailability((a) => { this.available = !!a; this.emit('available', this.available); }); } catch (e) { return null; }
        })).then(() => {
            if (this.p.isAvailable && this.p.isAvailable()) this.available = true;
            this.error = null;
            this.log('TASU готов (available=' + this.available + ')');
            return this;
        }).catch((e) => {
            this.p = null;
            this.error = String(e && e.message || e);
            this.log('TASU: ' + this.error);
            throw e;
        });
    }

    _onResponse(v) {
        const err = v && v.errorCode;
        if (err !== undefined && err !== 'NO_ERROR' && err !== 0) { this.emit('tasError', String(err)); return; }
        const b = toBytes(v && (v.udsResponse !== undefined ? v.udsResponse : v));
        if (b.length >= 5 && b[2] === 0x7F) { this.emit('tasReject', b[4]); return; }
        if (b.length < 10) return;
        this.emit('frame', { ecu: b[6], uds: b.slice(9) });
    }

    /* Один запрос; вердикт транспорта. «Занят» повторяется с растущей паузой. */
    send(target, sid, data) {
        if (!this.p) return Promise.reject(new Error(this.error || 'нет диагностического канала'));
        const d = data || [];
        const attempt = (n) => nativeTick(() => this.p.callMethod('sendTasuRequest', {
            sourceAddress: TESTER, targetAddress: target, serviceID: sid, subroutineID: 0,
            udsDataLength: d.length, udsData: Buffer.from(d), deadlockTime: 0
        }, 8000)).then((r) => {
            const v = r && typeof r === 'object' ? (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
            const verdict = v === undefined ? 'NO_ERROR' : String(v);
            if (!/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) || n >= 4) return verdict;
            return new Promise((res) => setTimeout(res, 1000 * (n + 1))).then(() => attempt(n + 1));
        });
        this.log('UDS -> ' + hex(target) + ': ' + bytesHex([sid].concat(d)));
        return attempt(0);
    }

    /**
     * Физический запрос к одному ЭБУ; UDS-ответ или null по таймауту.
     * Кадры получают все приложения, поэтому accept(uds) отбирает ответ именно на этот запрос.
     */
    physical(target, sid, data, timeoutMs, accept) {
        let t = null, onFrame, finish, done = false;
        const got = new Promise((resolve) => {
            finish = (v) => {
                if (done) return;
                done = true;
                clearTimeout(t);
                this.removeListener('frame', onFrame);
                if (v) this.log('UDS <- ' + hex(target) + ': ' + bytesHex(v));
                resolve(v);
            };
            onFrame = (f) => {
                if (f.ecu !== target) return;
                if (f.uds[0] === 0x7F && f.uds[2] === 0x78) {     // «ждите»: не сам ответ
                    if (f.uds[1] !== sid) return;
                    clearTimeout(t);
                    t = setTimeout(() => finish(null), 10000);
                    return;
                }
                if (accept && !accept(f.uds)) return;
                finish(f.uds);
            };
            this.on('frame', onFrame);
        });
        return this.send(target, sid, data).then((verdict) => {
            if (verdict !== 'NO_ERROR' && verdict !== 'REQUEST_PENDING' && verdict !== '0' && verdict !== '1') {
                finish(null);
                throw new Error('транспорт отказал: ' + verdict);
            }
            if (!done && !t) t = setTimeout(() => finish(null), timeoutMs || 4000);
            return got;
        }, (e) => { finish(null); throw e; });
    }
}

/* Байты запроса, которые повторяет положительный ответ после sid+0x40. */
const ECHO = { 0x10: 1, 0x11: 1, 0x22: 2, 0x2E: 2, 0x31: 3 };
function replyTo(sid, data) {
    const echo = (data || []).slice(0, ECHO[sid] || 0);
    return (u) => (u[0] === sid + 0x40 && echo.every((b, i) => u[i + 1] === b)) || (u[0] === 0x7F && u[1] === sid);
}

module.exports = { Tasu, replyTo, hex, bytesHex, IFACE, INSTANCE };
