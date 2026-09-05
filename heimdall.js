(() => {
  "use strict";

  const CATALOG_URL = "data/heimdall/battles.json";
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d", { alpha: false });
  const ui = Object.fromEntries([
    "loadState", "play", "playIcon", "clock", "elapsed", "timeline", "speed",
    "activeMarches", "visibleBases", "confirmedBases", "inferredBases", "eventCount",
    "showBases", "showInferred", "showRoutes", "showLabels", "showCapitol", "serverFilter",
    "resetView", "zoomIn", "zoomOut", "colorMode", "sideControls", "sideAServer", "sideBServer",
    "sideAColor", "sideBColor", "highlightAlliance", "highlightColor",
    "captureProgress", "captureStatus", "captureRowA", "captureRowB",
    "captureServerA", "captureServerB", "captureTrackA", "captureTrackB",
    "captureFillA", "captureFillB", "captureValueA", "captureValueB",
    "inspector", "closeInspector",
    "inspectorKind", "inspectorTitle", "inspectorDetails", "battleTitle",
    "integrityNotice", "integrityTitle", "integrityText", "integrityState",
  ].map(id => [id, document.getElementById(id)]));

  let manifest;
  let battle;
  let battleId = "";
  let dataRoot = "";
  let events = [];
  let currentTime = 0;
  let eventIndex = 0;
  let playing = false;
  let previousFrame = 0;
  let activeMarches = new Map();
  let bases = new Map();
  let renderHits = [];
  let redrawNeeded = true;
  let camera = { x: 500, y: 500, zoom: 1 };
  let pointer = null;
  const activePointers = new Map();
  let pinch = null;
  let highlightAllianceGroups = new Map();

  // Capture-verified Warzone layout. March targets place the sanctuary at
  // X500/Y499 and its four cannons nine tiles diagonally from that center.
  // The outer cross is 100 × 100 with 25 × 25 corner cut-outs.
  const CAPITOL = {
    x: 500,
    y: 499,
    noTeleportSize: 21,
    cannons: [[-9, 9], [9, 9], [-9, -9], [9, -9]],
    boundary: [
      [-25, 50], [25, 50], [25, 25], [50, 25],
      [50, -25], [25, -25], [25, -50], [-25, -50],
      [-25, -25], [-50, -25], [-50, 25], [-25, 25],
    ],
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const unpack = packed => ({ x: packed % manifest.mapWidth, y: Math.floor(packed / manifest.mapWidth) });
  const selectedServer = () => ui.serverFilter.value === "all" ? null : Number(ui.serverFilter.value);
  const allowedServer = server => !battle?.allowedServers?.length || battle.allowedServers.includes(Number(server));
  const integrityGapAt = absolute => (battle?.integrity?.gaps || []).find(gap => absolute >= gap.start && absolute < gap.end);

  function colorFor(value, alpha = 1) {
    const key = String(value || "unknown");
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    const hue = Math.abs(hash) % 360;
    return `hsla(${hue},72%,62%,${alpha})`;
  }

  function hexColor(value, alpha = 1) {
    const hex = String(value || "#5f7285").replace("#", "");
    const number = Number.parseInt(hex.length === 3
      ? hex.split("").map(part => part + part).join("")
      : hex, 16);
    return `rgba(${number >> 16},${(number >> 8) & 255},${number & 255},${alpha})`;
  }

  function allianceKey(alliance, abbr) {
    return alliance || (abbr ? `abbr:${abbr}` : "");
  }

  function entityColor(alliance, abbr, server, alpha = 1) {
    const key = allianceKey(alliance, abbr);
    if (highlightAllianceGroups.get(ui.highlightAlliance.value)?.has(key)) {
      return hexColor(ui.highlightColor.value, alpha);
    }
    if (ui.colorMode.value === "alliance") {
      return colorFor(key || server || "unknown", alpha);
    }
    const sideGroups = battle?.sideGroups || [];
    const sideA = sideGroups[0]?.servers || [Number(ui.sideAServer.value)];
    const sideB = sideGroups[1]?.servers || [Number(ui.sideBServer.value)];
    if (sideA.includes(Number(server))) return hexColor(ui.sideAColor.value, alpha);
    if (sideB.includes(Number(server))) return hexColor(ui.sideBColor.value, alpha);
    return hexColor("#657486", alpha * .62);
  }

  function playerFor(index) {
    return manifest.players[index] || ["", "Unknown", "", 0, ""];
  }

  function baseMeta(index) {
    return manifest.baseActors[index] || ["", "", 0, "", -1];
  }

  function baseOperationName(operation) {
    return ["Create", "Change", "Relocate"][operation] || "Observed";
  }

  function marchActionName(targetKind) {
    return ({
      1: "Base attack", 6: "Base attack", 11: "Base attack", 12: "Base rally",
      111: "Rubble clear", 178: "Structure attack", 179: "Structure reinforce",
      180: "Structure scout", 181: "Structure rally attack", 194: "Special objective attack",
    })[targetKind] || `Target kind ${targetKind}`;
  }

  function baseAnchorsOverlap(left, right) {
    const a = unpack(left);
    const b = unpack(right);
    return Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2;
  }

  function placeBase(base) {
    for (const [key, existing] of bases) {
      if (key === base.actor || !baseAnchorsOverlap(existing.position, base.position)) continue;
      if (!base.observed && existing.observed) return;
      bases.delete(key);
    }
    bases.set(base.actor, base);
  }

  function marchPosition(march, time) {
    const duration = Math.max(1, march.end - march.start);
    const progress = clamp((time - march.start) / duration, 0, 1);
    return {
      x: march.sx + (march.tx - march.sx) * progress,
      y: march.sy + (march.ty - march.sy) * progress,
    };
  }

  function applyEvent(event) {
    const type = event[0];
    const time = event[1];
    if (type === 0) {
      const id = event[2];
      const source = unpack(event[5]);
      const target = unpack(event[6]);
      const previous = activeMarches.get(id);
      const origin = previous ? marchPosition(previous, time) : source;
      activeMarches.set(id, {
        id,
        player: event[3],
        type: event[4],
        sx: origin.x,
        sy: origin.y,
        tx: target.x,
        ty: target.y,
        start: previous ? time : event[7],
        end: Math.max(time + 250, event[8]),
        targetKind: event[9],
        team: event[10],
        speed: Number(event[11]) > 0 ? Number(event[11]) : previous?.speed || null,
      });
    } else if (type === 1) {
      activeMarches.delete(event[2]);
    } else if (type === 2) {
      const operation = event[2];
      const actor = event[3];
      const position = event[4];
      if (operation <= 2 && actor >= 0) {
        placeBase({
          actor,
          position,
          instance: event[5],
          observed: true,
          confidence: 100,
          operation,
          updatedAt: time,
        });
      } else if (operation === 3) {
        for (const [key, base] of bases) {
          if (base.position === position) bases.delete(key);
        }
      }
      // operation 4 is generic map-object removal. It intentionally cannot
      // mutate player bases because the removed object may be a mine, farm,
      // rubble, ashes, or another non-player entity.
    } else if (type === 3) {
      const actor = event[3];
      const existing = bases.get(actor);
      if (!existing || !existing.observed) {
        placeBase({
          actor,
          position: event[4],
          instance: -1,
          observed: false,
          confidence: event[5],
          operation: -1,
          updatedAt: time,
          confirmedAt: event[6],
        });
      }
    }
  }

  function capturePoint(server, sample) {
    if (!sample) return 0;
    if (sample[1] === server) return sample[2];
    if (sample[4] === server) return sample[5];
    return 0;
  }

  function capturePointAt(server, time) {
    const samples = manifest.captureProgress?.samples || [];
    if (!samples.length || time < samples[0][0]) return 0;
    let low = 0;
    let high = samples.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (samples[middle][0] <= time) low = middle + 1;
      else high = middle;
    }
    const previous = samples[Math.max(0, low - 1)];
    const next = samples[low];
    const from = capturePoint(server, previous);
    if (!next || next[0] <= previous[0]) return from;
    const to = capturePoint(server, next);
    const ratio = clamp((time - previous[0]) / (next[0] - previous[0]), 0, 1);
    return from + (to - from) * ratio;
  }

  function captureColor(server) {
    if (String(server) === ui.sideAServer.value) return ui.sideAColor.value;
    if (String(server) === ui.sideBServer.value) return ui.sideBColor.value;
    return colorFor(server);
  }

  function updateCaptureReadout() {
    const data = manifest.captureProgress;
    const servers = battle?.servers || [];
    if (!data?.samples?.length || servers.length < 2) {
      ui.captureProgress.hidden = true;
      return;
    }
    ui.captureProgress.hidden = false;
    let complete = false;
    let active = false;
    [["A", servers[0]], ["B", servers[1]]].forEach(([suffix, server]) => {
      const point = capturePointAt(server, currentTime);
      const percent = clamp(point / data.target * 100, 0, 100);
      const rounded = Math.round(percent);
      const row = ui[`captureRow${suffix}`];
      const label = ui[`captureServer${suffix}`];
      const track = ui[`captureTrack${suffix}`];
      label.textContent = `S${server}`;
      row.style.setProperty("--capture-color", captureColor(server));
      ui[`captureFill${suffix}`].style.width = `${percent}%`;
      ui[`captureValue${suffix}`].textContent = `${rounded}%`;
      track.setAttribute("aria-label", `Server ${server} capture progress`);
      track.setAttribute("aria-valuenow", String(rounded));
      complete ||= percent >= 100;
      active ||= point > 0;
    });
    ui.captureStatus.textContent = complete ? "Capture complete" : active ? "Building control" : "Awaiting occupation";
  }

  function rebuildState(time) {
    activeMarches = new Map();
    bases = new Map();
    eventIndex = 0;
    while (eventIndex < events.length && events[eventIndex][1] <= time) {
      applyEvent(events[eventIndex++]);
    }
  }

  function setTime(time, forceRebuild = false) {
    const next = clamp(time, 0, manifest.duration);
    if (forceRebuild || next < currentTime) {
      rebuildState(next);
    } else {
      while (eventIndex < events.length && events[eventIndex][1] <= next) {
        applyEvent(events[eventIndex++]);
      }
    }
    currentTime = next;
    ui.timeline.value = String(Math.round(next));
    updateReadout();
    redrawNeeded = true;
  }

  function updateReadout() {
    const absolute = new Date(manifest.start + currentTime);
    ui.clock.textContent = absolute.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const seconds = Math.floor(currentTime / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    ui.elapsed.textContent = `+${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    ui.activeMarches.textContent = activeMarches.size.toLocaleString();
    let observed = 0;
    let inferred = 0;
    for (const base of bases.values()) {
      if (!allowedServer(baseMeta(base.actor)[2])) continue;
      base.observed ? observed++ : inferred++;
    }
    ui.visibleBases.textContent = (observed + inferred).toLocaleString();
    ui.confirmedBases.textContent = observed.toLocaleString();
    ui.inferredBases.textContent = inferred.toLocaleString();
    ui.eventCount.textContent = eventIndex.toLocaleString();
    updateIntegrityReadout();
    updateCaptureReadout();
  }

  function updateIntegrityReadout() {
    const integrity = battle?.integrity;
    if (!integrity) {
      ui.integrityNotice.hidden = true;
      return;
    }
    ui.integrityNotice.hidden = false;
    ui.integrityTitle.textContent = integrity.title || "Incomplete observation window";
    ui.integrityText.textContent = integrity.message || "Some event data is unavailable.";
    const absolute = manifest.start + currentTime;
    const inGap = (integrity.gaps || []).some(gap => absolute >= gap.start && absolute < gap.end);
    ui.integrityNotice.classList.toggle("is-gap", inGap);
    ui.integrityState.textContent = inGap ? "No map coverage" : "Observed window";
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      redrawNeeded = true;
    }
  }

  function screenSize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    return { width: canvas.width / ratio, height: canvas.height / ratio, ratio };
  }

  function toScreen(x, y, width, height) {
    return { x: (x - camera.x) * camera.zoom + width / 2, y: (camera.y - y) * camera.zoom + height / 2 };
  }

  function toWorld(x, y, width, height) {
    return { x: (x - width / 2) / camera.zoom + camera.x, y: camera.y - (y - height / 2) / camera.zoom };
  }

  function resetView() {
    const { width, height } = screenSize();
    const capitolViewSpan = battle?.layout === "none" ? 1060 : 180;
    camera = {
      x: CAPITOL.x,
      y: CAPITOL.y,
      zoom: clamp(Math.min(width, height) / capitolViewSpan, .75, 8),
    };
    redrawNeeded = true;
  }

  function zoomAt(x, y, nextZoom) {
    const { width, height } = screenSize();
    const before = toWorld(x, y, width, height);
    camera.zoom = clamp(nextZoom, .25, 20);
    const after = toWorld(x, y, width, height);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    redrawNeeded = true;
  }

  function zoomFromCenter(factor) {
    const { width, height } = screenSize();
    zoomAt(width / 2, height / 2, camera.zoom * factor);
  }

  function drawGrid(width, height) {
    ctx.fillStyle = "#080b10";
    ctx.fillRect(0, 0, width, height);
    const worldLeft = camera.x - width / camera.zoom / 2;
    const worldRight = camera.x + width / camera.zoom / 2;
    const worldMinY = camera.y - height / camera.zoom / 2;
    const worldMaxY = camera.y + height / camera.zoom / 2;
    const step = camera.zoom > 5 ? 10 : camera.zoom > 1.6 ? 25 : camera.zoom > .7 ? 50 : 100;
    ctx.lineWidth = 1;
    for (let x = Math.floor(worldLeft / step) * step; x <= worldRight; x += step) {
      const sx = toScreen(x, 0, width, height).x;
      ctx.strokeStyle = x % 100 === 0 ? "rgba(95,114,133,.22)" : "rgba(95,114,133,.09)";
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, height); ctx.stroke();
    }
    for (let y = Math.floor(worldMinY / step) * step; y <= worldMaxY; y += step) {
      const sy = toScreen(0, y, width, height).y;
      ctx.strokeStyle = y % 100 === 0 ? "rgba(95,114,133,.22)" : "rgba(95,114,133,.09)";
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(width, sy); ctx.stroke();
    }
    const cornerA = toScreen(0, 0, width, height);
    const cornerB = toScreen(1000, 1000, width, height);
    ctx.strokeStyle = "rgba(157,176,194,.42)";
    ctx.strokeRect(
      Math.min(cornerA.x, cornerB.x),
      Math.min(cornerA.y, cornerB.y),
      Math.abs(cornerB.x - cornerA.x),
      Math.abs(cornerB.y - cornerA.y),
    );
  }

  function mapPath(points, width, height) {
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      const point = toScreen(x, y, width, height);
      if (index) ctx.lineTo(point.x, point.y);
      else ctx.moveTo(point.x, point.y);
    });
    ctx.closePath();
  }

  function mapLabel(text, x, y, width, height, color = "rgba(176,225,238,.82)") {
    const point = toScreen(x, y, width, height);
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, point.x, point.y);
  }

  function drawCapitol(width, height) {
    if (!ui.showCapitol.checked) return;

    const boundary = CAPITOL.boundary.map(([x, y]) => [CAPITOL.x + x, CAPITOL.y + y]);
    mapPath(boundary, width, height);
    ctx.fillStyle = "rgba(83,205,235,.045)";
    ctx.fill();
    ctx.strokeStyle = "rgba(124,225,255,.76)";
    ctx.lineWidth = 1.35;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const half = CAPITOL.noTeleportSize / 2;
    const northWest = toScreen(CAPITOL.x - half, CAPITOL.y + half, width, height);
    const southEast = toScreen(CAPITOL.x + half, CAPITOL.y - half, width, height);
    const blockedX = Math.min(northWest.x, southEast.x);
    const blockedY = Math.min(northWest.y, southEast.y);
    const blockedWidth = Math.abs(southEast.x - northWest.x);
    const blockedHeight = Math.abs(southEast.y - northWest.y);
    ctx.fillStyle = "rgba(255,69,91,.13)";
    ctx.fillRect(blockedX, blockedY, blockedWidth, blockedHeight);
    ctx.strokeStyle = "rgba(255,97,116,.88)";
    ctx.lineWidth = 1.25;
    ctx.strokeRect(blockedX, blockedY, blockedWidth, blockedHeight);

    if (camera.zoom >= 3.5) {
      ctx.strokeStyle = "rgba(255,97,116,.16)";
      ctx.lineWidth = 1;
      for (let offset = 1; offset < CAPITOL.noTeleportSize; offset++) {
        const x = blockedX + offset * camera.zoom;
        const y = blockedY + offset * camera.zoom;
        ctx.beginPath(); ctx.moveTo(x, blockedY); ctx.lineTo(x, blockedY + blockedHeight); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(blockedX, y); ctx.lineTo(blockedX + blockedWidth, y); ctx.stroke();
      }
    }

    const center = toScreen(CAPITOL.x, CAPITOL.y, width, height);
    const markerSize = clamp(camera.zoom * 3.2, 4, 14);
    ctx.fillStyle = "rgba(255,209,102,.2)";
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y - markerSize);
    ctx.lineTo(center.x + markerSize, center.y);
    ctx.lineTo(center.x, center.y + markerSize);
    ctx.lineTo(center.x - markerSize, center.y);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    for (const [dx, dy] of CAPITOL.cannons) {
      const cannon = toScreen(CAPITOL.x + dx, CAPITOL.y + dy, width, height);
      const radius = clamp(camera.zoom * 1.35, 2, 6);
      ctx.fillStyle = "rgba(255,209,102,.22)";
      ctx.strokeStyle = "rgba(255,209,102,.9)";
      ctx.beginPath(); ctx.arc(cannon.x, cannon.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    if (camera.zoom >= 1.35) {
      mapLabel("CAPITOL AREA · 100×100 CROSS", CAPITOL.x, CAPITOL.y + 39, width, height);
    }
    if (camera.zoom >= 2.5) {
      mapLabel("50", CAPITOL.x, CAPITOL.y + 53, width, height);
      mapLabel("25", CAPITOL.x + 28, CAPITOL.y + 37.5, width, height);
      mapLabel("25", CAPITOL.x + 37.5, CAPITOL.y + 28, width, height);
      mapLabel("50", CAPITOL.x + 54, CAPITOL.y, width, height);
      mapLabel("25", CAPITOL.x + 37.5, CAPITOL.y - 28, width, height);
      mapLabel("25", CAPITOL.x + 28, CAPITOL.y - 37.5, width, height);
      mapLabel(`SANCTUARY · ${CAPITOL.x}, ${CAPITOL.y}`, CAPITOL.x, CAPITOL.y, width, height, "#ffd166");
    }
  }

  function inView(point, width, height, margin = 25) {
    return point.x >= -margin && point.x <= width + margin && point.y >= -margin && point.y <= height + margin;
  }

  function drawBase(base, width, height, server) {
    if (!base.observed && !ui.showInferred.checked) return;
    const meta = baseMeta(base.actor);
    if (!allowedServer(meta[2])) return;
    if (server !== null && meta[2] !== server) return;
    const world = unpack(base.position);
    const point = toScreen(world.x, world.y, width, height);
    if (!inView(point, width, height)) return;
    const color = entityColor(meta[3], meta[1], meta[2]);
    const size = Math.max(4, camera.zoom * 3);
    ctx.fillStyle = entityColor(meta[3], meta[1], meta[2], base.observed ? .2 : .05);
    ctx.strokeStyle = color;
    ctx.lineWidth = base.observed ? 1 : 1.25;
    ctx.setLineDash(base.observed ? [] : [3, 2]);
    ctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    ctx.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
    ctx.setLineDash([]);
    if (ui.showLabels.checked && meta[1] && camera.zoom > 1.4) {
      ctx.fillStyle = "rgba(232,238,245,.72)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(meta[1], point.x + size / 2 + 3, point.y + 3);
    }
    renderHits.push({ kind: "base", x: point.x, y: point.y, data: base });
  }

  function drawArrow(from, to, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = 5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - Math.cos(angle - .45) * size, to.y - Math.sin(angle - .45) * size);
    ctx.lineTo(to.x - Math.cos(angle + .45) * size, to.y - Math.sin(angle + .45) * size);
    ctx.closePath(); ctx.fill();
  }

  function drawMarch(march, width, height, server) {
    const player = playerFor(march.player);
    if (!allowedServer(player[3])) return;
    if (server !== null && player[3] !== server) return;
    const world = marchPosition(march, currentTime);
    const point = toScreen(world.x, world.y, width, height);
    if (!inView(point, width, height, 60)) return;
    const target = toScreen(march.tx, march.ty, width, height);
    const color = entityColor(player[4], player[2], player[3]);
    if (ui.showRoutes.checked) drawArrow(point, target, entityColor(player[4], player[2], player[3], .28));
    const angle = Math.atan2(target.y - point.y, target.x - point.x);
    const radius = 4.5;
    ctx.save();
    ctx.translate(point.x, point.y); ctx.rotate(angle);
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(radius * 1.5, 0); ctx.lineTo(-radius, radius); ctx.lineTo(-radius, -radius); ctx.closePath(); ctx.fill();
    ctx.restore();
    if (ui.showLabels.checked && player[2] && camera.zoom > 1.4) {
      ctx.fillStyle = "rgba(232,238,245,.8)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(player[2], point.x + 7, point.y - 6);
    }
    renderHits.push({ kind: "march", x: point.x, y: point.y, data: march });
  }

  function render() {
    resizeCanvas();
    const { width, height, ratio } = screenSize();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawGrid(width, height);
    const gap = manifest ? integrityGapAt(manifest.start + currentTime) : null;
    if (gap) {
      ctx.save();
      ctx.fillStyle = "rgba(20,5,8,.82)";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "rgba(255,93,93,.12)";
      ctx.lineWidth = 1;
      for (let x = -height; x < width + height; x += 24) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + height, height); ctx.stroke();
      }
      ctx.textAlign = "center";
      ctx.fillStyle = "#ff9292";
      ctx.font = "700 18px ui-monospace, monospace";
      ctx.fillText("NO EVENT-MAP COVERAGE", width / 2, height / 2 - 8);
      ctx.fillStyle = "rgba(236,210,214,.72)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText("19:00:00–19:14:07 · events in this interval were not observed", width / 2, height / 2 + 18);
      ctx.restore();
      renderHits = [];
      redrawNeeded = false;
      return;
    }
    drawCapitol(width, height);
    renderHits = [];
    const server = selectedServer();
    if (ui.showBases.checked) for (const base of bases.values()) drawBase(base, width, height, server);
    for (const march of activeMarches.values()) drawMarch(march, width, height, server);
    redrawNeeded = false;
  }

  function frame(now) {
    if (playing && manifest) {
      const delta = previousFrame ? now - previousFrame : 0;
      const next = currentTime + delta * Number(ui.speed.value);
      if (next >= manifest.duration) {
        setTime(manifest.duration);
        setPlaying(false);
      } else {
        setTime(next);
      }
    }
    previousFrame = now;
    if (redrawNeeded || playing) render();
    requestAnimationFrame(frame);
  }

  function setPlaying(value) {
    playing = value;
    ui.playIcon.textContent = playing ? "❚❚" : "▶";
    ui.play.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
  }

  function detailRows(rows) {
    ui.inspectorDetails.replaceChildren();
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value || "—";
      ui.inspectorDetails.append(dt, dd);
    }
  }

  function formatMarchSpeed(speed) {
    return Number.isFinite(speed) && speed > 0
      ? `${Number(speed.toFixed(4))} tiles/s`
      : "";
  }

  function inspect(hit) {
    if (hit.kind === "march") {
      const march = hit.data;
      const player = playerFor(march.player);
      ui.inspectorKind.textContent = "Active march";
      ui.inspectorTitle.textContent = player[1] || "Unknown player";
      const rows = [
        ["Alliance", player[2]],
        ["Server", String(player[3] || "")],
        ["Action", marchActionName(march.targetKind)],
        ["March type", String(march.type)],
        ["From", `${Math.round(march.sx)}, ${Math.round(march.sy)}`],
        ["Target", `${march.tx}, ${march.ty}`],
        ["Arrives", new Date(manifest.start + march.end).toLocaleTimeString()],
      ];
      const speed = formatMarchSpeed(march.speed);
      if (speed) rows.splice(3, 0, ["Speed", speed]);
      detailRows(rows);
    } else {
      const base = hit.data;
      const meta = baseMeta(base.actor);
      const player = meta[4] >= 0 ? playerFor(meta[4]) : null;
      const world = unpack(base.position);
      ui.inspectorKind.textContent = base.observed ? "Observed player base" : "Inferred player base";
      ui.inspectorTitle.textContent = meta[0] || player?.[1] || "Unknown player";
      detailRows([
        ["Alliance", meta[1]],
        ["Server", String(meta[2] || "")],
        ["Coordinates", `${world.x}, ${world.y}`],
        ["Footprint", "3 × 3 tiles"],
        ["Evidence", base.observed ? baseOperationName(base.operation) : "March + later point confirmation"],
        ["Confidence", `${base.confidence}%`],
        ["Map point ID", base.instance >= 0 ? manifest.baseIds[base.instance] : ""],
      ]);
    }
    ui.inspector.hidden = false;
  }

  async function loadReplay() {
    try {
      const catalogResponse = await fetch(CATALOG_URL);
      if (!catalogResponse.ok) throw new Error(`battle archive HTTP ${catalogResponse.status}`);
      const catalog = await catalogResponse.json();
      const queryBattle = new URLSearchParams(location.search).get("battle");
      const pageBattle = decodeURIComponent(location.pathname.split("/").pop() || "")
        .replace(/\.html$/i, "");
      const requestedBattle = queryBattle || (
        catalog.battles.some(item => item.id === pageBattle) ? pageBattle : ""
      );
      battleId = requestedBattle || catalog.defaultBattle;
      battle = catalog.battles.find(item => item.id === battleId);
      if (!battle) throw new Error(`unknown battle ${battleId}`);
      if (!/^[a-z0-9-]+$/.test(battle.id)) throw new Error("invalid battle identifier");
      dataRoot = `data/heimdall/${battle.id}/`;
      ui.battleTitle.textContent = battle.title;
      document.title = `${battle.title} — Heimdall`;

      const manifestResponse = await fetch(`${dataRoot}manifest.json`);
      if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`);
      manifest = await manifestResponse.json();
      if (battle.layout === "none") {
        ui.showCapitol.checked = false;
        ui.showCapitol.closest("label").hidden = true;
        document.querySelector(".key-capitol")?.closest("span")?.remove();
        document.querySelector(".key-blocked")?.closest("span")?.remove();
      }
      ui.timeline.max = String(manifest.duration);
      for (let i = 0; i < manifest.chunks.length; i++) {
        const chunk = manifest.chunks[i];
        ui.loadState.textContent = `Loading replay ${i + 1}/${manifest.chunks.length}…`;
        const response = await fetch(dataRoot + chunk.file);
        if (!response.ok) throw new Error(`${chunk.file} HTTP ${response.status}`);
        const payload = await response.json();
        events.push(...payload.e);
      }
      events.sort((a, b) => a[1] - b[1]);
      populateServers();
      ui.loadState.textContent = `${events.length.toLocaleString()} events · ${formatDuration(manifest.duration)}`;
      ui.loadState.className = "load-state ready";
      ui.play.disabled = false;
      ui.timeline.disabled = false;
      resetView();
      const initialTime = battle.initialTime ? clamp(battle.initialTime - manifest.start, 0, manifest.duration) : 0;
      setTime(initialTime, true);
    } catch (error) {
      console.error(error);
      ui.loadState.textContent = location.protocol === "file:"
        ? "Serve this folder over HTTP to load replay data"
        : `Replay unavailable: ${error.message}`;
      ui.loadState.className = "load-state error";
    }
  }

  function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  function populateServers() {
    const serverCounts = new Map();
    const alliances = new Map();
    const remember = (abbr, server, alliance) => {
      if (!allowedServer(server)) return;
      if (server) serverCounts.set(server, (serverCounts.get(server) || 0) + 1);
      const key = allianceKey(alliance, abbr);
      if (!key) return;
      if (!alliances.has(key)) alliances.set(key, { abbr: abbr || `${alliance.slice(0, 8)}…`, servers: new Set() });
      if (server) alliances.get(key).servers.add(server);
    };
    for (const player of manifest.players) remember(player[2], player[3], player[4]);
    for (const base of manifest.baseActors) remember(base[1], base[2], base[3]);
    const servers = [...serverCounts].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
    for (const [server] of servers) {
      const option = document.createElement("option");
      option.value = String(server);
      option.textContent = `Server ${server}`;
      ui.serverFilter.append(option);
      ui.sideAServer.append(option.cloneNode(true));
      ui.sideBServer.append(option.cloneNode(true));
    }
    const preferredServers = battle?.servers || [];
    if (preferredServers[0] && [...ui.sideAServer.options].some(option => option.value === String(preferredServers[0]))) {
      ui.sideAServer.value = String(preferredServers[0]);
    } else if (servers[0]) {
      ui.sideAServer.value = String(servers[0][0]);
    }
    if (preferredServers[1] && [...ui.sideBServer.options].some(option => option.value === String(preferredServers[1]))) {
      ui.sideBServer.value = String(preferredServers[1]);
    } else if (servers[1]) {
      ui.sideBServer.value = String(servers[1][0]);
    }
    const abbrCounts = new Map();
    for (const value of alliances.values()) abbrCounts.set(value.abbr, (abbrCounts.get(value.abbr) || 0) + 1);
    const allianceGroups = new Map();
    for (const [key, value] of alliances) {
      const suffix = abbrCounts.get(value.abbr) > 1 && value.servers.size
        ? ` · S${[...value.servers].sort((a, b) => a - b).join("/")}`
        : "";
      const label = value.abbr + suffix;
      if (!allianceGroups.has(label)) allianceGroups.set(label, new Set());
      allianceGroups.get(label).add(key);
    }
    highlightAllianceGroups = new Map();
    const allianceOptions = [...allianceGroups]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, keys], index) => [`highlight:${index}`, label, keys]);
    for (const [group, label, keys] of allianceOptions) {
      const option = document.createElement("option");
      option.value = group;
      option.textContent = label;
      ui.highlightAlliance.append(option);
      highlightAllianceGroups.set(group, keys);
    }
    restorePalette();
  }

  function restorePalette() {
    try {
      const saved = JSON.parse(localStorage.getItem(`heimdall-palette:${battleId}`) || "null");
      if (saved?.mode) ui.colorMode.value = saved.mode;
      if (saved?.sideA && [...ui.sideAServer.options].some(option => option.value === saved.sideA)) ui.sideAServer.value = saved.sideA;
      if (saved?.sideB && [...ui.sideBServer.options].some(option => option.value === saved.sideB)) ui.sideBServer.value = saved.sideB;
      if (saved?.sideAColor) ui.sideAColor.value = saved.sideAColor;
      if (saved?.sideBColor) ui.sideBColor.value = saved.sideBColor;
      if (saved?.alliance && [...ui.highlightAlliance.options].some(option => option.value === saved.alliance)) ui.highlightAlliance.value = saved.alliance;
      if (saved?.highlightColor) ui.highlightColor.value = saved.highlightColor;
    } catch (error) {
      console.warn("Could not restore palette", error);
    }
    updatePaletteControls();
  }

  function savePalette() {
    try {
      localStorage.setItem(`heimdall-palette:${battleId}`, JSON.stringify({
        mode: ui.colorMode.value,
        sideA: ui.sideAServer.value,
        sideB: ui.sideBServer.value,
        sideAColor: ui.sideAColor.value,
        sideBColor: ui.sideBColor.value,
        alliance: ui.highlightAlliance.value,
        highlightColor: ui.highlightColor.value,
      }));
    } catch (error) {
      console.warn("Could not save palette", error);
    }
  }

  function updatePaletteControls() {
    ui.sideControls.hidden = ui.colorMode.value !== "server";
    if (manifest) updateCaptureReadout();
    redrawNeeded = true;
  }

  ui.play.addEventListener("click", () => {
    if (currentTime >= manifest.duration) setTime(0, true);
    setPlaying(!playing);
  });
  ui.timeline.addEventListener("input", () => {
    setPlaying(false);
    setTime(Number(ui.timeline.value));
  });
  ui.closeInspector.addEventListener("click", () => { ui.inspector.hidden = true; });
  ui.resetView.addEventListener("click", resetView);
  ui.zoomIn.addEventListener("click", () => zoomFromCenter(1.45));
  ui.zoomOut.addEventListener("click", () => zoomFromCenter(1 / 1.45));
  for (const control of [ui.showBases, ui.showInferred, ui.showRoutes, ui.showLabels, ui.showCapitol, ui.serverFilter]) {
    control.addEventListener("change", () => { redrawNeeded = true; });
  }
  for (const control of [ui.colorMode, ui.sideAServer, ui.sideBServer, ui.sideAColor, ui.sideBColor, ui.highlightAlliance, ui.highlightColor]) {
    control.addEventListener("change", () => {
      updatePaletteControls();
      savePalette();
    });
    control.addEventListener("input", () => { redrawNeeded = true; });
  }

  function beginPinch() {
    const [first, second] = [...activePointers.values()];
    if (!first || !second) return;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = screenSize();
    const x = (first.x + second.x) / 2 - rect.left;
    const y = (first.y + second.y) / 2 - rect.top;
    pinch = {
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      zoom: camera.zoom,
      world: toWorld(x, y, width, height),
    };
    if (pointer) pointer.moved = true;
  }

  canvas.addEventListener("pointerdown", event => {
    if (activePointers.size >= 2) return;
    canvas.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY });
    if (activePointers.size === 1) {
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    } else if (activePointers.size === 2) {
      beginPinch();
    }
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", event => {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY });

    if (pinch && activePointers.size >= 2) {
      const [first, second] = [...activePointers.values()];
      const rect = canvas.getBoundingClientRect();
      const { width, height } = screenSize();
      const x = (first.x + second.x) / 2 - rect.left;
      const y = (first.y + second.y) / 2 - rect.top;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      camera.zoom = clamp(pinch.zoom * distance / pinch.distance, .25, 20);
      const after = toWorld(x, y, width, height);
      camera.x += pinch.world.x - after.x;
      camera.y += pinch.world.y - after.y;
      redrawNeeded = true;
      return;
    }

    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) pointer.moved = true;
    camera.x -= dx / camera.zoom;
    camera.y += dy / camera.zoom;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    redrawNeeded = true;
  });

  function finishPointer(event, inspectTap) {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    if (pinch) {
      pinch = null;
      const remaining = activePointers.values().next().value;
      pointer = remaining ? { ...remaining, moved: true } : null;
      if (!remaining) canvas.classList.remove("dragging");
      return;
    }

    if (!pointer || pointer.id !== event.pointerId) {
      if (!activePointers.size) canvas.classList.remove("dragging");
      return;
    }
    if (inspectTap && !pointer.moved) {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let best = null;
      let distance = 13;
      for (const hit of renderHits) {
        const d = Math.hypot(hit.x - x, hit.y - y);
        if (d < distance) { best = hit; distance = d; }
      }
      if (best) inspect(best);
      else ui.inspector.hidden = true;
    }
    const remaining = activePointers.values().next().value;
    pointer = remaining ? { ...remaining, moved: true } : null;
    if (!remaining) canvas.classList.remove("dragging");
  }

  canvas.addEventListener("pointerup", event => finishPointer(event, true));
  canvas.addEventListener("pointercancel", event => finishPointer(event, false));
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    zoomAt(x, y, camera.zoom * Math.exp(-event.deltaY * .001));
  }, { passive: false });

  document.addEventListener("keydown", event => {
    if (!manifest || ["INPUT", "SELECT", "BUTTON"].includes(document.activeElement.tagName)) return;
    if (event.code === "Space") {
      event.preventDefault();
      setPlaying(!playing);
    } else if (event.code === "ArrowRight") {
      setPlaying(false); setTime(currentTime + 5000);
    } else if (event.code === "ArrowLeft") {
      setPlaying(false); setTime(currentTime - 5000);
    }
  });

  window.addEventListener("resize", () => { redrawNeeded = true; });
  requestAnimationFrame(frame);
  loadReplay();
})();
