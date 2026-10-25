/* ESP32 PLC ladder engine: program model, encoder, and a scan-cycle machine.
 * The Machine below must behave exactly like firmware/esp32_plc/plc_engine.h.
 * Works in the browser (window.PLC) and in Node (module.exports). */
(function (root) {
  'use strict';

  const ROWS = 4, COLS = 8, NCOL = 9, CELLS = 36, RB = 76, MAX_RUNGS = 40;
  const NT = 8, NCNT = 4;

  // Cell types. Logic cells go in columns 1-8, output cells only in column 9.
  const TYPE = {
    EMPTY: 0, WIRE: 1, NO: 2, NC: 3, RISE: 4, FALL: 5,
    OUT: 16, OUTN: 17, SET: 18, RESET: 19, TON: 20, TOF: 21, CTU: 22, CTD: 23, CRES: 24
  };
  const TYPE_NAME = {};
  Object.keys(TYPE).forEach(k => { TYPE_NAME[TYPE[k]] = k; });
  const isContact = t => t >= 2 && t <= 5;
  const isOutput = t => t >= 16 && t <= 24;

  // Bit addresses: kind*32 + index. Kinds: I inputs, Q relays, M markers, T timer done, C counter done.
  const KINDS = ['I', 'Q', 'M', 'T', 'C'];
  const COUNTS = [4, 4, 16, NT, NCNT];

  function addr(name) {
    if (typeof name !== 'string' || name.length < 2) return -1;
    const k = KINDS.indexOf(name[0].toUpperCase());
    const i = parseInt(name.slice(1), 10) - 1;
    if (k < 0 || isNaN(i) || i < 0 || i >= COUNTS[k]) return -1;
    return k * 32 + i;
  }
  function nameOf(a) { return KINDS[a >> 5] + ((a & 31) + 1); }

  // Which operand kinds each element accepts
  const OPERAND_KINDS = {
    NO: [0, 1, 2, 3, 4], NC: [0, 1, 2, 3, 4], RISE: [0, 1, 2, 3, 4], FALL: [0, 1, 2, 3, 4],
    OUT: [1, 2], OUTN: [1, 2], SET: [1, 2], RESET: [1, 2],
    TON: [3], TOF: [3], CTU: [4], CTD: [4], CRES: [4]
  };

  function newRung() {
    return { comment: '', cells: new Array(CELLS).fill(null), links: new Array(27).fill(false) };
  }
  function newProgram() {
    return {
      format: 'esp32-plc-ladder', version: 1, name: 'Untitled',
      timers: new Array(NT).fill(1000),     // preset in ms
      counters: new Array(NCNT).fill(10),   // preset count
      rungs: [newRung()]
    };
  }

  function encodeRung(rung) {
    const b = new Uint8Array(RB);
    for (let i = 0; i < CELLS; i++) {
      const c = rung.cells[i];
      if (c && TYPE[c.t] !== undefined) {
        b[2 * i] = TYPE[c.t];
        const a = addr(c.a);
        b[2 * i + 1] = a < 0 ? 0 : a;
      }
    }
    let lk = 0;
    for (let i = 0; i < 27; i++) if (rung.links[i]) lk |= (1 << i);
    b[72] = lk & 255; b[73] = (lk >>> 8) & 255; b[74] = (lk >>> 16) & 255; b[75] = (lk >>> 24) & 255;
    return b;
  }
  function toHex(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16); return s; }
  function fromHex(s) {
    const u = new Uint8Array(s.length >> 1);
    for (let i = 0; i < u.length; i++) u[i] = parseInt(s.substr(2 * i, 2), 16);
    return u;
  }
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i) & 255; h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function hex8(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  // Program -> transfer lines (without BEGIN/END) plus byte arrays for local simulation
  function compile(prog) {
    const lines = [];
    for (let i = 0; i < NT; i++) lines.push('T ' + i + ' ' + Math.max(0, Math.round(prog.timers[i])));
    for (let i = 0; i < NCNT; i++) lines.push('K ' + i + ' ' + Math.min(9999, Math.max(0, Math.round(prog.counters[i]))));
    const rungs = prog.rungs.map(encodeRung);
    rungs.forEach((b, i) => lines.push('R ' + i + ' ' + toHex(b)));
    const h = fnv1a(lines.join(''));
    return {
      lines, rungs, hash: hex8(h), count: rungs.length,
      tpre: prog.timers.map(x => Math.max(0, Math.round(x))), cpre: prog.counters.map(x => Math.min(9999, Math.max(0, Math.round(x)))),
      endLine: 'END ' + rungs.length + ' ' + hex8(h)
    };
  }

  // Check a program; returns [{level:'error'|'warn', msg, rung}]
  function validate(prog) {
    const out = [];
    if (prog.rungs.length > MAX_RUNGS) out.push({ level: 'error', msg: 'Too many rungs (max ' + MAX_RUNGS + ')' });
    const timerMode = {}, outWrites = {};
    prog.rungs.forEach((rg, ri) => {
      rg.cells.forEach((c, ci) => {
        if (!c) return;
        const col = ci % NCOL;
        if (isOutput(TYPE[c.t]) && col !== COLS) out.push({ level: 'error', rung: ri, msg: 'Output element outside column 9' });
        if ((isContact(TYPE[c.t])) && col === COLS) out.push({ level: 'error', rung: ri, msg: 'Contact in output column' });
        if (c.t === 'WIRE') return;
        const a = addr(c.a);
        if (a < 0) { out.push({ level: 'error', rung: ri, msg: 'Missing or bad address on ' + c.t }); return; }
        const ok = OPERAND_KINDS[c.t];
        if (ok && ok.indexOf(a >> 5) < 0) out.push({ level: 'error', rung: ri, msg: c.t + ' cannot use ' + c.a });
        if (c.t === 'TON' || c.t === 'TOF') {
          if (timerMode[c.a] && timerMode[c.a] !== c.t) out.push({ level: 'error', rung: ri, msg: c.a + ' is used as both TON and TOF' });
          if (timerMode[c.a] === c.t) out.push({ level: 'warn', rung: ri, msg: c.a + ' is used by two timer blocks' });
          timerMode[c.a] = c.t;
        }
        if (c.t === 'OUT' || c.t === 'OUTN') {
          if (outWrites[c.a] !== undefined && outWrites[c.a] !== ri) out.push({ level: 'warn', rung: ri, msg: c.a + ' is driven by a coil in rung ' + (outWrites[c.a] + 1) + ' too; the later rung wins' });
          outWrites[c.a] = ri;
        }
      });
    });
    return out;
  }

  class Machine {
    constructor(comp) {
      this.rungs = comp.rungs;
      this.tpre = comp.tpre.slice();
      this.cpre = comp.cpre.slice();
      this.reset();
    }
    reset() {
      this.I = new Uint8Array(4); this.Q = new Uint8Array(4); this.M = new Uint8Array(16);
      this.Td = new Uint8Array(NT); this.Tacc = new Uint32Array(NT); this.Cnt = new Int32Array(NCNT);
      this.prev = new Uint8Array(this.rungs.length * CELLS);
      this.flowIn = this.rungs.map(() => new Uint8Array(CELLS));
      this.flowOut = this.rungs.map(() => new Uint8Array(CELLS));
    }
    bit(a) {
      const k = a >> 5, i = a & 31;
      switch (k) {
        case 0: return i < 4 ? this.I[i] : 0;
        case 1: return i < 4 ? this.Q[i] : 0;
        case 2: return i < 16 ? this.M[i] : 0;
        case 3: return i < NT ? this.Td[i] : 0;
        case 4: return i < NCNT ? (this.Cnt[i] >= this.cpre[i] ? 1 : 0) : 0;
      }
      return 0;
    }
    setBit(a, v) {
      const k = a >> 5, i = a & 31;
      if (k === 1 && i < 4) this.Q[i] = v ? 1 : 0;
      else if (k === 2 && i < 16) this.M[i] = v ? 1 : 0;
    }
    step(dt, inputs) {
      if (inputs) for (let i = 0; i < 4; i++) this.I[i] = inputs[i] ? 1 : 0;
      for (let r = 0; r < this.rungs.length; r++) this.evalRung(r, dt, false);
    }
    // Recompute power flow without changing any state (used by the live monitor)
    flowOnly() {
      for (let r = 0; r < this.rungs.length; r++) this.evalRung(r, 0, true);
    }
    evalRung(ri, dt, dry) {
      const b = this.rungs[ri], base = ri * CELLS;
      const lk = ((b[72] | (b[73] << 8) | (b[74] << 16) | (b[75] << 24)) >>> 0);
      const fi = this.flowIn[ri], fo = this.flowOut[ri];
      const p = [1, 1, 1, 1];
      for (let n = 0; n < NCOL; n++) {
        let r = 0;
        while (r < ROWS) {
          let e = r;
          while (e < ROWS - 1 && ((lk >>> (e * 9 + n)) & 1)) e++;
          if (e > r) {
            let v = 0;
            for (let k = r; k <= e; k++) v |= p[k];
            for (let k = r; k <= e; k++) p[k] = v;
          }
          r = e + 1;
        }
        if (n < COLS) {
          for (let r2 = 0; r2 < ROWS; r2++) {
            const ci = r2 * NCOL + n, t = b[2 * ci], op = b[2 * ci + 1], pin = p[r2];
            let out = 0;
            fi[ci] = pin;
            switch (t) {
              case 0: out = r2 === 0 ? pin : 0; break;
              case 1: out = pin; break;
              case 2: out = pin & this.bit(op); break;
              case 3: out = pin & (this.bit(op) ^ 1); break;
              case 4: { const v = this.bit(op); out = pin & v & (this.prev[base + ci] ^ 1); if (!dry) this.prev[base + ci] = v; break; }
              case 5: { const v = this.bit(op); out = pin & (v ^ 1) & this.prev[base + ci]; if (!dry) this.prev[base + ci] = v; break; }
              default: out = 0;
            }
            fo[ci] = out; p[r2] = out;
          }
        } else {
          for (let r2 = 0; r2 < ROWS; r2++) {
            const ci = r2 * NCOL + n, t = b[2 * ci], op = b[2 * ci + 1], pin = p[r2];
            fi[ci] = pin; fo[ci] = pin;
            if (dry || t < 16) continue;
            const idx = op & 31;
            switch (t) {
              case 16: this.setBit(op, pin); break;
              case 17: this.setBit(op, pin ^ 1); break;
              case 18: if (pin) this.setBit(op, 1); break;
              case 19: if (pin) this.setBit(op, 0); break;
              case 20: // TON
                if (idx < NT) {
                  if (pin) { this.Tacc[idx] = Math.min(this.Tacc[idx] + dt, 0x7fffffff); this.Td[idx] = this.Tacc[idx] >= this.tpre[idx] ? 1 : 0; }
                  else { this.Tacc[idx] = 0; this.Td[idx] = 0; }
                }
                break;
              case 21: // TOF
                if (idx < NT) {
                  if (pin) { this.Td[idx] = 1; this.Tacc[idx] = 0; }
                  else if (this.Td[idx]) {
                    this.Tacc[idx] = Math.min(this.Tacc[idx] + dt, 0x7fffffff);
                    if (this.Tacc[idx] >= this.tpre[idx]) { this.Td[idx] = 0; this.Tacc[idx] = 0; }
                  }
                }
                break;
              case 22: // CTU
                if (idx < NCNT) { if (pin && !this.prev[base + ci] && this.Cnt[idx] < 9999) this.Cnt[idx]++; this.prev[base + ci] = pin; }
                break;
              case 23: // CTD
                if (idx < NCNT) { if (pin && !this.prev[base + ci] && this.Cnt[idx] > 0) this.Cnt[idx]--; this.prev[base + ci] = pin; }
                break;
              case 24: // CRES
                if (idx < NCNT && pin) this.Cnt[idx] = 0;
                break;
            }
          }
        }
      }
    }
    // Load a snapshot reported by the ESP32 (for the live monitor)
    loadState(s) {
      for (let i = 0; i < 4; i++) { this.I[i] = (s.i >> i) & 1; this.Q[i] = (s.q >> i) & 1; }
      for (let i = 0; i < 16; i++) this.M[i] = (s.m >> i) & 1;
      for (let i = 0; i < NT; i++) { this.Td[i] = (s.t >> i) & 1; this.Tacc[i] = s.acc[i] || 0; }
      for (let i = 0; i < NCNT; i++) this.Cnt[i] = s.c[i] || 0;
    }
  }

  const api = {
    ROWS, COLS, NCOL, CELLS, RB, MAX_RUNGS, NT, NCNT, TYPE, TYPE_NAME, KINDS, COUNTS, OPERAND_KINDS,
    isContact, isOutput, addr, nameOf, newRung, newProgram, encodeRung, toHex, fromHex, fnv1a, hex8,
    compile, validate, Machine
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PLC = api;
})(typeof window !== 'undefined' ? window : globalThis);
