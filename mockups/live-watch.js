// Watchtower watch-page mockup: a simulated feed drawn on a canvas. The real
// page reuses heimdall.js; this only demonstrates the layout, the satellite
// states and what a viewer sees when the operator moves a satellite.
(() => {
  "use strict";

  const W = window.Watchtower;
  const $ = id => document.getElementById(id);
  const sat = W.byId(new URLSearchParams(location.search).get("sat")) || W.SATELLITES[0];
  const canvas = $("map");
  const ctx = canvas.getContext("2d", { alpha: false });
  const ui = { follow: $("follow"), showOthers: $("showOthers"), showLabels: $("showLabels") };

  const BURN_MS = 6500; // simulated wait until a moved satellite reports in
  const GLIDE_MS = 900;
  const MAX_ZOOM = 14;
  const NOTICE_WINDOW_MS = 10 * 60000;
  const WHOLE = { left: 0, bottom: 0, right: W.WARZONE, top: W.WARZONE };
  const SIDE_COLORS = { home: "#43c6f0", foreign: "#ff5d5d", none: "#8a96a3" };
  const ALLIANCES = [
    { abbr: "Hua", side: "home" }, { abbr: "RoX", side: "home" }, { abbr: "ODN", side: "home" },
    { abbr: "VLK", side: "foreign" }, { abbr: "K9s", side: "foreign" },
  ];

  let layout = { footprints: {}, structures: [] };
  let state = sat.state;
  let feed = { bases: [], marches: [], newMarch: null };
  let glide = null;
  let lastUpdate = Date.now();
  let lastStats = 0;
  const view = { x: 500, y: 500, zoom: 1 };

  // ---- sample feed -------------------------------------------------------
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const seedOf = text => [...text].reduce((hash, ch) => Math.imul(hash ^ ch.charCodeAt(0), 16777619), 2166136261);

  // sampleFeed scatters unaffiliated bases over the box, clusters alliance
  // bases, and sends marches from alliance bases to structures or bases.
  function sampleFeed(area, baseCount, marchCount) {
    const rand = rng(seedOf(sat.id + area.left + area.bottom));
    const span = (low, high) => low + rand() * (high - low);
    const pick = list => list[Math.floor(rand() * list.length)];
    const inside = (x, y) => ({ x: W.clamp(x, area.left + 2, area.right - 2), y: W.clamp(y, area.bottom + 2, area.top - 2) });
    const clusters = ALLIANCES.map(a => ({ ...a, x: span(area.left + 70, area.right - 70), y: span(area.bottom + 70, area.top - 70), spread: span(22, 55) }));
    const bases = [];
    for (let i = 0; i < baseCount; i++) {
      if (rand() < 0.55) {
        bases.push({ ...inside(span(area.left, area.right), span(area.bottom, area.top)), side: "none", abbr: "", shield: rand() < 0.2 });
        continue;
      }
      const c = pick(clusters);
      const angle = rand() * Math.PI * 2;
      const radius = c.spread * Math.sqrt(rand());
      bases.push({ ...inside(c.x + Math.cos(angle) * radius, c.y + Math.sin(angle) * radius), side: c.side, abbr: c.abbr, shield: rand() < 0.35 });
    }
    const targets = layout.structures.filter(s => s.x > area.left && s.x < area.right && s.y > area.bottom && s.y < area.top);
    const senders = bases.filter(b => b.side !== "none");
    const newMarch = progress => {
      const from = pick(senders.length ? senders : bases);
      const goal = targets.length && rand() < 0.6 ? pick(targets) : pick(bases);
      const length = Math.hypot(goal.x - from.x, goal.y - from.y) || 1;
      return { fx: from.x, fy: from.y, tx: goal.x, ty: goal.y, side: from.side, length, speed: span(1, 4), travelled: progress * length };
    };
    return { bases, marches: Array.from({ length: marchCount }, () => newMarch(rand())), newMarch };
  }

  function advance(dt) {
    feed.marches = feed.marches.map(m => {
      const travelled = m.travelled + m.speed * dt;
      return travelled >= m.length ? feed.newMarch(0) : { ...m, travelled };
    });
  }

  // ---- view --------------------------------------------------------------
  function screenSize() {
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
  function resizeCanvas() {
    const ratio = window.devicePixelRatio || 1;
    const s = screenSize();
    const w = Math.round(s.width * ratio);
    const h = Math.round(s.height * ratio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return s;
  }
  const toScreen = (x, y, s) => ({ x: (x - view.x) * view.zoom + s.width / 2, y: (view.y - y) * view.zoom + s.height / 2 });
  const toWorld = (sx, sy, s) => ({ x: view.x + (sx - s.width / 2) / view.zoom, y: view.y - (sy - s.height / 2) / view.zoom });
  function fitView(area) {
    const s = screenSize();
    const w = area.right - area.left;
    const h = area.top - area.bottom;
    return { x: (area.left + area.right) / 2, y: (area.bottom + area.top) / 2, zoom: Math.min(s.width / (w * 1.12), s.height / (h * 1.12)) };
  }
  function clampView() {
    const pad = W.WARZONE * 0.12;
    view.zoom = W.clamp(view.zoom, fitView(WHOLE).zoom * 0.85, MAX_ZOOM);
    view.x = W.clamp(view.x, -pad, W.WARZONE + pad);
    view.y = W.clamp(view.y, -pad, W.WARZONE + pad);
  }
  const glideTo = target => { glide = { from: { ...view }, to: target, start: performance.now() }; };
  function stepGlide(now) {
    if (!glide) return;
    const t = Math.min(1, (now - glide.start) / GLIDE_MS);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    view.x = glide.from.x + (glide.to.x - glide.from.x) * e;
    view.y = glide.from.y + (glide.to.y - glide.from.y) * e;
    view.zoom = glide.from.zoom * (glide.to.zoom / glide.from.zoom) ** e;
    if (t === 1) glide = null;
  }
  function zoomAt(sx, sy, nextZoom) {
    const s = screenSize();
    const before = toWorld(sx, sy, s);
    view.zoom = W.clamp(nextZoom, fitView(WHOLE).zoom * 0.85, MAX_ZOOM);
    const after = toWorld(sx, sy, s);
    view.x += before.x - after.x;
    view.y += before.y - after.y;
    glide = null;
  }
  const zoomCentre = factor => zoomAt(screenSize().width / 2, screenSize().height / 2, view.zoom * factor);

  // ---- drawing -----------------------------------------------------------
  const hexA = (hex, alpha) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
  };
  const offscreen = (p, s, margin) => p.x < -margin || p.y < -margin || p.x > s.width + margin || p.y > s.height + margin;
  function screenRect(area, s) {
    const a = toScreen(area.left, area.top, s);
    const b = toScreen(area.right, area.bottom, s);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

  function drawGrid(s) {
    ctx.fillStyle = "#080b10";
    ctx.fillRect(0, 0, s.width, s.height);
    const step = view.zoom > 5 ? 10 : view.zoom > 1.6 ? 25 : view.zoom > 0.7 ? 50 : 100;
    const topLeft = toWorld(0, 0, s);
    const bottomRight = toWorld(s.width, s.height, s);
    ctx.lineWidth = 1;
    for (let x = Math.floor(topLeft.x / step) * step; x <= bottomRight.x; x += step) {
      ctx.strokeStyle = x % 100 === 0 ? "rgba(95,114,133,.22)" : "rgba(95,114,133,.09)";
      const sx = toScreen(x, 0, s).x;
      line(sx, 0, sx, s.height);
    }
    for (let y = Math.floor(bottomRight.y / step) * step; y <= topLeft.y; y += step) {
      ctx.strokeStyle = y % 100 === 0 ? "rgba(95,114,133,.22)" : "rgba(95,114,133,.09)";
      const sy = toScreen(0, y, s).y;
      line(0, sy, s.width, sy);
    }
    const r = screenRect(WHOLE, s);
    ctx.strokeStyle = "rgba(157,176,194,.42)";
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  function drawStructures(s) {
    if (!sat.area) return;
    for (const st of layout.structures) {
      const p = toScreen(st.x, st.y, s);
      if (st.kind === "capitol") {
        const m = W.clamp(view.zoom * 3.2, 4, 14);
        ctx.fillStyle = "rgba(255,209,102,.2)";
        ctx.strokeStyle = "#ffd166";
        ctx.beginPath(); ctx.moveTo(p.x, p.y - m); ctx.lineTo(p.x + m, p.y); ctx.lineTo(p.x, p.y + m); ctx.lineTo(p.x - m, p.y); ctx.closePath();
        ctx.fill(); ctx.stroke();
        continue;
      }
      const print = layout.footprints[st.kind];
      if (!print?.zone) continue;
      const zoneHalf = print.zone * view.zoom / 2;
      const coreHalf = print.core * view.zoom / 2;
      if (offscreen(p, s, zoneHalf + 10)) continue;
      const color = W.STRUCTURE_COLORS[st.kind];
      ctx.fillStyle = "rgba(150,160,172,.13)";
      ctx.strokeStyle = "rgba(170,180,192,.32)";
      ctx.fillRect(p.x - zoneHalf, p.y - zoneHalf, zoneHalf * 2, zoneHalf * 2);
      ctx.strokeRect(p.x - zoneHalf, p.y - zoneHalf, zoneHalf * 2, zoneHalf * 2);
      ctx.fillStyle = hexA(color, 0.22);
      ctx.strokeStyle = hexA(color, 0.9);
      ctx.fillRect(p.x - coreHalf, p.y - coreHalf, coreHalf * 2, coreHalf * 2);
      ctx.strokeRect(p.x - coreHalf, p.y - coreHalf, coreHalf * 2, coreHalf * 2);
    }
  }

  function drawBox(area, color, text, s, { dash = [8, 5], offset = 0, alpha = 0.85 } = {}) {
    const r = screenRect(area, s);
    ctx.save();
    ctx.setLineDash(dash);
    ctx.lineDashOffset = offset;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = hexA(color, alpha);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = hexA(color, Math.min(1, alpha + 0.1));
    ctx.fillText(text, r.x + 6, r.y + 6);
    ctx.restore();
    return r;
  }

  const others = () => W.SATELLITES.filter(o => o !== sat && o.area && o.server === sat.server);
  const boxLabel = (s, st) => `${s.code} · ${s.name} · ${W.STATES[st].label}`.toUpperCase();

  function drawSatellites(s, now) {
    if (!sat.area) return;
    const shown = ui.showOthers.checked ? others() : [];
    ctx.save();
    ctx.beginPath();
    for (const area of [WHOLE, sat.area, ...shown.map(o => o.area)]) {
      const r = screenRect(area, s);
      ctx.rect(r.x, r.y, r.w, r.h);
    }
    ctx.fillStyle = "rgba(0,0,0,.4)";
    ctx.fill("evenodd");
    ctx.restore();
    for (const o of shown) drawBox(o.area, W.TONES[o.state], boxLabel(o, o.state), s, { alpha: 0.45 });
    if (state === "moving") {
      drawBox(sat.previous.area, W.TONES.other, "LAST POSITION", s, { dash: [3, 4], alpha: 0.35 });
      const r = drawBox(sat.area, W.TONES.moving, boxLabel(sat, state), s, { offset: -now / 60 });
      ctx.save();
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(now / 260);
      ctx.fillStyle = W.TONES.moving;
      ctx.font = "600 12px ui-monospace, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("ACQUIRING PICTURE…", r.x + r.w / 2, r.y + r.h / 2 - 18);
      ctx.restore();
      return;
    }
    drawBox(sat.area, W.TONES[state], boxLabel(sat, state), s, { dash: state === "live" ? [8, 5] : [3, 4] });
  }

  function drawBases(s, alpha) {
    const size = Math.max(2.5, view.zoom * 3);
    let visible = 0;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    ctx.font = "9px ui-monospace, Consolas, monospace";
    ctx.textBaseline = "middle";
    for (const b of feed.bases) {
      const p = toScreen(b.x, b.y, s);
      if (offscreen(p, s, 10)) continue;
      visible++;
      const color = SIDE_COLORS[b.side];
      ctx.fillStyle = hexA(color, 0.35);
      ctx.strokeStyle = color;
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
      if (b.shield && view.zoom > 2) {
        ctx.strokeStyle = "rgba(124,225,255,.9)";
        ctx.beginPath(); ctx.arc(p.x, p.y, size * 0.75 + 3, 0, Math.PI * 2); ctx.stroke();
      }
      if (ui.showLabels.checked && b.abbr && view.zoom > 2.2) {
        ctx.fillStyle = "rgba(232,238,245,.72)";
        ctx.fillText(b.abbr, p.x + size / 2 + 3, p.y);
      }
    }
    ctx.globalAlpha = 1;
    return visible;
  }

  function drawMarches(s) {
    for (const m of feed.marches) {
      const k = m.travelled / m.length;
      const p = toScreen(m.fx + (m.tx - m.fx) * k, m.fy + (m.ty - m.fy) * k, s);
      if (offscreen(p, s, 60)) continue;
      const t = toScreen(m.tx, m.ty, s);
      const color = SIDE_COLORS[m.side];
      ctx.strokeStyle = hexA(color, 0.28);
      ctx.lineWidth = 1;
      line(p.x, p.y, t.x, t.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(t.y - p.y, t.x - p.x));
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(6.75, 0); ctx.lineTo(-4.5, 4.5); ctx.lineTo(-4.5, -4.5); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  // ---- page chrome -------------------------------------------------------
  function renderHeader() {
    $("satEyebrow").textContent = `Watchtower · ${sat.code}`;
    $("satName").textContent = sat.name;
    $("satWhere").textContent = sat.area ? `S${sat.server} · centre ${W.fmtCentre(sat.area)}` : "no orbit yet";
    const pill = $("satState");
    pill.className = `state-pill is-${state}`;
    pill.textContent = W.STATES[state].label;
    document.title = `Watchtower — ${sat.name}`;
  }

  function renderFresh() {
    const watching = sat.viewers ? ` · ${sat.viewers} watching` : "";
    $("satFresh").textContent = {
      live: `Updated ${((Date.now() - lastUpdate) / 1000).toFixed(1)} s ago${watching}`,
      moving: `Repositioning since ${W.ago(sat.movedAt)}${watching}`,
      down: `Last contact ${W.ago(sat.lostAt)}`,
      pad: "Not implemented",
    }[state];
    $("feedNote").textContent = { live: "", moving: "Old picture cleared", down: "Frozen picture · not live", pad: "" }[state];
  }

  function renderSwitch() {
    $("satSwitch").replaceChildren(...W.SATELLITES.map(other => {
      const shownState = other === sat ? state : other.state;
      const link = document.createElement(other.implemented ? "a" : "span");
      link.className = `sat-tab is-${shownState}`;
      if (other.implemented) link.href = `live-watch.html?sat=${other.id}`;
      else link.setAttribute("aria-disabled", "true");
      link.title = W.STATES[shownState].label;
      if (other === sat) link.setAttribute("aria-current", "page");
      link.append(document.createElement("i"), `${other.code} ${other.name}${other.implemented ? "" : " · Not implemented"}`);
      return link;
    }));
  }

  function notice(title, text) {
    $("noticeTitle").textContent = title;
    $("noticeText").textContent = text;
    $("orbitNotice").hidden = false;
  }

  function overlay(tone, title, text, meta) {
    const node = $("stageOverlay");
    node.className = `stage-overlay is-${tone}`;
    $("overlayTitle").textContent = title;
    $("overlayText").textContent = text;
    $("overlayMeta").textContent = meta;
    node.hidden = false;
  }

  const followLine = () => (ui.follow.checked ? "Follow satellite is on, so your view moved with it." : "Follow satellite is off; Reset view jumps to it.");
  function movedNotice(when) {
    notice(
      `${sat.name} moved ${when}`,
      `Now over S${sat.server} · centre ${W.fmtCentre(sat.area)} (was ${W.fmtCentre(sat.previous.area)}), since ${W.clock(sat.movedAt)}. ${followLine()}`,
    );
  }

  // arrive ends a simulated burn: new pictures replace the cleared ones.
  function arrive() {
    state = "live";
    sat.movedAt = Date.now();
    feed = sampleFeed(sat.area, 934, 48);
    lastUpdate = Date.now();
    renderHeader();
    renderSwitch();
    renderFresh();
    movedNotice("just now");
  }

  function start() {
    if (state === "live") {
      feed = sampleFeed(sat.area, sat.bases, sat.marches);
      Object.assign(view, fitView(sat.area));
      if (sat.previous && Date.now() - sat.movedAt < NOTICE_WINDOW_MS) movedNotice(W.ago(sat.movedAt));
    } else if (state === "moving") {
      Object.assign(view, fitView(sat.previous.area));
      setTimeout(() => { if (ui.follow.checked) glideTo(fitView(sat.area)); }, 500);
      notice("Repositioning", `${sat.name} is moving to S${sat.server} · centre ${W.fmtCentre(sat.area)}. The old picture is cleared; new pictures arrive in a few seconds.`);
      setTimeout(arrive, BURN_MS);
    } else if (state === "down") {
      feed = sampleFeed(sat.area, sat.bases, 0);
      Object.assign(view, fitView(sat.area));
      overlay("down", "Disconnected",
        `${sat.name} stopped reporting ${W.ago(sat.lostAt)} (${sat.lostReason}). The map shows the last picture received, and it is not live. The satellite keeps trying on its own.`,
        `Last contact ${W.clock(sat.lostAt)} · S${sat.server} · centre ${W.fmtCentre(sat.area)}`);
    } else {
      Object.assign(view, fitView(WHOLE));
      overlay("pad", "Not implemented",
        `${sat.name} is a future camera. Its feed and controls are not implemented yet.`,
        "Choose Sentinel to explore the available camera mockup.");
    }
    renderHeader();
    renderSwitch();
    renderFresh();
  }

  // ---- loop + input ------------------------------------------------------
  let lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    stepGlide(now);
    if (state === "live") advance(dt);
    const s = resizeCanvas();
    clampView();
    drawGrid(s);
    drawStructures(s);
    drawSatellites(s, now);
    const visible = drawBases(s, state === "down" ? 0.35 : 1);
    if (state === "live") drawMarches(s);
    if (now - lastStats > 250) {
      lastStats = now;
      $("baseCount").textContent = visible.toLocaleString();
      $("marchCount").textContent = state === "live" ? feed.marches.length : 0;
    }
  }

  let drag = null;
  canvas.addEventListener("pointerdown", event => {
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    glide = null;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", event => {
    if (!drag) return;
    view.x = drag.vx - (event.clientX - drag.x) / view.zoom;
    view.y = drag.vy + (event.clientY - drag.y) / view.zoom;
  });
  const endDrag = () => { drag = null; canvas.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    zoomAt(event.offsetX, event.offsetY, view.zoom * Math.exp(-event.deltaY * 0.0015));
  }, { passive: false });
  canvas.addEventListener("keydown", event => {
    const pan = 60 / view.zoom;
    const moves = { ArrowLeft: [-pan, 0], ArrowRight: [pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] };
    if (moves[event.key]) {
      event.preventDefault();
      view.x += moves[event.key][0];
      view.y += moves[event.key][1];
    }
    if (event.key === "+" || event.key === "=") zoomCentre(1.4);
    if (event.key === "-") zoomCentre(1 / 1.4);
  });
  $("zoomIn").addEventListener("click", () => zoomCentre(1.4));
  $("zoomOut").addEventListener("click", () => zoomCentre(1 / 1.4));
  $("resetView").addEventListener("click", () => glideTo(fitView(sat.area || WHOLE)));
  ui.follow.addEventListener("change", () => { if (ui.follow.checked && sat.area) glideTo(fitView(sat.area)); });
  $("noticeClose").addEventListener("click", () => { $("orbitNotice").hidden = true; });

  setInterval(() => {
    if (state === "live") lastUpdate = Date.now() - Math.random() * 300;
    renderFresh();
  }, W.CONFIG.intervalMs);

  W.loadLayout().then(loaded => {
    layout = loaded;
    start();
    requestAnimationFrame(frame);
  });
})();
