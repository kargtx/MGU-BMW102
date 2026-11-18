'use strict';
/**
 * lever.js — BMW102: рычаг дальнего. 5 коротких нажатий (моргнуть дальним) за 10 с — запуск стробоскопа;
 * пока он мигает, следующее нажатие — остановка. По мотивам lever.js из Ambient config (idrive7-apps, MIT).
 *
 * Vehicle2.statusMainBeam_headlightFlasher включён, пока горит дальний или рычаг притянут, поэтому нажатием
 * считается только короткий импульс: включён не дольше PULSE_MS, затем выключен. Дольше — это включили дальний:
 * счёт нажатий сбрасывается. После запуска или остановки COOL_MS ничего не считается (хвост последнего нажатия).
 *
 *   const lv = new Lever(); lv.beam(on, t) -> null | 'pull' (нажатие) | 'start' (пятое нажатие за 10 с); lv.cool(t)
 */
const PULSE_MS = 1500, COOL_MS = 2000, COUNT = 5, WINDOW_MS = 10000;

/* Значение сигнала: true вкл, false выкл, null неизвестно (имена или числа). */
const beamOf = (v) => (v === 'EIN' || v === 1 ? true : v === 'AUS' || v === 0 ? false : null);

class Lever {
    constructor() { this.onAt = null; this.coolUntil = 0; this.pulls = []; }

    beam(on, t) {
        if (on === null) { this.onAt = null; this.pulls = []; return null; }
        if (on) {
            if (this.onAt === null) this.onAt = t;
            return null;
        }
        const held = this.onAt !== null ? t - this.onAt : null;
        this.onAt = null;
        if (held === null) return null;
        if (held > PULSE_MS) { this.pulls = []; return null; }      // включали дальний, а не моргали
        if (t < this.coolUntil) return null;
        this.pulls = this.pulls.filter((p) => t - p <= WINDOW_MS).concat([t]);
        if (this.pulls.length >= COUNT) { this.pulls = []; return 'start'; }
        return 'pull';
    }

    cool(t) { this.coolUntil = t + COOL_MS; this.pulls = []; }
}

module.exports = { Lever, beamOf, PULSE_MS, COOL_MS, COUNT, WINDOW_MS };
