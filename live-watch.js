// Watchtower watch page: one satellite's live feed from its lwlive relay,
// drawn the way the mockup does. The relay sends a snapshot, then batched
// base and march changes plus camera status (see watchtower-feed.js).
(() => {
  "use strict";

  const W = window.Watchtower;
  const live = window.HeimdallLive;
  const F = window.WatchtowerFeed;
  const $ = id => document.getElementById(id);
  const sat = W.byId(new URLSearchParams(location.search).get("sat")) || W.SATELLITES[0];
  const canvas = $("map");
  const ctx = canvas.getContext("2d", { alpha: false });
  const ui = { follow: $("follow"), showRoutes: $("showRoutes"), showLabels: $("showLabels") };

  const GLIDE_MS = 900;
  const MAX_ZOOM = 14;
  const NOTICE_WINDOW_MS = 10 * 60000;
  const REVIVE_AFTER_MS = 60000; // a tab back from sleep reconnects if this quiet
  const WHOLE = { left: 0, bottom: 0, right: W.WARZONE, top: W.WARZONE };
  const overrides = new Map();
  const highlighted = new Map(); // UID -> last known label; survives snapshot reindexing.
  let selected = null;
  let hits = [];
  const colorFor = (player, home) => F.playerColor(player, home, $("colorMode").value, overrides);

  const feed = F.createFeed();
  const view = { x: 500, y: 500, zoom: 1 };
  let connection = { state: "connecting", attempt: 0, retryAt: 0 };
  let camera = null; // this satellite's latest status from the relay
  let layout = { footprints: {}, structures: [] };
  let layoutServer = 0;
  let glide = null;
  let fitted = false;
  let lastStats = 0;

  const playerLabel = player => player?.name || player?.uid || "Unknown player";
  const coords = pos => { const p = F.unpack(pos, feed.mapWidth); return `${p.x}, ${p.y}`; };
  function markHighlight(player, p, radius) {
    if (!player || !highlighted.has(player.uid)) return;
    ctx.save();
    ctx.lineWidth = 4; ctx.strokeStyle = "#080b10";
    ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
    ctx.restore();
  }
  function toggleHighlight(player) {
    if (!player) return;
    if (highlighted.has(player.uid)) highlighted.delete(player.uid);
    else highlighted.set(player.uid, playerLabel(player));
    renderHighlights(); renderSearch(); renderDetail();
  }
  function renderHighlights() {
    $("highlightCount").textContent = highlighted.size ? `(${highlighted.size} highlighted)` : "";
    $("clearHighlights").hidden = !highlighted.size;
    $("playerHighlights").replaceChildren(...[...highlighted].map(([uid, label]) => {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = `${label} ×`;
      button.setAttribute("aria-label", `Remove highlight for ${label}`);
      button.onclick = () => { highlighted.delete(uid); renderHighlights(); renderSearch(); renderDetail(); };
      return button;
    }));
  }
  function renderSearch() {
    const query = $("playerSearch").value.trim().toLocaleLowerCase();
    const results = $("searchResults");
    results.replaceChildren();
    if (!query) return;
    const players = feed.players.filter(p => p && `${p.name} ${p.uid} ${p.abbr}`.toLocaleLowerCase().includes(query));
    for (const player of players.slice(0, 30)) {
      const row = document.createElement("div"); row.className = "tool-row";
      const button = document.createElement("button"); button.type = "button";
      button.textContent = `${playerLabel(player)} · ${player.abbr || "No alliance"} · S${player.server || "?"} · ${player.uid}`;
      button.setAttribute("aria-pressed", String(highlighted.has(player.uid)));
      button.onclick = () => toggleHighlight(player);
      const inspect = document.createElement("button"); inspect.type = "button"; inspect.textContent = "Details";
      inspect.setAttribute("aria-label", `Inspect ${playerLabel(player)}`);
      inspect.onclick = () => {
        selected = { kind: "base", uid: player.uid };
        renderDetail(); $("closeDetail").focus();
      };
      row.append(button, inspect); results.append(row);
    }
    const note = document.createElement("p");
    note.textContent = players.length ? `${players.length} matches${players.length > 30 ? " · first 30 shown; refine your search" : ""}. Tap a name to toggle its highlight.` : "No matching players in this feed.";
    results.append(note);
  }
  function renderAlliances() {
    const select = $("allianceChoice"), previous = select.value;
    const alliances = new Map();
    for (const p of feed.players) if (p?.abbr) alliances.set(F.allianceKey(p), `${p.abbr} · S${p.server || "?"}`);
    select.replaceChildren(new Option("Choose alliance", ""), ...[...alliances].sort((a,b) => a[1].localeCompare(b[1])).map(([key, label]) => new Option(label + (overrides.has(key) ? " · custom" : ""), key)));
    if (alliances.has(previous)) select.value = previous;
    $("applyColor").disabled = $("resetColor").disabled = !select.value;
  }
  function selectionEntity() {
    if (!selected) return null;
    if (selected.kind === "base") {
      const player = feed.players.find(p => p?.uid === selected.uid);
      return { player, entity: player && feed.bases.get(player.index), title: "Player base" };
    }
    const entity = feed.marches.get(selected.id);
    return { entity, player: entity && feed.players[entity.player], title: entity ? F.entityKind(entity) : "March" };
  }
  function renderDetail() {
    const detail = $("entityDetail"); detail.hidden = !selected;
    if (!selected) return;
    const { entity, player, title } = selectionEntity();
    $("detailTitle").textContent = `${title} · ${playerLabel(player)}`;
    const rows = [["Player", playerLabel(player)]];
    if (player?.uid) rows.push(["UID", player.uid]);
    if (player?.abbr) rows.push(["Alliance", player.abbr]);
    if (player?.server) rows.push(["Home server", player.server]);
    const t = F.dataNow(feed, Date.now());
    let note = "";
    if (!entity) note = "This entity is no longer present in the current feed.";
    else if (selected.kind === "base") {
      rows.push(["Coordinates", coords(entity.pos)]);
      const left = F.shieldRemaining(entity.shieldEnd, Date.now());
      rows.push(["Shield", left ? F.duration(left) + " remaining" : "No active timed shield"]);
    } else {
      const p = F.marchPoint(entity, t, feed.mapWidth);
      rows.push(["Current location", `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`], ["From", coords(entity.start)], ["Destination", coords(entity.target)], ["March type", entity.type], ["Target type", entity.targetKind]);
      if (entity.speed > 0) rows.push(["Travel speed", `${entity.speed} tiles/s`]);
      const state = F.marchState(entity, t, feed.mapWidth);
      const left = F.duration((entity.endMs - t) / 1000);
      const movement = state === "rally-waiting" ? `Rally countdown · ${left}`
        : state === "gathering" ? `Gathering · ${left} remaining`
        : state === "expired" ? "Timer ended · awaiting feed update" : `${left} to arrival`;
      if (entity.endMs > 0) rows.push(["Activity", movement]);
      if (state === "rally-waiting") note = "Held at origin until the feed reports travel. Rally state is inferred from timing; participant counts are not supplied.";
      if (entity.team) rows.push(["Relay team ID", entity.team]);
      if (F.isTransport(entity)) note = "Transport detected. This feed does not distinguish truck from train or supply a separate escort roster.";
    }
    $("detailFields").replaceChildren(...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = value; return [dt, dd];
    }));
    $("detailNote").textContent = note;
    $("highlightSelected").disabled = !player;
    $("highlightSelected").textContent = highlighted.has(player?.uid) ? "Remove player highlight" : "Highlight player";
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
    return {
      x: (area.left + area.right) / 2, y: (area.bottom + area.top) / 2,
      zoom: Math.min(s.width / ((area.right - area.left) * 1.12), s.height / ((area.top - area.bottom) * 1.12)),
    };
  }
  const minZoom = () => fitView(WHOLE).zoom * 0.85;
  function clampView() {
    const pad = W.WARZONE * 0.12;
    view.zoom = W.clamp(view.zoom, minZoom(), MAX_ZOOM);
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
    view.zoom = W.clamp(nextZoom, minZoom(), MAX_ZOOM);
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
    for (const st of layout.structures) {
      const p = toScreen(st.x, st.y, s);
      if (st.kind === "capitol") {
        continue; // drawn once by the capture-verified capitol overlay below
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

  // Restored from heimdall.js CAPITOL/drawCapitol, including the verified
  // centre (500,499), rather than the season layout's approximate centre.
  function drawCapitol(s) {
    const x = 500, y = 499;
    const boundary = [[-25,50],[25,50],[25,25],[50,25],[50,-25],[25,-25],
      [25,-50],[-25,-50],[-25,-25],[-50,-25],[-50,25],[-25,25]];
    ctx.save(); ctx.beginPath();
    boundary.forEach(([dx,dy], index) => {
      const p = toScreen(x + dx, y + dy, s);
      if (index) ctx.lineTo(p.x,p.y); else ctx.moveTo(p.x,p.y);
    });
    ctx.closePath(); ctx.fillStyle = "rgba(150,160,172,.13)"; ctx.fill();
    ctx.strokeStyle = "rgba(124,225,255,.76)"; ctx.lineWidth = 1.35;
    ctx.setLineDash([6,4]); ctx.stroke(); ctx.setLineDash([]);
    const r = screenRect({left:x-10.5,right:x+10.5,bottom:y-10.5,top:y+10.5},s);
    ctx.fillStyle = "rgba(255,69,91,.13)"; ctx.fillRect(r.x,r.y,r.w,r.h);
    ctx.strokeStyle = "rgba(255,97,116,.88)"; ctx.strokeRect(r.x,r.y,r.w,r.h);
    if (view.zoom >= 3.5) {
      ctx.strokeStyle = "rgba(255,97,116,.16)"; ctx.lineWidth = 1;
      for (let i=1;i<21;i++) {
        line(r.x+i*view.zoom,r.y,r.x+i*view.zoom,r.y+r.h);
        line(r.x,r.y+i*view.zoom,r.x+r.w,r.y+i*view.zoom);
      }
    }
    const p = toScreen(x,y,s), m = W.clamp(view.zoom*3.2,4,14);
    ctx.fillStyle = "rgba(255,209,102,.2)"; ctx.strokeStyle = "#ffd166";
    ctx.beginPath(); ctx.moveTo(p.x,p.y-m); ctx.lineTo(p.x+m,p.y); ctx.lineTo(p.x,p.y+m); ctx.lineTo(p.x-m,p.y); ctx.closePath(); ctx.fill(); ctx.stroke();
    for (const [dx,dy] of [[-9,9],[9,9],[-9,-9],[9,-9]]) {
      const c = toScreen(x+dx,y+dy,s);
      ctx.beginPath(); ctx.arc(c.x,c.y,W.clamp(view.zoom*1.35,2,6),0,Math.PI*2); ctx.fill(); ctx.stroke();
    }
    if (view.zoom >= 1.35) {
      const label = toScreen(x,y+39,s);
      ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.textAlign = "center";
      ctx.fillStyle = "#adbdce"; ctx.fillText("CAPITOL AREA",label.x,label.y);
    }
    ctx.restore();
  }

  // drawSatellite dims everything outside the box and outlines it in the
  // colour of its state; while repositioning the outline crawls.
  function drawSatellite(s, now, state) {
    const area = camera?.area;
    if (!area) return;
    const r = screenRect(area, s);
    const whole = screenRect(WHOLE, s);
    ctx.save();
    ctx.beginPath();
    ctx.rect(whole.x, whole.y, whole.w, whole.h);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "rgba(0,0,0,.4)";
    ctx.fill("evenodd");
    const color = W.TONES[state] || W.TONES.live;
    ctx.setLineDash(state === "live" ? [8, 5] : [3, 4]);
    ctx.lineDashOffset = state === "moving" ? -now / 60 : 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = hexA(color, 0.85);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    // Bottom-right of the box: the map key sits over its top-left corner.
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "right";
    ctx.fillStyle = color;
    ctx.fillText(`${sat.code} · ${satName()} · ${W.STATES[state]}`.toUpperCase(), r.x + r.w - 6, r.y + r.h - 6);
    if (state === "moving") {
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(now / 260);
      ctx.font = "600 12px ui-monospace, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("ACQUIRING PICTURE…", r.x + r.w / 2, r.y + r.h / 2 - 18);
    }
    ctx.restore();
  }

  function drawBases(s, t, home) {
    const size = Math.max(2.5, view.zoom * 3);
    let visible = 0;
    ctx.lineWidth = 1;
    ctx.font = "9px ui-monospace, Consolas, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const base of feed.bases.values()) {
      const { x, y } = F.unpack(base.pos, feed.mapWidth);
      const p = toScreen(x, y, s);
      if (offscreen(p, s, Math.max(10, size))) continue;
      visible++;
      const player = feed.players[base.player];
      const color = colorFor(player, home);
      hits.push({ x: p.x, y: p.y, radius: Math.max(22, size / 2), selection: { kind: "base", uid: player?.uid } });
      // Current wall clock, as in watcher: an old observation cannot renew a shield.
      const remaining = F.shieldRemaining(base.shieldEnd, Date.now());
      const bubbleRadius = Math.max(5, size * 0.75 + 3);
      if (remaining) {
        ctx.save();
        const bubble = ctx.createRadialGradient(p.x - bubbleRadius * 0.3, p.y - bubbleRadius * 0.35, 0, p.x, p.y, bubbleRadius);
        bubble.addColorStop(0, "rgba(205,246,255,.23)");
        bubble.addColorStop(0.65, "rgba(92,191,255,.08)");
        bubble.addColorStop(1, "rgba(124,225,255,.3)");
        ctx.fillStyle = bubble; ctx.strokeStyle = "rgba(124,225,255,.85)"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(p.x,p.y,bubbleRadius,0,Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = "rgba(225,250,255,.85)";
        ctx.beginPath(); ctx.arc(p.x,p.y,bubbleRadius*0.8,Math.PI*1.12,Math.PI*1.6); ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = hexA(color, 0.35);
      ctx.strokeStyle = color;
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
      markHighlight(player, p, remaining ? bubbleRadius + 4 : size * 0.75 + 5);
      if (remaining && view.zoom > 2) {
        ctx.fillStyle = "#b7ecff";
        ctx.fillText(F.duration(remaining), p.x + size / 2 + 3, p.y + 12);
      }
      if (ui.showLabels.checked && player?.abbr && view.zoom > 2.2) {
        ctx.fillStyle = "rgba(232,238,245,.72)";
        ctx.fillText(player.abbr, p.x + size / 2 + 3, p.y);
      }
    }
    return visible;
  }

  function drawMarches(s, t, home) {
    let moving = 0;
    let gathering = 0, waiting = 0;
    for (const march of feed.marches.values()) {
      const activity = F.marchState(march, t, feed.mapWidth);
      if (activity === "expired") continue;
      if (activity === "gathering") gathering++;
      else if (activity === "rally-waiting") waiting++;
      else moving++;
      const at = F.marchPoint(march, t, feed.mapWidth);
      const p = toScreen(at.x, at.y, s);
      if (offscreen(p, s, 60)) continue;
      const target = toScreen(at.tx, at.ty, s);
      const player = feed.players[march.player];
      const color = colorFor(player, home);
      hits.push({ x: p.x, y: p.y, radius: 22, selection: { kind: "march", id: march.id } });
      markHighlight(player, p, 12);
      if (ui.showRoutes.checked && activity === "moving") {
        ctx.strokeStyle = hexA(color, 0.28);
        ctx.lineWidth = 1;
        line(p.x, p.y, target.x, target.y);
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      if (activity === "moving") ctx.rotate(Math.atan2(target.y - p.y, target.x - p.x));
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      if (activity === "rally-waiting") {
        // Upright rally flag; countdown is not a slow-moving arrow.
        ctx.shadowBlur = 0; ctx.strokeStyle = color; ctx.lineWidth = 2;
        line(-3,7,-3,-8); ctx.beginPath(); ctx.moveTo(-3,-8); ctx.lineTo(8,-4); ctx.lineTo(-3,0); ctx.closePath(); ctx.fill();
      } else if (activity === "gathering") {
        // Crossed pickaxe, independent of alliance color.
        ctx.shadowBlur = 0; ctx.strokeStyle = color; ctx.lineWidth = 2.5;
        line(-5,6,4,-5); ctx.beginPath(); ctx.moveTo(-6,-4); ctx.quadraticCurveTo(1,-9,7,1); ctx.stroke();
      } else if (F.isTransport(march)) {
        ctx.fillRect(-7, -4, 10, 8); ctx.fillRect(4, -3, 4, 6);
        ctx.shadowBlur = 0; ctx.fillStyle = "#fff";
        for (const x of [-4, 5]) for (const y of [-5, 5]) { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill(); }
      } else {
        ctx.beginPath(); ctx.moveTo(6.75, 0); ctx.lineTo(-4.5, 4.5); ctx.lineTo(-4.5, -4.5); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    return { moving, gathering, waiting };
  }

  // ---- state + chrome ----------------------------------------------------
  const satName = () => camera?.name || sat.name;

  // shownState is what the pill says: the relay link first, then the camera.
  function shownState() {
    if (!sat.live) return "pad";
    if (connection.state !== "open") return feed.lastDataAt ? "offline" : "connecting";
    if (!feed.hasSnapshot || !camera) return "connecting";
    return camera.state;
  }

  function linkStatus() {
    return live.describeStatus({
      connection, hasSnapshot: feed.hasSnapshot, cameras: camera ? [camera] : [],
      lastDataAt: feed.lastDataAt, lastDataT: feed.lastDataT,
    }, Date.now(), t => W.clock(t));
  }

  function renderHeader(state) {
    $("satEyebrow").textContent = `Watchtower · ${sat.code}`;
    $("satName").textContent = satName();
    $("satWhere").textContent = camera?.area ? `S${camera.area.server} · centre ${W.fmtCentre(camera.area)}` : "";
    const pill = $("satState");
    pill.className = `state-pill is-${state}`;
    pill.textContent = W.STATES[state] || state;
    document.title = `Watchtower — ${satName()}`;
  }

  function freshText(state) {
    switch (state) {
      case "live": return feed.lastDataAt ? `Updated ${W.ago(feed.lastDataAt)}` : "Live";
      case "moving": return camera.movedAt ? `Repositioning since ${W.clock(camera.movedAt)}` : "Repositioning";
      case "stale":
      case "down": return camera?.detail || "";
      case "pad": return "Not implemented";
      default: return linkStatus().detail;
    }
  }

  function renderOverlay(state) {
    const node = $("stageOverlay");
    const show = (tone, title, text, meta = "") => {
      node.className = `stage-overlay is-${tone}`;
      $("overlayTitle").textContent = title;
      $("overlayText").textContent = text;
      $("overlayMeta").textContent = meta;
      node.hidden = false;
    };
    if (state === "pad") {
      show("pad", "Not implemented", `${sat.name} is a planned camera. Its feed and controls are not built yet.`, "Sentinel is the satellite in orbit.");
    } else if (state === "connecting" && !feed.hasSnapshot) {
      show("connecting", `Contacting ${satName()}…`, linkStatus().detail || "Waiting for the relay.");
    } else if (state === "offline") {
      const status = linkStatus();
      show("offline", "Relay offline", status.detail, "The map is frozen until the link is back.");
    } else if (state === "down") {
      show("down", "Disconnected", `${satName()} lost its game session${camera.detail ? ` (${camera.detail})` : ""}. The map shows the last picture received and is not live.`,
        feed.lastDataT ? `Last data at ${W.clock(feed.lastDataT)}` : "");
    } else {
      node.hidden = true;
    }
  }

  function renderSwitch(state) {
    $("satSwitch").replaceChildren(...W.SATELLITES.map(other => {
      const shown = other === sat ? state : other.live ? "live" : "pad";
      const link = document.createElement(other.live ? "a" : "span");
      link.className = `sat-tab is-${shown}`;
      if (other.live) link.href = `live-watch.html?sat=${other.id}`;
      else link.setAttribute("aria-disabled", "true");
      if (other === sat) link.setAttribute("aria-current", "page");
      link.title = W.STATES[shown];
      link.append(document.createElement("i"), `${other.code} ${other.name}${other.live ? "" : " · Not implemented"}`);
      return link;
    }));
  }

  let lastChrome = "";
  function renderChrome() {
    const state = shownState();
    const key = `${state}|${camera?.name}|${camera?.detail}|${JSON.stringify(camera?.area)}`;
    if (key !== lastChrome) {
      lastChrome = key;
      renderHeader(state);
      renderSwitch(state);
    }
    $("satFresh").textContent = freshText(state);
    $("feedNote").textContent = state === "moving" ? "Old picture cleared" : state === "down" || state === "offline" ? "Frozen picture · not live" : "";
    renderOverlay(state);
  }

  function notice(title, text) {
    $("noticeTitle").textContent = title;
    $("noticeText").textContent = text;
    $("orbitNotice").hidden = false;
  }

  const followLine = () => (ui.follow.checked ? "Follow satellite is on, so your view moved with it." : "Follow satellite is off; Reset view jumps to it.");

  // onStatus reacts to the relay's camera status: the first one places the
  // view; a later box change is a move the operator made.
  function onStatus() {
    const next = F.cameraFor(feed, sat.id) || feed.cameras[0] || null;
    const before = camera?.area;
    camera = next;
    const area = camera?.area;
    if (area && area.server !== layoutServer) {
      layoutServer = area.server;
      W.loadLayout(area.server).then(loaded => { if (layoutServer === area.server) layout = loaded; });
    }
    if (area && !fitted) {
      fitted = true;
      Object.assign(view, fitView(area));
      if (camera.movedAt && Date.now() - camera.movedAt < NOTICE_WINDOW_MS) {
        notice(`${satName()} moved ${W.ago(camera.movedAt)}`, `Now over S${area.server} · centre ${W.fmtCentre(area)}, since ${W.clock(camera.movedAt)}.`);
      }
    } else if (area && before && !F.sameArea(before, area)) {
      if (ui.follow.checked) glideTo(fitView(area));
      notice(`${satName()} moved just now`, `Now over S${area.server} · centre ${W.fmtCentre(area)} (was ${W.fmtCentre(before)}). ${followLine()}`);
    }
    renderChrome();
  }

  // ---- loop + input ------------------------------------------------------
  function frame(now) {
    requestAnimationFrame(frame);
    stepGlide(now);
    const s = resizeCanvas();
    clampView();
    const state = shownState();
    const t = F.dataNow(feed, Date.now());
    const home = camera?.area?.server || 0;
    drawGrid(s);
    drawStructures(s);
    drawCapitol(s);
    drawSatellite(s, now, state);
    ctx.globalAlpha = state === "down" || state === "offline" ? 0.4 : 1;
    hits = [];
    const visible = drawBases(s, t, home);
    const moving = drawMarches(s, t, home);
    ctx.globalAlpha = 1;
    if (now - lastStats > 250) {
      lastStats = now;
      $("baseCount").textContent = visible.toLocaleString();
      $("marchCount").textContent = moving.moving.toLocaleString();
      $("activityCount").textContent = `${moving.gathering} gathering · ${moving.waiting} rallies forming`;
      renderDetail();
    }
  }

  let drag = null;
  canvas.addEventListener("pointerdown", event => {
    if (drag || event.isPrimary === false) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    glide = null;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) drag.moved = true;
    if (!drag.moved) return;
    view.x = drag.vx - (event.clientX - drag.x) / view.zoom;
    view.y = drag.vy + (event.clientY - drag.y) / view.zoom;
  });
  const endDrag = event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (event.type === "pointerup" && !drag.moved) {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      let closest = null, distance = Infinity;
      for (const hit of hits) {
        const d = Math.hypot(hit.x - x, hit.y - y);
        if (d <= hit.radius && d < distance) { closest = hit; distance = d; }
      }
      selected = closest?.selection || null; renderDetail();
      if (selected) $("closeDetail").focus({ preventScroll: true });
    }
    drag = null; canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("lostpointercapture", endDrag);
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
  $("resetView").addEventListener("click", () => glideTo(fitView(camera?.area || WHOLE)));
  ui.follow.addEventListener("change", () => { if (ui.follow.checked && camera?.area) glideTo(fitView(camera.area)); });
  $("noticeClose").addEventListener("click", () => { $("orbitNotice").hidden = true; });
  const closeDetail = () => { selected = null; renderDetail(); canvas.focus({ preventScroll: true }); };
  $("closeDetail").addEventListener("click", closeDetail);
  document.addEventListener("keydown", event => { if (event.key === "Escape" && selected) closeDetail(); });
  $("highlightSelected").addEventListener("click", () => toggleHighlight(selectionEntity()?.player));
  $("playerSearch").addEventListener("input", renderSearch);
  $("clearHighlights").addEventListener("click", () => { highlighted.clear(); renderHighlights(); renderSearch(); renderDetail(); });
  $("colorMode").addEventListener("change", () => {
    $("colorLegend").textContent = $("colorMode").value === "domestic" ? "Domestic: alliance colors · Foreign: red" : "Alliance colors";
  });
  $("allianceChoice").addEventListener("change", () => {
    const key = $("allianceChoice").value;
    $("applyColor").disabled = $("resetColor").disabled = !key;
    if (key) $("allianceColor").value = overrides.get(key) || F.allianceColor(key);
  });
  $("applyColor").addEventListener("click", () => {
    const key = $("allianceChoice").value;
    if (key) overrides.set(key, $("allianceColor").value);
    renderAlliances();
  });
  $("resetColor").addEventListener("click", () => { overrides.delete($("allianceChoice").value); renderAlliances(); });
  renderAlliances();

  Object.assign(view, fitView(WHOLE));
  renderChrome();
  requestAnimationFrame(frame);
  if (!sat.live) return;

  const link = live.connect(live.relayUrl(location.href), {
    onMessage: message => {
      // March IDs are snapshot-local. Base selection/highlights use stable UIDs.
      if (message.type === "snap" && selected?.kind === "march") selected = null;
      F.applyMessage(feed, message, Date.now());
      if (message.type === "snap" || message.players.length) { renderAlliances(); renderSearch(); }
      if (message.type === "status") onStatus();
      else if (message.type === "snap") renderChrome();
    },
    onConnection: next => {
      connection = next;
      renderChrome();
    },
  });
  setInterval(renderChrome, 1000);
  // A laptop back from sleep can hold a socket that died silently.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && link.idleFor() > REVIVE_AFTER_MS) link.reconnectNow();
  });
})();
