'use strict';
/**
 * Клиент root-демона BMW102 G-xDrive (engine/daemon.py).
 * Построчный JSON поверх unix-сокета. Нужны только net и events
 * (Node 8 и песочница OAP-приложения) — как client.js у Store.
 *
 *   const c = new XDriveClient('/dev/shm/bmw102-xdrive/xdrive.sock',
 *                              { reconnectMs: 2000, secret });
 *   c.on('state',  (st)  => render(st));   // при подключении и на изменения
 *   c.on('result', (r)   => showResult(r));// итог probe/disable
 *   c.on('reply-error', (msg, op) => ...);
 *   c.connect();
 *   c.probe();  c.disable();
 */
const net = require('net');
const EventEmitter = require('events');

class XDriveClient extends EventEmitter {
    constructor(socketPath, opts) {
        super();
        this.path = socketPath;
        this.reconnectMs = (opts && opts.reconnectMs) || 0;
        this.secret = (opts && opts.secret) || null;
        this.sock = null;
        this.closed = false;
        this.timer = null;
    }

    connect() {
        if (this.closed || this.sock) {
            return;
        }
        let buf = '';
        const sock = net.connect(this.path);
        this.sock = sock;
        sock.setEncoding('utf8');
        sock.on('data', (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch (e) {
                    continue;
                }
                if (msg.type === 'state') {
                    this.emit('state', msg);
                } else if (msg.type === 'result') {
                    this.emit('result', msg);
                } else if (msg.type === 'error') {
                    this.emit('reply-error', msg.error, msg.op);
                }
            }
        });
        sock.on('error', (err) => {
            if (!this.reconnectMs) {
                this.emit('error', err);
            }
        });
        sock.on('close', () => {
            this.sock = null;
            if (this.closed) {
                return;
            }
            if (this.reconnectMs) {
                this.emit('down');
                this.timer = setTimeout(() => {
                    this.timer = null;
                    this.connect();
                }, this.reconnectMs);
            } else {
                this.emit('close');
            }
        });
    }

    send(req) {
        if (!this.sock) {
            return false;
        }
        this.sock.write(JSON.stringify(req) + '\n');
        return true;
    }

    setSecret(secret) {
        this.secret = secret || null;
    }

    status() {
        return this.send({ op: 'status' });
    }

    probe() {
        return this.send({ op: 'probe' });
    }

    disable() {
        return this.send(Object.assign({ op: 'disable' }, this.secret ? { secret: this.secret } : {}));
    }

    close() {
        this.closed = true;
        clearTimeout(this.timer);
        if (this.sock) {
            this.sock.end();
            this.sock = null;
        }
    }
}

module.exports = { XDriveClient };
