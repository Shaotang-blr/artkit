/* ArtKit: physical drawing tools for web canvases.
 *
 * How the tools work: while a tool is on, the extension catches your mouse/pointer events on the
 * drawing canvas (capture phase, before the page sees them), corrects the positions, and passes
 * the corrected events on to the page. The page draws exactly what it would draw if your hand had
 * moved that way.
 *   Ruler        down at the start, NO moves while dragging (a preview line is shown instead), then
 *                one move to the end and up: a perfectly straight stroke from just two points
 *                (on Karuta Studio that is also the cheapest possible line).
 *   Steady hand  "lazy brush": the pen follows the mouse on a string of a set length, so hand shake
 *                shorter than the string never reaches the canvas.
 *   Grid, tracing paper: drawn on a transparent overlay that never reaches the page.
 * Only real (trusted) input is corrected; events ArtKit sends itself are marked and passed through.
 */
(() => {
  if (window.__artkitLoaded) return;
  window.__artkitLoaded = true;

  const MARK = "__artkitSynthetic";
  const TEST = !!window.__artkitTest;          // test pages: also correct untrusted input
  const SNAP_STEP = Math.PI / 12;              // 15 degrees
  const SNAP_RANGE = (4 * Math.PI) / 180;      // magnetic within 4 degrees
  const RULER_STEP = 4;                        // px between the points of a ruler line (see mouseup)

  const S = {
    tool: "free",        // free | ruler | steady
    snap: true,
    grid: false, gridStep: 20, thirds: false, centre: false,
    steady: 12,          // string length, screen px
    traceOpacity: 0.4, traceVisible: true,
    fillWidth: 7,        // the site's biggest brush, canvas px (Karuta Studio: 7)
    fillArea: null,      // {x, y, w, h} in canvas px, or null = the whole canvas
    minimized: false, panel: { x: 16, y: 90 },
  };
  const trace = { img: null, x: 0, y: 0, w: 0 };   // in canvas units (follow zoom / scroll)
  let adjusting = false;
  let settingArea = false;           // "Set area": the overlay takes the mouse to drag a box
  let areaDrag = null;
  let target = null;                               // the drawing canvas
  let g = null;                                    // the gesture being corrected
  let mouse = null;                                // last mouse position (for previews)
  let dirty = true;

  // ------------------------------------------------------------------ settings
  const store = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  const KEY = "artkit:" + location.host;
  function save() {
    const data = { ...S };
    try { store ? store.set({ [KEY]: data }) : localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }
  function load(done) {
    try {
      if (store) return store.get(KEY, (r) => { Object.assign(S, (r && r[KEY]) || {}); done(); });
      Object.assign(S, JSON.parse(localStorage.getItem(KEY) || "{}"));
    } catch (e) {}
    done();
  }

  // ------------------------------------------------------------------ target canvas
  function visibleCanvases() {
    return [...document.querySelectorAll("canvas")].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && getComputedStyle(c).visibility !== "hidden";
    });
  }
  function autoTarget() {
    const cs = visibleCanvases();
    const area = (c) => { const r = c.getBoundingClientRect(); return r.width * r.height; };
    target = cs.sort((a, b) => area(b) - area(a))[0] || null;
  }
  function pickNext() {
    const cs = visibleCanvases();
    if (!cs.length) return;
    target = cs[(cs.indexOf(target) + 1) % cs.length];
    flash = performance.now();
    dirty = true;
  }
  function rect() {
    if (!target || !target.isConnected) autoTarget();
    return target ? target.getBoundingClientRect() : null;
  }
  function inside(x, y) {
    const r = rect();
    return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  const scale = (r) => r.width / (target.width || r.width);    // screen px per canvas px

  // ------------------------------------------------------------------ UI (shadow DOM)
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    canvas.ov { position: fixed; inset: 0; pointer-events: none; }
    canvas.ov.adjust { pointer-events: auto; cursor: move; }
    .panel { position: fixed; pointer-events: auto; width: 214px; font: 12px/1.35 system-ui, sans-serif;
      color: #e8e8ea; background: #232428ee; border: 1px solid #3b3d44; border-radius: 10px;
      box-shadow: 0 6px 24px #0008; user-select: none; }
    .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: grab;
      border-bottom: 1px solid #3b3d44; font-weight: 600; }
    .head span { flex: 1; }
    .body { padding: 8px; display: grid; gap: 8px; }
    .mini .body { display: none; }
    .mini .head { border-bottom: 0; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .tools { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
    button { font: inherit; color: inherit; background: #34363d; border: 1px solid #4a4d56;
      border-radius: 6px; padding: 4px 6px; cursor: pointer; }
    button:hover { background: #3f424a; }
    button.on { background: #5865f2; border-color: #7983ff; }
    .x { background: none; border: 0; padding: 0 4px; font-size: 14px; }
    label { display: flex; align-items: center; gap: 4px; }
    input[type=range] { flex: 1; min-width: 60px; }
    input[type=number] { width: 42px; font: inherit; color: inherit; background: #1b1c20;
      border: 1px solid #4a4d56; border-radius: 4px; padding: 1px 3px; }
    .sec { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #9a9ca5; }
    .hint { font-size: 11px; color: #9a9ca5; }
  </style>
  <canvas class="ov"></canvas>
  <div class="panel">
    <div class="head"><span>📐 ArtKit</span><button class="x" data-a="min" title="Minimise / open (Alt+A)">–</button></div>
    <div class="body">
      <div class="tools">
        <button data-tool="free" title="Normal drawing (Alt+1)">✏️ Free</button>
        <button data-tool="ruler" title="Straight lines (Alt+2). Shift+drag works in Free too">📏 Ruler</button>
        <button data-tool="steady" title="Smooths hand shake (Alt+3)">〰️ Steady</button>
      </div>
      <div class="row" data-show="ruler"><label><input type="checkbox" data-k="snap"> Snap to 15° angles</label>
        <span class="hint">hold Alt to switch snapping off/on</span></div>
      <div class="row" data-show="steady"><span>Smoothing</span>
        <input type="range" min="2" max="40" data-k="steady"></div>
      <div class="sec">Guides</div>
      <div class="row">
        <label><input type="checkbox" data-k="grid"> Grid</label>
        <input type="number" min="4" max="200" data-k="gridStep" title="grid spacing (canvas px)">
        <label><input type="checkbox" data-k="thirds"> Thirds</label>
        <label><input type="checkbox" data-k="centre"> Centre</label>
      </div>
      <div class="sec">Tracing paper</div>
      <div class="row">
        <button data-a="load">Load picture…</button>
        <button data-a="adjust" title="Drag to move, mouse wheel to resize">Move/size</button>
        <button data-a="fit">Fit</button>
        <button data-a="clear">✕</button>
      </div>
      <div class="row"><label><input type="checkbox" data-k="traceVisible"> Show</label>
        <input type="range" min="5" max="90" data-k="traceOpacity" data-pct></div>
      <div class="sec">Fill background</div>
      <div class="row"><button data-a="fill" title="Fills with the colour and brush selected in the site">🪣 Fill canvas</button>
        <span>brush</span><input type="number" min="1" max="200" data-k="fillWidth" title="width of the site's biggest brush, in canvas px (Karuta: 7)"> px</div>
      <div class="row"><button data-a="area" title="Drag a box: only that part is filled">Set area</button>
        <button data-a="wholearea">Whole canvas</button></div>
      <div class="hint" data-fillinfo>First pick your colour and the BIGGEST brush in the site.</div>
      <div class="row"><button data-a="pick" title="If the grid is on the wrong canvas">Next canvas</button>
        <span class="hint">Alt+G grid · Alt+T tracing</span></div>
      <input type="file" accept="image/*" hidden>
    </div>
  </div>`;
  const ov = root.querySelector("canvas.ov");
  const ctx = ov.getContext("2d");
  const panel = root.querySelector(".panel");
  const fileInput = root.querySelector("input[type=file]");
  let flash = 0;

  function syncUI() {
    panel.classList.toggle("mini", S.minimized);
    const mb = root.querySelector('[data-a="min"]');
    mb.textContent = S.minimized ? "+" : "–";
    mb.title = S.minimized ? "Open ArtKit (Alt+A)" : "Minimise (Alt+A)";
    S.panel = { x: Math.min(Math.max(0, S.panel.x), innerWidth - 60), y: Math.min(Math.max(0, S.panel.y), innerHeight - 30) };
    panel.style.left = S.panel.x + "px";
    panel.style.top = S.panel.y + "px";
    root.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === S.tool));
    root.querySelectorAll("[data-show]").forEach((el) => (el.style.display = el.dataset.show === S.tool ? "" : "none"));
    root.querySelectorAll("[data-k]").forEach((el) => {
      const v = S[el.dataset.k];
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = "pct" in el.dataset ? Math.round(v * 100) : v;
    });
    root.querySelector('[data-a="adjust"]').classList.toggle("on", adjusting);
    root.querySelector('[data-a="area"]').classList.toggle("on", settingArea);
    ov.classList.toggle("adjust", adjusting || settingArea);
    const plan = fillPlan();
    root.querySelector("[data-fillinfo]").textContent = plan
      ? `${plan.rows.length} strokes` + (/karuta\./.test(location.host) ? `, about ${plan.ink} ink on Karuta` : "") +
        (S.fillArea ? " (your area)" : " (whole canvas)") + ". Pick your colour and the BIGGEST brush first."
      : "First pick your colour and the BIGGEST brush in the site.";
    dirty = true;
  }
  function setTool(t) { S.tool = t; save(); syncUI(); }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tool) return setTool(b.dataset.tool);
    const a = b.dataset.a;
    if (a === "min") { S.minimized = !S.minimized; save(); }
    if (a === "load") fileInput.click();
    if (a === "adjust" && trace.img) adjusting = !adjusting;
    if (a === "fit") fitTrace();
    if (a === "clear") { trace.img = null; adjusting = false; }
    if (a === "pick") pickNext();
    if (a === "fill") fillCanvas();
    if (a === "area") { settingArea = !settingArea; adjusting = false; }
    if (a === "wholearea") { S.fillArea = null; settingArea = false; save(); }
    syncUI();
  });
  root.addEventListener("input", (e) => {
    const el = e.target, k = el.dataset && el.dataset.k;
    if (!k) return;
    if (el.type === "checkbox") S[k] = el.checked;
    else S[k] = "pct" in el.dataset ? el.value / 100 : Math.max(1, Number(el.value) || 1);
    save(); dirty = true;
    if (k === "fillWidth") syncUI();
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { trace.img = img; fitTrace(); S.traceVisible = true; adjusting = true; syncUI(); };
    img.src = URL.createObjectURL(f);
    fileInput.value = "";
  });
  function fitTrace() {
    const r = rect();
    if (!trace.img || !r) return;
    const cw = target.width || r.width, ch = target.height || r.height;
    const k = Math.max(cw / trace.img.width, ch / trace.img.height);      // cover the canvas
    trace.w = trace.img.width * k;
    trace.x = (cw - trace.w) / 2;
    trace.y = (ch - trace.img.height * k) / 2;
    dirty = true;
  }

  // drag the panel by its header
  root.querySelector(".head").addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const ox = e.clientX - S.panel.x, oy = e.clientY - S.panel.y, sx = e.clientX, sy = e.clientY;
    let moved = false;
    const mv = (ev) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) moved = true;
      if (moved) { S.panel = { x: ev.clientX - ox, y: ev.clientY - oy }; syncUI(); }
    };
    const upH = () => {
      window.removeEventListener("pointermove", mv, true); window.removeEventListener("pointerup", upH, true);
      if (!moved) { S.minimized = !S.minimized; syncUI(); }   // a click on the title opens / minimises
      save();
    };
    window.addEventListener("pointermove", mv, true);
    window.addEventListener("pointerup", upH, true);
  });

  // fill area: drag a box on the canvas
  ov.addEventListener("pointerdown", (e) => {
    if (!settingArea) return;
    const r = rect();
    if (!r) return;
    const s = scale(r);
    const c = (ev) => ({ x: Math.min(Math.max(ev.clientX, r.left), r.right), y: Math.min(Math.max(ev.clientY, r.top), r.bottom) });
    const a0 = c(e);
    areaDrag = { a: a0, b: a0 };
    const mv = (ev) => { areaDrag.b = c(ev); dirty = true; };
    const upH = () => {
      ov.removeEventListener("pointermove", mv); ov.removeEventListener("pointerup", upH);
      const { a, b } = areaDrag;
      if (Math.abs(b.x - a.x) > 4 && Math.abs(b.y - a.y) > 4) {
        S.fillArea = { x: (Math.min(a.x, b.x) - r.left) / s, y: (Math.min(a.y, b.y) - r.top) / s,
                       w: Math.abs(b.x - a.x) / s, h: Math.abs(b.y - a.y) / s };
        save();
      }
      areaDrag = null; settingArea = false; syncUI();
    };
    ov.addEventListener("pointermove", mv);
    ov.addEventListener("pointerup", upH);
  });

  // tracing paper: move / resize while "Move/size" is on (the overlay takes the mouse)
  ov.addEventListener("pointerdown", (e) => {
    if (!adjusting) return;
    const r = rect(), s = scale(r);
    const sx = e.clientX, sy = e.clientY, tx = trace.x, ty = trace.y;
    const mv = (ev) => { trace.x = tx + (ev.clientX - sx) / s; trace.y = ty + (ev.clientY - sy) / s; dirty = true; };
    const upH = () => { ov.removeEventListener("pointermove", mv); ov.removeEventListener("pointerup", upH); };
    ov.addEventListener("pointermove", mv);
    ov.addEventListener("pointerup", upH);
  });
  ov.addEventListener("wheel", (e) => {
    if (!adjusting || !trace.img) return;
    e.preventDefault();
    const r = rect(), s = scale(r);
    const f = e.deltaY < 0 ? 1.05 : 1 / 1.05;
    const cx = (e.clientX - r.left) / s, cy = (e.clientY - r.top) / s;   // zoom around the cursor
    trace.x = cx - (cx - trace.x) * f;
    trace.y = cy - (cy - trace.y) * f;
    trace.w *= f;
    dirty = true;
  }, { passive: false });

  // ------------------------------------------------------------------ input correction
  function forward(e, type, pt, buttons) {
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window, detail: e.detail,
      screenX: e.screenX + (pt.x - e.clientX), screenY: e.screenY + (pt.y - e.clientY),
      clientX: pt.x, clientY: pt.y, button: e.button,
      buttons: buttons === undefined ? e.buttons : buttons,
      ctrlKey: e.ctrlKey, altKey: false, shiftKey: false, metaKey: e.metaKey,  // our modifiers stay ours
    };
    let ev;
    if (type.startsWith("pointer")) {
      Object.assign(init, {
        pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
        width: e.width, height: e.height, tiltX: e.tiltX, tiltY: e.tiltY,
        pressure: init.buttons ? (e.pressure || 0.5) : 0,
      });
      ev = new PointerEvent(type, init);
    } else {
      ev = new MouseEvent(type, init);
    }
    ev[MARK] = true;
    g.target.dispatchEvent(ev);
  }

  function rulerEnd(e) {
    const dx = e.clientX - g.start.x, dy = e.clientY - g.start.y;
    let a = Math.atan2(dy, dx);
    const len = Math.hypot(dx, dy);
    if (S.snap !== e.altKey) {
      const s = Math.round(a / SNAP_STEP) * SNAP_STEP;
      if (Math.abs(s - a) < SNAP_RANGE) a = s;
    }
    return { x: g.start.x + len * Math.cos(a), y: g.start.y + len * Math.sin(a) };
  }

  function steadyStep(e) {
    const dx = e.clientX - g.pen.x, dy = e.clientY - g.pen.y, d = Math.hypot(dx, dy);
    if (d > S.steady) {
      g.pen = { x: g.pen.x + (dx * (d - S.steady)) / d, y: g.pen.y + (dy * (d - S.steady)) / d };
    }
  }

  function onInput(e) {
    if (e[MARK] || !(e.isTrusted || TEST)) return;
    if (e.composedPath().includes(host)) return;          // our own panel / overlay
    const fam = e.type.startsWith("pointer") ? "p" : "m";
    const kind = e.type.slice(fam === "p" ? 7 : 5);       // down | move | up
    if (kind === "move") mouse = { x: e.clientX, y: e.clientY, alt: e.altKey };

    if (kind === "down") {
      if (e.button !== 0 || adjusting) return;
      if (!g) {
        // the canvas you press on becomes the drawing canvas (sites often stack several)
        if (e.target instanceof HTMLCanvasElement && e.target !== target && visibleCanvases().includes(e.target)) {
          target = e.target;
          dirty = true;
        }
        const tool = S.tool !== "free" ? S.tool : e.shiftKey ? "ruler" : null;
        if (!tool || !inside(e.clientX, e.clientY)) return;
        const p = { x: e.clientX, y: e.clientY };
        g = { tool, target: e.target, start: p, end: p, pen: p, fams: new Set() };
      }
      if (g.fams.has(fam)) return;
      g.fams.add(fam);
      e.stopImmediatePropagation();
      forward(e, e.type, g.start);
      dirty = true;
      return;
    }
    if (!g || !g.fams.has(fam)) return;
    e.stopImmediatePropagation();

    if (kind === "move") {
      if (g.tool === "ruler") { g.end = rulerEnd(e); dirty = true; return; }   // no moves: preview only
      if (fam === "p" || !g.fams.has("p")) steadyStep(e);                        // once per real move
      forward(e, e.type, g.pen);
      dirty = true;
      return;
    }
    // up: move to the final point, then release there
    const end = g.tool === "ruler" ? (g.end = rulerEnd(e)) : g.pen;
    const moveType = fam === "p" ? "pointermove" : "mousemove";
    if (g.tool === "ruler") {
      // Some apps smooth a finished stroke into curves (Karuta Studio: paper.js simplify, and
      // every stroke starts with a tiny step to the RIGHT). With only 2 points a vertical line
      // then bulges ~22 px. Points every RULER_STEP px keep any direction straight (<= ~1 px,
      // tested on an exact copy of Studio's smoothing, all angles). Lines heading right stay 2
      // points: already perfect and the cheapest.
      const dx = end.x - g.start.x, dy = end.y - g.start.y, len = Math.hypot(dx, dy);
      const headingRight = dx > 0 && Math.abs(dy) <= 0.02 * dx;
      const n = headingRight ? 1 : Math.max(1, Math.ceil(len / RULER_STEP));
      for (let i = 1; i < n; i++) forward(e, moveType, { x: g.start.x + (dx * i) / n, y: g.start.y + (dy * i) / n }, 1);
    }
    forward(e, moveType, end, 1);
    forward(e, e.type, end, 0);
    g.fams.delete(fam);
    if (!g.fams.size) g = null;
    dirty = true;
  }
  for (const t of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup"]) {
    window.addEventListener(t, onInput, { capture: true });
  }

  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.repeat || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const acts = {
      a: () => { S.minimized = !S.minimized; save(); syncUI(); },
      1: () => setTool("free"), 2: () => setTool("ruler"), 3: () => setTool("steady"),
      g: () => { S.grid = !S.grid; save(); syncUI(); },
      t: () => { S.traceVisible = !S.traceVisible; save(); syncUI(); },
    };
    if (acts[k]) { e.preventDefault(); e.stopImmediatePropagation(); acts[k](); }
  }, { capture: true });

  // ------------------------------------------------------------------ fill background
  // Cheapest full cover: horizontal rows heading right, one stroke each (a press, one move and a
  // release), with the biggest brush, rows one brush-width apart minus 1 px of overlap (no gaps
  // whether the site lands strokes on whole or half pixels). The row length is a multiple of 3 px:
  // Karuta Studio then saves "c1,0 2,0 3,0" instead of "c0.33333,0 ..." (less ink).
  function fillPlan() {
    const r = rect();
    if (!r || !target) return null;
    const s = scale(r);
    const A = S.fillArea || { x: 0, y: 0, w: r.width / s, h: r.height / s };
    const left = r.left + A.x * s, top = r.top + A.y * s, right = left + A.w * s, bottom = top + A.h * s;
    const w = Math.max(1, S.fillWidth) * s, half = w / 2, step = Math.max(1, w - s);
    // Rows start/end 1 px inside the edges (sites ignore presses outside the canvas); the round
    // brush tips then cover the edge columns. First/last rows reach past the top/bottom edge.
    const x0 = Math.floor(left) + 1;
    let x1 = Math.max(x0, Math.ceil(right) - 1);
    const x3 = x0 + 3 * s * Math.ceil((x1 - x0) / (3 * s) - 1e-9);   // multiple of 3 canvas px (less ink)
    if (x3 <= right - 0.5) x1 = x3;
    const rows = [];
    const yLast = Math.ceil(bottom - half);
    for (let y = Math.floor(top + half); ; y += step) {
      const yy = Math.round(Math.min(y, yLast));
      if (!rows.length || yy > rows[rows.length - 1]) rows.push(yy);
      if (yy >= yLast) break;
    }
    // ink estimate with Karuta's formula: length of the saved SVG text / 35 (with one colour and one
    // width these are written once for the whole drawing)
    const dx = (x1 - x0) / s, n = (v) => String(+v.toFixed(5));
    const one = (y) => `<path d="M${n(x0 / s)},${n(y / s)}c${n(dx / 3)},0 ${n((2 * dx) / 3)},0 ${n(dx)},0"></path>`;
    const chars = rows.reduce((t, y) => t + one(y).length, 0) + 290;   // + the <g> wrapper paper.js writes
    return { rows: rows.map((y) => ({ y, x0, x1: Math.round(x1) })), ink: Math.round(chars / 35) };
  }

  async function fillCanvas() {
    const plan = fillPlan();
    if (!plan) return;
    const listens = (document.documentElement.dataset.artkitListens || "pointer,mouse").split(",");
    const fam = listens.includes("pointer") ? "pointer" : "mouse";   // the kind the site draws with
    const send = (type, x, y, buttons) => {
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
                     screenX: x + screenX, screenY: y + screenY, button: 0, buttons };
      const ev = fam === "pointer"
        ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, pressure: buttons ? 0.5 : 0 })
        : new MouseEvent(type, init);
      ev[MARK] = true;
      target.dispatchEvent(ev);
    };
    const btn = root.querySelector('[data-a="fill"]');
    btn.disabled = true;
    for (let i = 0; i < plan.rows.length; i++) {
      const { y, x0, x1 } = plan.rows[i];
      send(fam + "down", x0, y, 1);
      if (x1 !== x0) send(fam + "move", x1, y, 1);
      send(fam + "up", x1, y, 0);
      // let the site keep up (a timer, not requestAnimationFrame: that pauses in background tabs)
      if (i % 4 === 3) await new Promise((res) => setTimeout(res, 8));
    }
    btn.disabled = false;
  }

  // ------------------------------------------------------------------ overlay drawing
  let lastRect = "";
  function frame() {
    const r = rect();
    const key = r ? [r.left, r.top, r.width, r.height, innerWidth, innerHeight].join() : "";
    const active = g || (S.tool === "steady" && mouse) || performance.now() - flash < 1200;
    if (dirty || key !== lastRect || active) { draw(r); lastRect = key; dirty = false; }
    requestAnimationFrame(frame);
  }

  function draw(r) {
    const dpr = devicePixelRatio || 1;
    if (ov.width !== Math.round(innerWidth * dpr) || ov.height !== Math.round(innerHeight * dpr)) {
      ov.width = Math.round(innerWidth * dpr);
      ov.height = Math.round(innerHeight * dpr);
      ov.style.width = innerWidth + "px";
      ov.style.height = innerHeight + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!r) return;
    const s = scale(r);

    if (trace.img && S.traceVisible) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.left, r.top, r.width, r.height);
      ctx.clip();
      ctx.globalAlpha = S.traceOpacity;
      const h = (trace.w * trace.img.height) / trace.img.width;
      ctx.drawImage(trace.img, r.left + trace.x * s, r.top + trace.y * s, trace.w * s, h * s);
      ctx.restore();
      if (adjusting) outline(r, "#ffb400");
    }
    if (S.grid || S.thirds || S.centre) {
      ctx.save();
      ctx.lineWidth = 1;
      if (S.grid) {
        ctx.strokeStyle = "rgba(0,200,255,.28)";
        const step = Math.max(2, S.gridStep * s);
        ctx.beginPath();
        for (let x = r.left; x <= r.right + 0.5; x += step) { ctx.moveTo(Math.round(x) + 0.5, r.top); ctx.lineTo(Math.round(x) + 0.5, r.bottom); }
        for (let y = r.top; y <= r.bottom + 0.5; y += step) { ctx.moveTo(r.left, Math.round(y) + 0.5); ctx.lineTo(r.right, Math.round(y) + 0.5); }
        ctx.stroke();
      }
      const lines = (fr, col) => {
        ctx.strokeStyle = col;
        ctx.beginPath();
        for (const f of fr) {
          ctx.moveTo(r.left + r.width * f, r.top); ctx.lineTo(r.left + r.width * f, r.bottom);
          ctx.moveTo(r.left, r.top + r.height * f); ctx.lineTo(r.right, r.top + r.height * f);
        }
        ctx.stroke();
      };
      if (S.thirds) lines([1 / 3, 2 / 3], "rgba(255,80,200,.55)");
      if (S.centre) lines([0.5], "rgba(255,210,0,.6)");
      ctx.restore();
    }
    if (performance.now() - flash < 1200) outline(r, "#5865f2");
    if (areaDrag) {
      const { a, b } = areaDrag;
      ctx.save(); ctx.strokeStyle = "#35d07f"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.restore();
    } else if (S.fillArea && !S.minimized) {
      const A = S.fillArea;
      ctx.save(); ctx.strokeStyle = "rgba(53,208,127,.7)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.strokeRect(r.left + A.x * s, r.top + A.y * s, A.w * s, A.h * s); ctx.restore();
    }

    if (g && g.tool === "ruler") {
      ctx.save();
      ctx.strokeStyle = "#ff3df0";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(g.start.x, g.start.y); ctx.lineTo(g.end.x, g.end.y); ctx.stroke();
      const len = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) / s;
      let deg = (-Math.atan2(g.end.y - g.start.y, g.end.x - g.start.x) * 180) / Math.PI;
      deg = Math.round((deg + 360) % 360);
      label(`${Math.round(len)} px · ${deg}°`, g.end.x + 10, g.end.y - 10);
      ctx.restore();
    }
    if (S.tool === "steady" && mouse && inside(mouse.x, mouse.y)) {
      const pen = g ? g.pen : mouse;
      ctx.save();
      ctx.strokeStyle = "rgba(88,101,242,.7)";
      ctx.beginPath(); ctx.arc(mouse.x, mouse.y, S.steady, 0, 2 * Math.PI); ctx.stroke();
      if (g) { ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(pen.x, pen.y); ctx.stroke(); }
      ctx.restore();
    }
  }
  function outline(r, col) {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.strokeRect(r.left + 1, r.top + 1, r.width - 2, r.height - 2); ctx.restore();
  }
  function label(text, x, y) {
    ctx.font = "12px system-ui, sans-serif";
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = "#232428ee"; ctx.fillRect(x, y - 14, w, 20);
    ctx.fillStyle = "#fff"; ctx.fillText(text, x + 5, y);
  }

  // ------------------------------------------------------------------ start
  function start() {
    (document.body || document.documentElement).appendChild(host);
    load(() => { S.tool = S.tool || "free"; syncUI(); });
    requestAnimationFrame(frame);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
  window.__artkit = { S, trace, pickNext, setTool, get target() { return target; } };  // for tests
})();
