/* Example programs for the ladder editor. Each builder returns a program object. */
(function (root) {
  'use strict';
  const P = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.PLC;

  // rungSpec: { c: 'comment', cells: [[row, col, type, addr], ...], links: [[row, node], ...] }
  function build(name, timers, counters, specs) {
    const p = P.newProgram();
    p.name = name;
    (timers || []).forEach((v, i) => { p.timers[i] = v; });
    (counters || []).forEach((v, i) => { p.counters[i] = v; });
    p.rungs = specs.map(s => {
      const r = P.newRung();
      r.comment = s.c || '';
      (s.cells || []).forEach(([row, col, t, a]) => { r.cells[row * 9 + col] = t === 'WIRE' ? { t } : { t, a }; });
      (s.links || []).forEach(([row, node]) => { r.links[row * 9 + node] = true; });
      return r;
    });
    return p;
  }

  const EXAMPLES = [
    {
      id: 'seal', title: 'Start / stop with seal-in',
      make: () => build('Start-Stop seal-in', [], [], [
        { c: 'I1 = START, I2 = STOP (normally closed). Q1 holds itself on through its own contact.',
          cells: [[0, 0, 'NO', 'I1'], [0, 1, 'NC', 'I2'], [1, 0, 'NO', 'Q1'], [0, 8, 'OUT', 'Q1']], links: [[0, 1]] }
      ])
    },
    {
      id: 'latch', title: 'RS latch block',
      make: () => build('RS latch', [], [], [
        { c: 'RS1: I1 sets (S input), I2 resets (R input). Reset wins if both are on.',
          cells: [[0, 0, 'NO', 'I1'], [1, 0, 'NO', 'I2'], [0, 8, 'RSS', 'RS1'], [1, 8, 'RSR', 'RS1']] },
        { c: 'Use RS1 as a contact anywhere. Here it drives relay Q1.', cells: [[0, 0, 'NO', 'RS1'], [0, 8, 'OUT', 'Q1']] }
      ])
    },
    {
      id: 'ton', title: 'On-delay and off-delay timers',
      make: () => build('On-delay / off-delay', [3000, 3000], [], [
        { c: 'TON: I1 must stay on for 3 s before T1 is done.', cells: [[0, 0, 'NO', 'I1'], [0, 8, 'TON', 'T1']] },
        { c: 'Q1 follows T1 (on-delay).', cells: [[0, 0, 'NO', 'T1'], [0, 8, 'OUT', 'Q1']] },
        { c: 'TOF: T2 turns on with I2 and stays on 3 s after I2 turns off.', cells: [[0, 0, 'NO', 'I2'], [0, 8, 'TOF', 'T2']] },
        { c: 'Q2 follows T2 (off-delay).', cells: [[0, 0, 'NO', 'T2'], [0, 8, 'OUT', 'Q2']] }
      ])
    },
    {
      id: 'flash', title: 'Flasher (two timers)',
      make: () => build('Flasher', [500, 500], [], [
        { c: 'I1 enables the flasher. T2 breaks the loop to restart it.', cells: [[0, 0, 'NO', 'I1'], [0, 1, 'NC', 'T2'], [0, 8, 'TON', 'T1']] },
        { c: 'T2 starts when T1 is done.', cells: [[0, 0, 'NO', 'T1'], [0, 8, 'TON', 'T2']] },
        { c: 'Q1 is on while T1 is done: 0.5 s on, 0.5 s off.', cells: [[0, 0, 'NO', 'T1'], [0, 8, 'OUT', 'Q1']] }
      ])
    },
    {
      id: 'counter', title: 'Up / down counter',
      make: () => build('Up-down counter', [], [3], [
        { c: 'Each press of I1 counts up.', cells: [[0, 0, 'NO', 'I1'], [0, 8, 'CTU', 'C1']] },
        { c: 'Each press of I2 counts down.', cells: [[0, 0, 'NO', 'I2'], [0, 8, 'CTD', 'C1']] },
        { c: 'I3 resets the count to zero.', cells: [[0, 0, 'NO', 'I3'], [0, 8, 'CRES', 'C1']] },
        { c: 'Q1 is on when the count reaches the preset (3).', cells: [[0, 0, 'NO', 'C1'], [0, 8, 'OUT', 'Q1']] }
      ])
    },
    {
      id: 'edge', title: 'Edge contacts: one-shot and toggle',
      make: () => build('Edge contacts', [], [], [
        { c: 'M1 is on for one scan when I1 rises.', cells: [[0, 0, 'RISE', 'I1'], [0, 8, 'OUT', 'M1']] },
        { c: 'Toggle Q1 on every press of I1: Q1 flips when M1 is on (exclusive OR of Q1 and M1).',
          cells: [[0, 0, 'NO', 'M1'], [0, 1, 'NC', 'Q1'], [1, 0, 'NC', 'M1'], [1, 1, 'NO', 'Q1'], [0, 8, 'OUT', 'Q1']], links: [[0, 2]] },
        { c: 'M2 is on for one scan when I2 falls (released).', cells: [[0, 0, 'FALL', 'I2'], [0, 8, 'OUT', 'M2']] }
      ])
    }
  ];

  const api = { build, EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PLC_EXAMPLES = api;
})(typeof window !== 'undefined' ? window : globalThis);
