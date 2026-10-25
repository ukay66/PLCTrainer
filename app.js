/* ESP32 PLC Ladder Editor: UI, simulator, file handling and Web Serial transfer. */
(function () {
  'use strict';
  const P = window.PLC, EXS = window.PLC_EXAMPLES.EXAMPLES;
  const $ = (s, el) => (el || document).querySelector(s);
  const CW = 96, CH = 66, PAD = 22, TOP = 3;
  const AUTOSAVE = 'esp32-plc-ladder-autosave';

  // ---------- state ----------
  let prog = P.newProgram();
  let sel = { ri: 0, r: 0, c: 0 };
  let undoStack = [], redoStack = [];
  let mode = 'edit';              // 'edit' | 'sim' | 'live'
  let machine = null;             // Machine used for sim or live display
  let simTimer = null, simInputs = [0, 0, 0, 0];
  let flowEls = [], valEls = [];
  let lastSentHash = null;
  let ser = { port: null, writer: null, reader: null, connected: false, pending: null, running: false, monitor: false, live: null };

  // ---------- helpers ----------
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function fmtMs(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (Math.round(ms / 10) / 100) + ' s';
    return (Math.round(ms / 600) / 100) + ' min';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function fixProgram(p) {
    const q = P.newProgram();
    q.name = typeof p.name === 'string' ? p.name.slice(0, 40) : 'Untitled';
    for (let i = 0; i < P.NT; i++) q.timers[i] = Number.isFinite(+p.timers?.[i]) ? +p.timers[i] : 1000;
    for (let i = 0; i < P.NCNT; i++) q.counters[i] = Number.isFinite(+p.counters?.[i]) ? +p.counters[i] : 10;
    q.rungs = (p.rungs || []).slice(0, P.MAX_RUNGS).map(r => {
      const g = P.newRung();
      g.comment = typeof r.comment === 'string' ? r.comment : '';
      for (let i = 0; i < P.CELLS; i++) {
        const c = r.cells?.[i];
        if (c && P.TYPE[c.t] !== undefined) g.cells[i] = c.t === 'WIRE' ? { t: 'WIRE' } : { t: c.t, a: String(c.a || '') };
      }
      for (let i = 0; i < 27; i++) g.links[i] = !!r.links?.[i];
      return g;
    });
    if (!q.rungs.length) q.rungs.push(P.newRung());
    return q;
  }

  // ---------- undo / autosave ----------
  function pushUndo() {
    undoStack.push(JSON.stringify(prog)); if (undoStack.length > 120) undoStack.shift(); redoStack = [];
  }
  function change(fn) {
    pushUndo(); fn(); afterChange();
  }
  function afterChange() {
    try { localStorage.setItem(AUTOSAVE, JSON.stringify(prog)); } catch (e) { /* storage may be blocked */ }
    if (mode === 'sim') startSim(true);
    $('#pname').value = prog.name;
    renderAll();
  }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(prog)); prog = fixProgram(JSON.parse(undoStack.pop())); clampSel(); afterChange(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(prog)); prog = fixProgram(JSON.parse(redoStack.pop())); clampSel(); afterChange(); }
  function clampSel() { sel.ri = Math.min(sel.ri, prog.rungs.length - 1); }

  // ---------- symbols ----------
  function symbolMarkup(t, cx, cy, label, sub, flowKey) {
    // flowKey: attribute for power highlighting of the symbol (or '')
    const fl = flowKey ? ` data-fl="${flowKey}"` : '';
    let s = '';
    switch (t) {
      case 'NO': case 'NC': case 'RISE': case 'FALL':
        s += `<g${fl} class="symg"><line class="sym" x1="${cx - 12}" y1="${cy - 13}" x2="${cx - 12}" y2="${cy + 13}"/><line class="sym" x1="${cx + 12}" y1="${cy - 13}" x2="${cx + 12}" y2="${cy + 13}"/>`;
        if (t === 'NC') s += `<line class="sym" x1="${cx - 9}" y1="${cy + 10}" x2="${cx + 9}" y2="${cy - 10}"/>`;
        if (t === 'RISE') s += `<text class="symtxt" x="${cx}" y="${cy + 4}">P</text>`;
        if (t === 'FALL') s += `<text class="symtxt" x="${cx}" y="${cy + 4}">N</text>`;
        s += '</g>';
        break;
      case 'OUT': case 'OUTN': case 'SET': case 'RESET': {
        s += `<g${fl} class="symg"><path class="sym" d="M${cx - 5} ${cy - 13} Q${cx - 17} ${cy} ${cx - 5} ${cy + 13}"/><path class="sym" d="M${cx + 5} ${cy - 13} Q${cx + 17} ${cy} ${cx + 5} ${cy + 13}"/>`;
        const ch = { OUTN: '/', SET: 'S', RESET: 'R' }[t];
        if (ch) s += `<text class="symtxt" x="${cx}" y="${cy + 4}">${ch}</text>`;
        s += '</g>';
        break;
      }
      case 'RSS':
        s += `<g${fl} class="symg"><rect class="sym fillsym" x="${cx - 24}" y="${cy - 15}" width="48" height="30" rx="3"/>` +
          `<text class="symtxt" x="${cx}" y="${cy + 4}">RS</text></g>`;
        break;
      case 'TON': case 'TOF': case 'CTU': case 'CTD': case 'CRES':
        s += `<g${fl} class="symg"><rect class="sym fillsym" x="${cx - 36}" y="${cy - 20}" width="72" height="40" rx="3"/>` +
          `<text class="symtxt" x="${cx}" y="${cy - 5}">${t}</text></g>`;
        break;
    }
    return s;
  }
  function halfWidth(t) { return t === 'NO' || t === 'NC' || t === 'RISE' || t === 'FALL' ? 12 : (t === 'OUT' || t === 'OUTN' || t === 'SET' || t === 'RESET') ? 15 : t === 'RSS' ? 24 : 36; }

  // ---------- rung rendering ----------
  function visibleRows(ri) {
    const g = prog.rungs[ri]; let last = 0;
    g.cells.forEach((c, i) => { if (c) last = Math.max(last, Math.floor(i / 9)); });
    g.links.forEach((l, i) => { if (l) last = Math.max(last, Math.floor(i / 9) + 1); });
    if (sel.ri === ri) last = Math.max(last, sel.r);
    return Math.min(4, Math.max(2, last + 2));
  }
  function cellLabelSub(cell) {
    const idx = (P.addr(cell.a) & 31);
    if (cell.t === 'TON' || cell.t === 'TOF') return fmtMs(prog.timers[idx]);
    if (cell.t === 'CTU' || cell.t === 'CTD' || cell.t === 'CRES') return 'PV ' + prog.counters[idx];
    return '';
  }
  function rungSVG(ri) {
    const g = prog.rungs[ri], vr = visibleRows(ri);
    const wm = P.wireMapFromRung(g);
    const W = PAD * 2 + CW * 9, H = vr * CH + TOP * 2;
    let s = `<svg class="rungsvg" viewBox="0 0 ${W} ${H}" data-ri="${ri}" role="group" aria-label="Rung ${ri + 1}">`;
    s += `<line class="rail" x1="${PAD}" y1="0" x2="${PAD}" y2="${H}"/><line class="rail" x1="${W - PAD}" y1="0" x2="${W - PAD}" y2="${H}"/>`;
    for (let r = 0; r < vr; r++) {
      for (let c = 0; c < 9; c++) {
        const x0 = PAD + c * CW, cx = x0 + CW / 2, cy = TOP + r * CH + CH / 2, ci = r * 9 + c;
        const cell = g.cells[ci], key = ri + ':' + ci;
        const isSel = sel.ri === ri && sel.r === r && sel.c === c;
        if (!cell) {
          if (c < 8 && wm[r * 8 + c]) s += `<line class="w" data-fl="o:${key}" x1="${x0}" y1="${cy}" x2="${x0 + CW}" y2="${cy}"/>`;
          else s += `<rect class="slotbg" x="${x0 + 8}" y="${cy - 17}" width="${CW - 16}" height="34" rx="4"/>`;
          if (r === 0 && c === 8) s += `<text class="slotlbl" x="${cx}" y="${cy + 3}">output</text>`;
        } else if (cell.t === 'RSR') {
          // drawn together with the RS block above
        } else if (cell.t === 'RSS') {
          const cy2 = cy + CH;
          s += `<line class="w" data-fl="i:${key}" x1="${x0}" y1="${cy}" x2="${cx - 36}" y2="${cy}"/>`;
          s += `<line class="w" data-fl="i:${ri}:${ci + 9}" x1="${x0}" y1="${cy2}" x2="${cx - 36}" y2="${cy2}"/>`;
          s += `<g class="symg" data-bit="${esc(cell.a)}"><rect class="sym fillsym" x="${cx - 36}" y="${cy - 22}" width="72" height="${CH + 44}" rx="3"/>` +
            `<text class="symtxt" x="${cx}" y="${cy - 7}">RS</text>` +
            `<text class="addr" x="${cx}" y="${cy + CH / 2 + 4}">${esc(cell.a || '?')}</text>` +
            `<text class="symtxt" x="${cx - 28}" y="${cy + 4}" style="text-anchor:middle">S</text>` +
            `<text class="symtxt" x="${cx - 28}" y="${cy2 + 4}" style="text-anchor:middle">R</text></g>`;
          s += `<text class="subt" x="${cx}" y="${cy2 + 34}" data-sub="${esc(cell.a)}"></text>`;
        } else if (cell.t === 'WIRE') {
          s += `<line class="w" data-fl="o:${key}" x1="${x0}" y1="${cy}" x2="${x0 + CW}" y2="${cy}"/>`;
        } else {
          const hw = halfWidth(cell.t);
          s += `<line class="w" data-fl="i:${key}" x1="${x0}" y1="${cy}" x2="${cx - hw}" y2="${cy}"/>`;
          s += `<line class="w" data-fl="o:${key}" x1="${cx + hw}" y1="${cy}" x2="${x0 + CW}" y2="${cy}"/>`;
          s += symbolMarkup(cell.t, cx, cy, cell.a, '', 'o:' + key);
          const isBlock = P.TYPE[cell.t] >= 20;
          if (isBlock) {
            s += `<text class="addr" x="${cx}" y="${cy + 10}" data-valkey="${cell.a}">${esc(cell.a || '?')}</text>`;
            s += `<text class="subt" x="${cx}" y="${cy + 31}" data-sub="${esc(cell.a)}">${esc(cellLabelSub(cell))}</text>`;
          } else {
            s += `<text class="addr" x="${cx}" y="${cy - 19}">${esc(cell.a || '?')}</text>`;
          }
        }
        if (isSel) s += `<rect class="cellsel" x="${x0 + 3}" y="${cy - CH / 2 + 2}" width="${CW - 6}" height="${CH - 4}"/>`;
        s += `<rect class="hit" data-r="${r}" data-c="${c}" x="${x0}" y="${cy - CH / 2}" width="${CW}" height="${CH}"/>`;
      }
    }
    // vertical links
    for (let r = 0; r < vr - 1; r++) {
      for (let n = 1; n < 9; n++) {
        const x = PAD + n * CW, y1 = TOP + r * CH + CH / 2, y2 = y1 + CH;
        if (g.links[r * 9 + n]) {
          s += `<line class="w" data-fl="i:${ri}:${r * 9 + n}" x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>`;
          s += `<circle class="ldot" data-fl="i:${ri}:${r * 9 + n}" cx="${x}" cy="${y1}" r="3"/><circle class="ldot" data-fl="i:${ri}:${(r + 1) * 9 + n}" cx="${x}" cy="${y2}" r="3"/>`;
        }
        s += `<circle class="lhit" data-lr="${r}" data-ln="${n}" cx="${x}" cy="${y1 + CH / 2}" r="7"><title>Join or split the branch here</title></circle>`;
      }
    }
    return s + '</svg>';
  }
  function renderLadder() {
    const root = $('#ladder'); let h = '';
    prog.rungs.forEach((g, ri) => {
      h += `<article class="rung${sel.ri === ri ? ' cur' : ''}" data-ri="${ri}">
        <div class="rhead"><span class="rnum">Rung ${ri + 1}</span>
        <input class="rcom" data-ri="${ri}" value="${esc(g.comment)}" placeholder="Add a comment" maxlength="120" aria-label="Rung ${ri + 1} comment">
        <button data-act="up" data-ri="${ri}" title="Move up" ${ri === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" data-ri="${ri}" title="Move down" ${ri === prog.rungs.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="dup" data-ri="${ri}" title="Duplicate rung">Copy</button>
        <button data-act="del" data-ri="${ri}" title="Delete rung">✕</button></div>
        <div class="rbody">${rungSVG(ri)}</div></article>`;
    });
    h += `<button class="addrung" id="bAddRung">+ Add rung</button>`;
    root.innerHTML = h;
    flowEls = []; valEls = [];
    root.querySelectorAll('[data-fl]').forEach(el => {
      const [k, ri, ci] = el.getAttribute('data-fl').split(':'); flowEls.push({ el, k, ri: +ri, ci: +ci });
    });
    root.querySelectorAll('[data-sub]').forEach(el => valEls.push(el));
    updateLive();
  }

  // ---------- palette ----------
  const PALETTE = {
    palC: [['NO', 'Normally open', '1'], ['NC', 'Normally closed', '2'], ['RISE', 'Rising edge', '3'], ['FALL', 'Falling edge', '4']],
    palO: [['OUT', 'Coil', '5'], ['OUTN', 'Coil NOT', '6'], ['SET', 'Set (latch)', '7'], ['RESET', 'Reset (latch)', '8'], ['RSS', 'RS latch block', '9']],
    palT: [['TON', 'On-delay', 't'], ['TOF', 'Off-delay', 'f'], ['CTU', 'Count up', 'u'], ['CTD', 'Count down', 'd'], ['CRES', 'Counter reset', 'r']]
  };
  const KEYMAP = {};
  function buildPalette() {
    Object.keys(PALETTE).forEach(id => {
      $('#' + id).innerHTML = PALETTE[id].map(([t, label, key]) => {
        KEYMAP[key] = t;
        const hw = halfWidth(t);
        const icon = `<svg viewBox="0 0 96 34" aria-hidden="true"><line class="w" x1="0" y1="17" x2="${48 - hw}" y2="17" stroke="currentColor"/><line class="w" x1="${48 + hw}" y1="17" x2="96" y2="17"/>${symbolMarkup(t, 48, 17, '', '', '')}</svg>`;
        return `<button class="pbtn" data-place="${t}" title="${label} (key ${key})">${icon}<span>${label}<kbd>${key}</kbd></span></button>`;
      }).join('');
    });
    $('#palW').innerHTML = `<button class="pbtn" data-place="WIRE" title="Wire (key w)"><svg viewBox="0 0 96 34"><line class="w" x1="0" y1="17" x2="96" y2="17"/></svg><span>Wire<kbd>w</kbd></span></button>` +
      `<button class="pbtn" data-act2="branch" title="Add a parallel branch below the selected cell (key b)"><svg viewBox="0 0 96 34"><path class="w" d="M0 8H96M20 8V26M76 8V26M20 26H76"/></svg><span>Branch ↓<kbd>b</kbd></span></button>`;
    KEYMAP.w = 'WIRE';
  }

  function addrOptions(t, cur) {
    const kinds = P.OPERAND_KINDS[t] || [];
    const lab = ['Inputs', 'Relay outputs', 'Markers', 'Timer done', 'Counter done', 'RS latches'];
    const nm = [i => 'I' + (i + 1) + ' · input ' + (i + 1), i => 'Q' + (i + 1) + ' · relay ' + (i + 1), i => 'M' + (i + 1) + ' · marker', i => 'T' + (i + 1), i => 'C' + (i + 1), i => 'RS' + (i + 1) + ' · latch'];
    let h = '';
    kinds.forEach(k => {
      let o = '';
      for (let i = 0; i < P.COUNTS[k]; i++) { const a = P.KINDS[k] + (i + 1); o += `<option value="${a}"${a === cur ? ' selected' : ''}>${nm[k](i)}</option>`; }
      h += kinds.length > 1 ? `<optgroup label="${lab[k]}">${o}</optgroup>` : o;
    });
    return h;
  }

  function renderInspector() {
    const g = prog.rungs[sel.ri], ci = sel.r * 9 + sel.c, cell = g.cells[ci];
    const where = `Rung ${sel.ri + 1}, row ${sel.r + 1}, column ${sel.c + 1}${sel.c === 8 ? ' (output)' : ''}`;
    let h = `<div class="insp"><h2 style="margin:0">Selected</h2><span class="tag">${where}</span>`;
    if (!cell) h += `<p class="hint">Empty. Choose an element from the palette${sel.r === 0 && sel.c < 8 ? '. An empty cell in the top row is a plain wire.' : '.'}</p>`;
    else if (cell.t === 'WIRE') h += `<p class="hint">Wire</p>`;
    else {
      h += `<label>Address<select id="inAddr">${addrOptions(cell.t, cell.a)}</select></label>`;
      const idx = P.addr(cell.a) & 31;
      if (cell.t === 'TON' || cell.t === 'TOF') {
        const ms = prog.timers[idx];
        let unit = 'ms', val = ms; if (ms >= 60000 && ms % 60000 === 0) { unit = 'min'; val = ms / 60000; } else if (ms >= 1000 && ms % 100 === 0) { unit = 's'; val = ms / 1000; }
        h += `<label>Delay for ${esc(cell.a)}<span class="row"><input id="inPre" type="number" min="0" step="any" value="${val}"><select id="inUnit"><option${unit === 'ms' ? ' selected' : ''}>ms</option><option${unit === 's' ? ' selected' : ''}>s</option><option${unit === 'min' ? ' selected' : ''}>min</option></select></span></label>`;
      }
      if (cell.t === 'RSS' || cell.t === 'RSR') h += `<p class="hint">RS block: the top input (S) sets ${esc(cell.a)}, the bottom input (R) resets it. Reset wins if both are on. Use ${esc(cell.a)} as a contact anywhere.</p>`;
      if (cell.t === 'CTU' || cell.t === 'CTD' || cell.t === 'CRES') {
        h += `<label>Preset value for ${esc(cell.a)}<input id="inCnt" type="number" min="1" max="9999" step="1" value="${prog.counters[idx]}"></label>`;
        h += `<p class="hint">${esc(cell.a)} as a contact is on when the count reaches this value. Use one preset for all blocks that share ${esc(cell.a)}.</p>`;
      }
    }
    h += `<div class="acts"><button data-act2="clear">Clear cell</button><button data-act2="branch">Branch ↓</button><button data-act2="unbranch">Remove branch</button></div>`;
    h += `<p class="hint">Click the small dot between two rows (on hover) to join them with a vertical wire.</p></div>`;
    $('#inspector').innerHTML = h;
    const a = $('#inAddr'); if (a) a.onchange = () => change(() => {
      const cs = prog.rungs[sel.ri].cells; cs[ci].a = a.value;
      const pi = rsPartner(cs, sel.r, sel.c); if (pi >= 0 && cs[pi]) cs[pi].a = a.value;
    });
    const pre = $('#inPre'); if (pre) {
      const apply = () => { const mult = { ms: 1, s: 1000, min: 60000 }[$('#inUnit').value]; const v = Math.max(0, Math.round(parseFloat(pre.value || '0') * mult)); change(() => { prog.timers[P.addr(cell.a) & 31] = v; }); };
      pre.onchange = apply; $('#inUnit').onchange = apply;
    }
    const cn = $('#inCnt'); if (cn) cn.onchange = () => change(() => { prog.counters[P.addr(cell.a) & 31] = Math.min(9999, Math.max(1, parseInt(cn.value || '1', 10))); });
  }

  // ---------- editing ----------
  function nextFreeTimer() {
    const used = new Set(); prog.rungs.forEach(g => g.cells.forEach(c => { if (c && (c.t === 'TON' || c.t === 'TOF')) used.add(c.a); }));
    for (let i = 1; i <= P.NT; i++) if (!used.has('T' + i)) return 'T' + i;
    return 'T1';
  }
  function place(t) {
    if (mode === 'live') return toast('Stop the monitor to edit');
    const { ri, r } = sel; let c = sel.c;
    const out = P.isOutput(P.TYPE[t]);
    if (out) c = 8;
    else if (t === 'WIRE' && c === 8) return toast('A wire cannot go in the output column');
    else if (c === 8) return toast('Contacts go in columns 1 to 8. Select a cell further left.');
    if (t === 'RSS' && r >= 3) return toast('The RS block needs two rows. Select row 1, 2 or 3.');
    change(() => {
      const cells = prog.rungs[ri].cells, old = cells[r * 9 + c];
      const op = rsPartner(cells, r, c); if (op >= 0) cells[op] = null;
      if (t === 'RSS') {
        const lower = cells[(r + 1) * 9 + c], a = old && old.t === 'RSR' ? old.a : (old && old.t === 'RSS' ? old.a : nextFreeRS());
        cells[r * 9 + c] = { t: 'RSS', a }; cells[(r + 1) * 9 + c] = { t: 'RSR', a };
        sel.c = c; return;
      }
      if (t === 'WIRE') cells[r * 9 + c] = { t };
      else {
        let a = old && old.a && P.OPERAND_KINDS[t] && P.OPERAND_KINDS[t].indexOf(P.addr(old.a) >> 5) >= 0 ? old.a : null;
        if (!a) a = (t === 'TON' || t === 'TOF') ? nextFreeTimer() : t.startsWith('CT') || t === 'CRES' ? 'C1' : out ? 'Q1' : 'I1';
        cells[r * 9 + c] = { t, a };
      }
      sel.c = c;
    });
  }
  function rsPartner(cells, r, c) {
    const cell = cells[r * 9 + c]; if (!cell) return -1;
    if (cell.t === 'RSS') return (r + 1) * 9 + c;
    if (cell.t === 'RSR') return (r - 1) * 9 + c;
    return -1;
  }
  function nextFreeRS() {
    const used = new Set(); prog.rungs.forEach(g => g.cells.forEach(c => { if (c && c.t === 'RSS') used.add(c.a); }));
    for (let i = 1; i <= 8; i++) if (!used.has('RS' + i)) return 'RS' + i;
    return 'RS1';
  }
  function clearCell() {
    change(() => {
      const cs = prog.rungs[sel.ri].cells, pi = rsPartner(cs, sel.r, sel.c);
      cs[sel.r * 9 + sel.c] = null; if (pi >= 0) cs[pi] = null;
    });
  }
  function branch(add) {
    const { ri, r, c } = sel;
    if (r >= 3) return toast('A rung has at most 4 rows');
    change(() => {
      const g = prog.rungs[ri];
      [c, c + 1].forEach(n => { if (n >= 1 && n <= 8) g.links[r * 9 + n] = add; });
      if (add) { if (!g.cells[(r + 1) * 9 + c]) g.cells[(r + 1) * 9 + c] = c === 8 ? null : { t: 'WIRE' }; sel.r = r + 1; }
    });
  }
  function rungAction(act, ri) {
    if (mode === 'live') return toast('Stop the monitor to edit');
    change(() => {
      if (act === 'up' && ri > 0) { [prog.rungs[ri - 1], prog.rungs[ri]] = [prog.rungs[ri], prog.rungs[ri - 1]]; sel.ri = ri - 1; }
      else if (act === 'down' && ri < prog.rungs.length - 1) { [prog.rungs[ri + 1], prog.rungs[ri]] = [prog.rungs[ri], prog.rungs[ri + 1]]; sel.ri = ri + 1; }
      else if (act === 'dup') { if (prog.rungs.length >= P.MAX_RUNGS) toast('Maximum ' + P.MAX_RUNGS + ' rungs'); else { prog.rungs.splice(ri + 1, 0, clone(prog.rungs[ri])); sel.ri = ri + 1; } }
      else if (act === 'del') { if (prog.rungs.length === 1) prog.rungs[0] = P.newRung(); else prog.rungs.splice(ri, 1); sel.ri = Math.min(sel.ri, prog.rungs.length - 1); }
    });
  }
  function addRung() {
    if (prog.rungs.length >= P.MAX_RUNGS) return toast('Maximum ' + P.MAX_RUNGS + ' rungs');
    change(() => { prog.rungs.push(P.newRung()); sel = { ri: prog.rungs.length - 1, r: 0, c: 0 }; });
    const el = $('.rung:last-of-type'); if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // ---------- problems ----------
  function renderProblems() {
    const v = P.validate(prog), list = $('#probList');
    $('#probCount').textContent = v.length; $('#probCount').classList.toggle('bad', v.some(x => x.level === 'error'));
    list.innerHTML = v.length ? v.map((x, i) => `<li class="${x.level}" data-i="${i}">${x.rung !== undefined ? 'Rung ' + (x.rung + 1) + ': ' : ''}${esc(x.msg)}</li>`).join('') : '<li class="okay">No problems found.</li>';
    list.querySelectorAll('li[data-i]').forEach(li => li.onclick = () => { const x = v[+li.dataset.i]; if (x.rung !== undefined) { sel = { ri: x.rung, r: 0, c: 0 }; renderAll(); const e = document.querySelector('.rung.cur'); if (e) e.scrollIntoView({ block: 'center' }); } });
    return v;
  }

  // ---------- IO bar and live display ----------
  function renderIO() {
    $('#ioIn').innerHTML = [0, 1, 2, 3].map(i => `<button class="sw" data-in="${i}" aria-label="Input ${i + 1}"><i></i>I${i + 1}</button>`).join('');
    $('#ioOut').innerHTML = [0, 1, 2, 3].map(i => `<span class="lamp" data-out="${i}"><i></i>Q${i + 1}</span>`).join('');
  }
  function usedResources() {
    const T = new Set(), C = new Set();
    prog.rungs.forEach(g => g.cells.forEach(c => { if (c && c.a) { if (c.a[0] === 'T' && c.a[1] !== 'O') T.add(c.a); if (c.a[0] === 'C') C.add(c.a); } }));
    return { T: [...T].sort(), C: [...C].sort() };
  }
  function updateLive() {
    const m = mode === 'edit' ? null : machine;
    // flow classes
    for (const f of flowEls) {
      let on = false;
      if (m && m.flowIn[f.ri]) on = !!(f.k === 'i' ? m.flowIn[f.ri][f.ci] : m.flowOut[f.ri][f.ci]);
      f.el.classList.toggle('on', on);
    }
    // timer / counter value text
    for (const el of valEls) {
      const a = el.getAttribute('data-sub'), idx = (P.addr(a) & 31), cell = null;
      if (!m) { continue; }
      if (a.startsWith('RS')) el.textContent = m.RS[idx] ? 'ON' : 'OFF';
      else if (a[0] === 'T') el.textContent = fmtMs(m.Tacc[idx]) + ' / ' + fmtMs(prog.timers[idx]);
      else if (a[0] === 'C') el.textContent = m.Cnt[idx] + ' / ' + prog.counters[idx];
    }
    if (!m) { valEls.forEach(el => { const a = el.getAttribute('data-sub'), idx = P.addr(a) & 31; el.textContent = a.startsWith('RS') ? '' : a[0] === 'T' ? fmtMs(prog.timers[idx]) : 'PV ' + prog.counters[idx]; }); }
    document.querySelectorAll('[data-bit]').forEach(el => el.classList.toggle('on', !!(m && m.bit(P.addr(el.getAttribute('data-bit'))))));
    // IO bar
    document.querySelectorAll('[data-in]').forEach(b => {
      const i = +b.dataset.in; const v = mode === 'sim' ? simInputs[i] : (m ? m.I[i] : 0);
      b.classList.toggle('on', !!v); b.classList.toggle('click', mode === 'sim' || mode === 'edit' && false);
    });
    document.querySelectorAll('[data-out]').forEach(b => b.classList.toggle('on', !!(m && m.Q[+b.dataset.out])));
    let vals = '';
    if (m) {
      const ms = []; for (let i = 0; i < 16; i++) if (m.M[i]) ms.push('M' + (i + 1));
      const u = usedResources();
      vals = (ms.length ? 'on: ' + ms.join(' ') + '  ' : '') + u.T.map(a => a + ' ' + fmtMs(m.Tacc[P.addr(a) & 31])).join('  ') + '  ' + u.C.map(a => a + '=' + m.Cnt[P.addr(a) & 31]).join('  ');
    }
    $('#ioVals').textContent = vals.trim();
  }
  function setChips() {
    const cm = $('#chipMode');
    cm.textContent = mode === 'sim' ? 'Simulating' : mode === 'live' ? 'Live from ESP32' : 'Edit';
    cm.className = 'chip' + (mode !== 'edit' ? ' ok' : '');
    const cl = $('#chipLink');
    if (!('serial' in navigator)) { cl.textContent = 'Use Chrome or Edge'; cl.className = 'chip warn'; }
    else if (!ser.connected) { cl.textContent = 'Not connected'; cl.className = 'chip'; }
    else {
      const stale = lastSentHash !== null && P.compile(prog).hash !== lastSentHash;
      cl.textContent = 'ESP32 ' + (ser.running ? 'RUN' : 'STOP') + (lastSentHash === null ? ' · program unknown' : stale ? ' · not transferred' : ' · up to date');
      cl.className = 'chip ' + (stale || lastSentHash === null ? 'warn' : 'ok');
    }
    $('#bSim').classList.toggle('on', mode === 'sim'); $('#bSim').textContent = mode === 'sim' ? 'Stop simulation' : 'Simulate';
    $('#bMon').classList.toggle('on', ser.monitor);
    const c = ser.connected;
    $('#bConn').textContent = c ? 'Disconnect' : 'Connect';
    ['bSend', 'bRun', 'bStop', 'bMon'].forEach(id => $('#' + id).disabled = !c);
  }

  // ---------- simulator ----------
  function startSim(keep) {
    if (ser.monitor) setMonitor(false);
    stopSim(true);
    machine = new P.Machine(P.compile(prog));
    if (!keep) simInputs = [0, 0, 0, 0];
    mode = 'sim';
    simTimer = setInterval(() => { machine.step(20, simInputs); updateLive(); }, 20);
    setChips(); updateLive();
  }
  function stopSim(quiet) {
    if (simTimer) clearInterval(simTimer); simTimer = null;
    if (mode === 'sim') { mode = 'edit'; machine = null; }
    if (!quiet) { setChips(); updateLive(); }
  }

  // ---------- serial ----------
  function logLine(dir, s) {
    const el = $('#log'); el.textContent += dir + ' ' + s + '\n';
    if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-12000);
    el.scrollTop = el.scrollHeight;
  }
  function parseFrame(line) {
    const t = line.trim().split(/\s+/);
    if (t[0] !== 'S' || t.length < 8) return null;
    return { run: t[1] === '1', i: parseInt(t[2], 16), q: parseInt(t[3], 16), m: parseInt(t[4], 16), t: parseInt(t[5], 16), c: t[6].split(',').map(Number), acc: t[7].split(',').map(Number), rs: t[8] ? parseInt(t[8], 16) : 0 };
  }
  function onLine(line) {
    if (!line) return;
    if (line[0] === 'S' && line[1] === ' ') {
      const f = parseFrame(line); if (!f) return;
      ser.running = f.run; ser.live = f;
      if (ser.monitor) {
        if (!machine || mode !== 'live') { machine = new P.Machine(P.compile(prog)); mode = 'live'; }
        machine.loadState(f); machine.flowOnly(); updateLive(); setChips();
      }
      return;
    }
    logLine('←', line);
    if ((line[0] === '+' || line[0] === '-') && ser.pending) { const p = ser.pending; ser.pending = null; p(line); }
  }
  async function readLoop() {
    const dec = new TextDecoder(); let buf = '';
    try {
      while (ser.port && ser.port.readable) {
        ser.reader = ser.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await ser.reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            let k; while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k).replace(/\r/g, '').trim()); buf = buf.slice(k + 1); }
            if (buf.length > 2000) buf = '';
          }
        } finally { ser.reader.releaseLock(); }
      }
    } catch (e) { logLine('!', 'read error: ' + e.message); }
    if (ser.connected) await disconnect(true);
  }
  function sendLine(line, timeout) {
    return new Promise((resolve, reject) => {
      if (!ser.connected) return reject(new Error('Not connected'));
      const to = setTimeout(() => { ser.pending = null; reject(new Error('No reply from ESP32 (timeout)')); }, timeout || 2500);
      ser.pending = r => { clearTimeout(to); resolve(r); };
      logLine('→', line.length > 90 ? line.slice(0, 90) + '…' : line);
      ser.writer.write(new TextEncoder().encode(line + '\n')).catch(e => { clearTimeout(to); ser.pending = null; reject(e); });
    });
  }
  async function connect() {
    if (!('serial' in navigator)) return toast('Web Serial needs Chrome or Edge on a computer');
    try {
      ser.port = await navigator.serial.requestPort();
      await ser.port.open({ baudRate: 115200 });
    } catch (e) { ser.port = null; return toast(e.name === 'NotFoundError' ? 'No port selected' : 'Could not open port: ' + e.message); }
    ser.writer = ser.port.writable.getWriter(); ser.connected = true;
    readLoop();
    toast('Port open. Waiting for the ESP32 to start…');
    setChips();
    await sleep(1800);
    for (let i = 0; i < 4; i++) {
      try {
        const r = await sendLine('PING', 900);
        const t = r.split(' '); ser.running = t[3] === '1'; lastSentHash = null;
        toast('ESP32 connected. It holds ' + t[2] + ' rung(s).');
        setChips(); return;
      } catch (e) { /* retry */ }
    }
    toast('Port is open but the ESP32 did not answer. Is the PLC firmware loaded?');
    setChips();
  }
  async function disconnect(fromLoop) {
    ser.connected = false; ser.monitor = false; ser.pending = null; lastSentHash = null;
    try { ser.reader && await ser.reader.cancel(); } catch (e) { /* ignore */ }
    try { ser.writer && ser.writer.releaseLock(); } catch (e) { /* ignore */ }
    try { ser.port && await ser.port.close(); } catch (e) { /* ignore */ }
    ser.port = null; ser.writer = null;
    if (mode === 'live') { mode = 'edit'; machine = null; }
    setChips(); updateLive();
    if (!fromLoop) toast('Disconnected');
  }
  async function transfer() {
    const v = renderProblems();
    if (v.some(x => x.level === 'error')) return toast('Fix the errors in the Checks list first');
    if (mode === 'sim') stopSim();
    const comp = P.compile(prog);
    const btn = $('#bSend'); btn.disabled = true;
    try {
      toast('Sending program…');
      let r = await sendLine('BEGIN'); if (r[0] !== '+') throw new Error(r);
      for (let i = 0; i < comp.lines.length; i++) {
        r = await sendLine(comp.lines[i]); if (r[0] !== '+') throw new Error(r.slice(1));
        btn.textContent = Math.round(100 * (i + 1) / comp.lines.length) + '%';
      }
      r = await sendLine(comp.endLine, 6000); if (r[0] !== '+') throw new Error(r.slice(1));
      lastSentHash = comp.hash; ser.running = true;
      toast('Program saved on the ESP32 and running (' + comp.count + ' rungs)');
    } catch (e) { toast('Transfer failed: ' + e.message); }
    btn.textContent = 'Transfer'; btn.disabled = !ser.connected; setChips();
  }
  async function setMonitor(on) {
    if (!ser.connected) return;
    if (on) { if (mode === 'sim') stopSim(); }
    try { await sendLine(on ? 'MON 1' : 'MON 0'); } catch (e) { toast(e.message); return; }
    ser.monitor = on;
    if (!on && mode === 'live') { mode = 'edit'; machine = null; }
    setChips(); updateLive();
  }

  // ---------- file operations ----------
  function saveFile() {
    const blob = new Blob([JSON.stringify(prog, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (prog.name || 'program').replace(/[^\w\-. ]+/g, '_') + '.plc.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Saved ' + a.download);
  }
  function loadObject(o, label) {
    if (!o || !Array.isArray(o.rungs)) return toast('That file is not a ladder program');
    pushUndo(); prog = fixProgram(o); sel = { ri: 0, r: 0, c: 0 }; afterChange(); toast(label || 'Program opened');
  }

  // ---------- events ----------
  function bind() {
    $('#bNew').onclick = () => { if (!confirm('Start a new empty program? Unsaved changes are kept in Undo.')) return; pushUndo(); prog = P.newProgram(); sel = { ri: 0, r: 0, c: 0 }; afterChange(); };
    $('#bOpen').onclick = () => $('#fileIn').click();
    $('#fileIn').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader(); rd.onload = () => { try { loadObject(JSON.parse(rd.result), 'Opened ' + f.name); } catch (err) { toast('Could not read file: ' + err.message); } };
      rd.readAsText(f); e.target.value = '';
    };
    $('#bSave').onclick = saveFile;
    $('#bUndo').onclick = undo; $('#bRedo').onclick = redo;
    $('#pname').onchange = e => change(() => { prog.name = e.target.value.trim() || 'Untitled'; });
    const sel2 = $('#exSel');
    EXS.forEach(x => { const o = document.createElement('option'); o.value = x.id; o.textContent = x.title; sel2.appendChild(o); });
    sel2.onchange = () => { const x = EXS.find(e => e.id === sel2.value); sel2.value = ''; if (x) loadObject(x.make(), 'Loaded example: ' + x.title); };
    $('#bSim').onclick = () => mode === 'sim' ? stopSim() : startSim();
    $('#bConn').onclick = () => ser.connected ? disconnect() : connect();
    $('#bSend').onclick = transfer;
    $('#bRun').onclick = async () => { try { await sendLine('RUN'); ser.running = true; setChips(); } catch (e) { toast(e.message); } };
    $('#bStop').onclick = async () => { try { await sendLine('STOP'); ser.running = false; setChips(); } catch (e) { toast(e.message); } };
    $('#bMon').onclick = () => setMonitor(!ser.monitor);

    $('#ioIn').onclick = e => { const b = e.target.closest('[data-in]'); if (b && mode === 'sim') { simInputs[+b.dataset.in] ^= 1; updateLive(); } };
    $('#palette').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.place) place(b.dataset.place); else if (b.dataset.act2 === 'branch') branch(true);
    };
    $('#inspector').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act2 === 'clear') clearCell(); else if (b.dataset.act2 === 'branch') branch(true); else if (b.dataset.act2 === 'unbranch') branch(false);
    };
    const lad = $('#ladder');
    lad.addEventListener('click', e => {
      if (e.target.id === 'bAddRung') return addRung();
      const btn = e.target.closest('button[data-act]'); if (btn) return rungAction(btn.dataset.act, +btn.dataset.ri);
      const hit = e.target.closest('.hit'), lh = e.target.closest('.lhit');
      const svg = e.target.closest('svg.rungsvg'); if (!svg) return;
      const ri = +svg.dataset.ri;
      if (lh) {
        if (mode === 'live') return toast('Stop the monitor to edit');
        const r = +lh.dataset.lr, n = +lh.dataset.ln; sel.ri = ri;
        change(() => { const g = prog.rungs[ri]; g.links[r * 9 + n] = !g.links[r * 9 + n]; });
      } else if (hit) { sel = { ri, r: +hit.dataset.r, c: +hit.dataset.c }; renderAll(); }
    });
    lad.addEventListener('dblclick', e => {
      const hit = e.target.closest('.hit'); if (!hit) return;
      const a = $('#inAddr'); if (a) { a.focus(); if (a.showPicker) { try { a.showPicker(); } catch (err) { /* needs a user gesture in some browsers */ } } }
    });
    lad.addEventListener('change', e => {
      if (e.target.classList.contains('rcom')) { const ri = +e.target.dataset.ri; change(() => { prog.rungs[ri].comment = e.target.value; }); }
    });
    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey && tag !== 'input') { e.preventDefault(); undo(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { if (tag !== 'input') { e.preventDefault(); redo(); } }
        else if (k === 's') { e.preventDefault(); saveFile(); }
        return;
      }
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      const move = (dr, dc) => {
        let { ri, r, c } = sel; const vr = visibleRows(ri);
        if (dc) c = Math.max(0, Math.min(8, c + dc));
        if (dr > 0) { if (r < vr - 1) r++; else if (ri < prog.rungs.length - 1) { ri++; r = 0; } }
        if (dr < 0) { if (r > 0) r--; else if (ri > 0) { ri--; r = 0; } }
        sel = { ri, r, c }; renderAll();
      };
      switch (e.key) {
        case 'ArrowLeft': move(0, -1); e.preventDefault(); return;
        case 'ArrowRight': move(0, 1); e.preventDefault(); return;
        case 'ArrowUp': move(-1, 0); e.preventDefault(); return;
        case 'ArrowDown': move(1, 0); e.preventDefault(); return;
        case 'Delete': case 'Backspace': e.preventDefault(); if (mode !== 'live') clearCell(); return;
        case 'b': branch(true); return;
        case 'Enter': { const a = $('#inAddr'); if (a) { e.preventDefault(); a.focus(); } return; }
      }
      const t = KEYMAP[e.key]; if (t) { e.preventDefault(); place(t); }
    });
    window.addEventListener('beforeunload', () => { try { ser.connected && ser.writer && 0; } catch (e) { /* noop */ } });
    if (navigator.serial) navigator.serial.addEventListener('disconnect', () => { if (ser.connected) disconnect(true); });
  }

  // ---------- init ----------
  function renderAll() { renderLadder(); renderInspector(); renderProblems(); setChips(); }
  buildPalette(); renderIO(); bind();
  try { const saved = localStorage.getItem(AUTOSAVE); if (saved) prog = fixProgram(JSON.parse(saved)); } catch (e) { /* ignore */ }
  $('#pname').value = prog.name;
  renderAll();
  // keep the side panel just below the sticky bars, whatever height they wrap to
  try {
    const bars = $('#bars'), setH = () => document.documentElement.style.setProperty('--bars-h', bars.offsetHeight + 'px');
    setH(); if (window.ResizeObserver) new ResizeObserver(setH).observe(bars); else window.addEventListener('resize', setH);
  } catch (e) { /* layout only */ }
  window.__plc = { get prog() { return prog; }, load: o => loadObject(o), sel: () => sel };
})();
