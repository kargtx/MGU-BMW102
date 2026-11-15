'use strict';
/**
 * Отключение xDrive (100% задний привод) до следующего цикла зажигания, только G-кузов.
 * Логика и адреса — из исследованного и проверенного на машинах приложения
 * idrive7-apps / live_adjustments (xdrive.js, issue #28, #52, #63):
 *
 *   DSC 0x29, DID 0xDBE1 = LMV_FUNKTION («распределение момента на текущий цикл КЛ15»):
 *     идентификация : 22 F1 50       -> 62 F1 50 <индекс SGBD>
 *     отключить     : 2E DB E1 00    -> 6E DB E1
 *   На части машин (G05 X5/X7 и др.) по 0x29 стоит IB, который запись принимает,
 *   но привод не отключает — там путь через VIP 0x39:
 *     отключить     : 2E DB 2F 00    -> 6E DB 2F
 *   NRC 7E/7F («не в этой сессии») -> 10 03 (расширенная сессия) и та же запись ещё раз.
 *
 * Условия (DSC): зажигание ВКЛ, двигатель заглушен, P, стояночный тормоз, машина стоит.
 * VIP 0F2520 (ДВС G05): зажигание ВКЛ, двигатель ЗАГЛУШЕН (заведённый отвечает NRC 33).
 * Полный привод возвращается после полного цикла зажигания.
 */
const { replyTo, hex, bytesHex } = require('./tasu.js');

const DSC = 0x29;
const VIP = 0x39;
const DID_SGBD = [0xF1, 0x50];
const DID_DSC_LMV = [0xDB, 0xE1];
const DID_VIP_LMV = [0xDB, 0x2F];
const SESSION_NRC = [0x7E, 0x7F];

const DBE1_UNITS = {
    '0F1970': 'DSC_I1', '0F1C50': 'DSC_I1', '0F1CE0': 'DSC_I1', '0F2100': 'DSC_G11',
    '0F2510': 'DSC_G20', '0F2850': 'DSC_G30N', '0F2CE0': 'IB_G2X'
};
const OTHER_UNITS = { '0F2500': 'IB_G05', '0F29F0': 'IB_I20', '0F2E70': 'IB_G70' };
const VIP_UNITS = { '0F2520': 'VIP_G05', '0F2530': 'VIP_G05', '0F2860': 'VIP_G30N' };
const VIP_ENGINE_OFF = ['0F2520'];

const NRC_TEXT = {
    0x10: 'общий отказ', 0x11: 'служба не поддерживается', 0x12: 'подфункция не поддерживается',
    0x13: 'неверная длина', 0x21: 'блок занят, повторите', 0x22: 'не выполнены условия (зажигание ВКЛ, двигатель заглушен, P, ручник)',
    0x24: 'неверная последовательность', 0x31: 'значение вне диапазона', 0x33: 'нужен доступ (security access)',
    0x7E: 'не поддерживается в этой сессии', 0x7F: 'не поддерживается в этой сессии'
};

function sgbdIndex(data) {
    return (data || []).slice(0, 3).map(hex).join('');
}

class XDrive {
    constructor(tasu, log) {
        this.tasu = tasu;
        this.log = log || (() => {});
        this.reset();
    }

    reset() {
        this.path = null;          // 'dsc' | 'vip'
        this.dscIndex = null;
        this.vipIndex = null;
    }

    unitName() {
        if (this.path === 'vip') return 'VIP ' + this.vipIndex + (VIP_UNITS[this.vipIndex] ? ' (' + VIP_UNITS[this.vipIndex] + ')' : '');
        return 'DSC ' + (this.dscIndex || '?') + (DBE1_UNITS[this.dscIndex] ? ' (' + DBE1_UNITS[this.dscIndex] + ')' : '');
    }

    _read(ecu, did) {
        return this.tasu.physical(ecu, 0x22, did, 3000, replyTo(0x22, did)).then((r) => {
            if (r && r[0] === 0x62) return { ok: true, data: r.slice(3) };
            return { ok: false, nrc: r && r[0] === 0x7F ? r[2] : null };
        });
    }

    /** Только чтение: какой блок стоит и каким путём отключать. */
    identify() {
        this.reset();
        return this._read(DSC, DID_SGBD).then((sg) => {
            if (sg.ok) this.dscIndex = sgbdIndex(sg.data);
            this.log('xdrive: 0x29 = ' + (this.dscIndex || 'нет ответа'));
            if (this.dscIndex && !DBE1_UNITS[this.dscIndex]) {
                return this._read(VIP, DID_SGBD).then((vp) => {
                    const vi = vp.ok ? sgbdIndex(vp.data) : null;
                    this.log('xdrive: 0x39 = ' + (vi || 'нет ответа'));
                    if (vi && VIP_UNITS[vi]) { this.path = 'vip'; this.vipIndex = vi; }
                });
            }
            return undefined;
        }).then(() => {
            if (!this.path && this.dscIndex) this.path = 'dsc';
            if (!this.path) {
                return { ok: false, message: 'Блок DSC (0x29) не ответил. Зажигание включено?' };
            }
            const known = this.path === 'vip' || DBE1_UNITS[this.dscIndex];
            const unit = this.dscIndex && OTHER_UNITS[this.dscIndex] && this.path === 'dsc'
                ? ' · ' + OTHER_UNITS[this.dscIndex] + ': эффект не гарантирован' : '';
            return {
                ok: true,
                message: 'Связь есть: ' + this.unitName() + (known ? '' : ' (вариант не проверен)') + unit +
                    (this.path === 'vip' && VIP_ENGINE_OFF.indexOf(this.vipIndex) >= 0 ? ' · двигатель должен быть заглушен' : '')
            };
        });
    }

    _write() {
        const vip = this.path === 'vip';
        const did = vip ? DID_VIP_LMV : DID_DSC_LMV;
        return this.tasu.physical(vip ? VIP : DSC, 0x2E, did.concat([0x00]), 3000,
            (u) => (u[0] === 0x6E && u[1] === did[0] && u[2] === did[1]) || (u[0] === 0x7F && u[1] === 0x2E));
    }

    /** Отключить полный привод. Сначала определяет блок, если ещё не определён. */
    disable() {
        const ready = this.path ? Promise.resolve({ ok: true }) : this.identify();
        return ready.then((id) => {
            if (!id.ok) return id;
            const vip = this.path === 'vip';
            const name = vip ? 'VIP' : 'DSC', ecu = vip ? VIP : DSC;
            return this._write().then((r) => {
                if (r && r[0] === 0x7F && SESSION_NRC.indexOf(r[2]) >= 0) {
                    this.log('xdrive: ' + name + ' просит расширенную сессию: 10 03');
                    return this.tasu.physical(ecu, 0x10, [0x03], 3000,
                        (u) => (u[0] === 0x50 && u[1] === 0x03) || (u[0] === 0x7F && u[1] === 0x10))
                        .then((ses) => (ses && ses[0] === 0x50 ? this._write() : ['session', ses && ses[0] === 0x7F ? ses[2] : null]));
                }
                return r;
            }).then((r) => {
                if (r && r[0] === 0x6E) {
                    return { ok: true, message: 'xDrive ОТКЛЮЧЁН (' + this.unitName() + '). Заводите двигатель, НЕ выключая зажигание. Вернётся после цикла зажигания.' };
                }
                if (r && r[0] === 'session') {
                    return { ok: false, message: name + ' не открыл расширенную сессию' + (r[1] != null ? ' (NRC ' + hex(r[1]) + ')' : '') };
                }
                if (r && r[0] === 0x7F) {
                    const why = vip && r[2] === 0x33 && VIP_ENGINE_OFF.indexOf(this.vipIndex) >= 0
                        ? 'двигатель работает — заглушите, оставьте зажигание и повторите'
                        : vip && r[2] === 0x33 ? 'нужен доступ: попробуйте режим диагностики (3× Start без тормоза)'
                        : NRC_TEXT[r[2]] || 'NRC ' + hex(r[2]);
                    return { ok: false, message: name + ' отказал: ' + why };
                }
                return { ok: false, message: 'Нет ответа от ' + name + (r ? ' (' + bytesHex(r) + ')' : '') };
            });
        });
    }
}

module.exports = { XDrive, DSC, VIP, DBE1_UNITS, VIP_UNITS };
