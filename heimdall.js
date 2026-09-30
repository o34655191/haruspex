(() => {
  "use strict";

  const CATALOG_URL = "data/heimdall/battles.json";
  // heimdall.html?live streams the lwlive relay (heimdall-live.js) instead of
  // loading a recorded battle.
  const LIVE_REQUESTED = new URLSearchParams(location.search).has("live");
  const LIVE_READOUT_MS = 250;
  const LIVE_ROSTER_MS = 3000;
  const LIVE_TRAIL_LIMIT = 20;
  const LIVE_FIT_MARGIN = 30;
  // Reconnect when the feed has been silent this long (a dead link never
  // fires close), or sooner once frames resume after a sleep or a hidden tab.
  const LIVE_IDLE_MS = 5 * 60 * 1000;
  const LIVE_WAKE_GAP_MS = 10000;
  const LIVE_WAKE_IDLE_MS = 30000;
  // How long an interaction with a <select> holds off roster rebuilds, which
  // would close an open dropdown.
  const LIVE_SELECT_BUSY_MS = 8000;
  const CURATED_PLAYERS = ["extradamage", "aloha1234"];
  const MAX_ZOOM = 20;
  // How far past the warzone's edge the view may pan or zoom out, as a share
  // of the warzone's width.
  const VIEW_MARGIN = .12;
  const CAMERA_STATE_COLORS = { live: "#8de0b5", connecting: "#ffd166", stale: "#ffd166", down: "#ff5d5d" };
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
  let selectedPlayer = -1;
  const featuredPlayers = new Set();
  const playerActions = new Map();
  const playerObservations = new Map();
  let focusUI;
  let refreshPlayerList = () => {};
  let live = null;

  const isCurated = name => CURATED_PLAYERS.includes(String(name).trim().toLowerCase());

  function setupPlayerControls() {
    const panel = document.createElement("section");
    panel.className = "palette-panel player-panel";
    panel.setAttribute("aria-label", "Player spotlight");
    panel.innerHTML = `<label for="playerSearch">Find player</label><input id="playerSearch" type="search" placeholder="Name, alliance or server"><label for="playerSelect">Player</label><select id="playerSelect"><option value="-1">None</option></select><label><input id="followPlayer" type="checkbox"> Follow base</label><label><input id="featuredVisible" type="checkbox" checked> Featured markers</label><button id="featurePlayer" type="button">Star / unstar player</button><button id="firstAction" type="button">First observation</button><button id="nextAction" type="button">Next action</button><span id="playerStatus" role="status">Select a player to spotlight their base and marches.</span>`;
    document.querySelector(".palette-panel").after(panel);
    focusUI = Object.fromEntries([...panel.querySelectorAll("[id]")].map(el => [el.id, el]));
    const populate = () => {
      const query = focusUI.playerSearch.value.toLocaleLowerCase();
      focusUI.playerSelect.replaceChildren(new Option("None", "-1"));
      manifest.players.forEach((p, index) => {
        const label = `${p[1]} · ${p[2] || "No alliance"} · S${p[3]}`;
        if (allowedServer(p[3]) && (index === selectedPlayer || label.toLocaleLowerCase().includes(query))) {
          focusUI.playerSelect.add(new Option(label, String(index)));
        }
      });
      focusUI.playerSelect.value = String(selectedPlayer);
    };
    refreshPlayerList = populate;
    manifest.players.forEach((p, index) => {
      if (isCurated(p[1])) featuredPlayers.add(index);
    });
    if (live) {
      // Live mode has no history to jump through.
      focusUI.firstAction.hidden = true;
      focusUI.nextAction.hidden = true;
    }
    for (const event of events) {
      const index = event[0] === 0 ? event[3] : event[0] === 2 && event[2] <= 2 ? baseMeta(event[3])[4] : -1;
      if (index >= 0) {
        if (!playerActions.has(index)) playerActions.set(index, []);
        playerActions.get(index).push(event[1]);
        if (event[0] === 2) {
          if (!playerObservations.has(index)) playerObservations.set(index, []);
          playerObservations.get(index).push({time: event[1], position: event[4]});
        }
      }
    }
    populate();
    focusUI.playerSearch.addEventListener("input", populate);
    focusUI.playerSelect.addEventListener("change", () => {
      selectedPlayer = Number(focusUI.playerSelect.value);
      ui.serverFilter.value = "all";
      redrawNeeded = true;
    });
    for (const id of ["followPlayer", "featuredVisible"]) focusUI[id].addEventListener("change", () => { redrawNeeded = true; });
    focusUI.featurePlayer.addEventListener("click", () => {
      if (selectedPlayer < 0) return;
      if (featuredPlayers.has(selectedPlayer)) featuredPlayers.delete(selectedPlayer);
      else featuredPlayers.add(selectedPlayer);
      redrawNeeded = true;
    });
    const jump = first => {
      const times = playerActions.get(selectedPlayer) || [];
      const time = first ? times[0] : times.find(t => t > currentTime + 1);
      if (time === undefined) { focusUI.playerStatus.textContent = "No further recorded action for this player."; return; }
      setPlaying(false);
      setTime(time, true);
    };
    focusUI.firstAction.addEventListener("click", () => jump(true));
    focusUI.nextAction.addEventListener("click", () => jump(false));
  }

  function playerBadge(index, point, server, observed = true) {
    if (index < 0) return;
    const selected = index === selectedPlayer;
    const featured = focusUI?.featuredVisible.checked && featuredPlayers.has(index);
    if (!selected && !featured) return;
    ctx.save();
    ctx.strokeStyle = selected ? "#fff" : campColor(server);
    ctx.lineWidth = 2;
    ctx.setLineDash(observed ? [] : [3, 3]);
    ctx.beginPath(); ctx.arc(point.x, point.y, 13, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    const player = playerFor(index);
    const queen = isCurated(player[1]);
    ctx.font = "bold 19px Georgia, serif";
    ctx.fillStyle = campColor(server);
    if (featured) ctx.fillText(queen ? "♛" : "★", point.x - 8, point.y - 17);
    ctx.font = "bold 11px system-ui";
    const label = player[1] + (observed ? "" : " · inferred");
    ctx.fillStyle = "#10151d";
    ctx.fillRect(point.x + 16, point.y - 12, ctx.measureText(label).width + 8, 18);
    ctx.fillStyle = "#fff"; ctx.fillText(label, point.x + 20, point.y + 1);
    ctx.restore();
  }

  // campOf is 0 for side A, 1 for side B and -1 for neither. Replays split by
  // the battle's camps (or the two chosen servers); live splits the home
  // server from every foreign one.
  function campOf(server) {
    const value = Number(server);
    if (live) return !value ? -1 : value === Number(ui.sideAServer.value) ? 0 : 1;
    const groups = battle?.sideGroups || [];
    if ((groups[0]?.servers || [Number(ui.sideAServer.value)]).includes(value)) return 0;
    if ((groups[1]?.servers || [Number(ui.sideBServer.value)]).includes(value)) return 1;
    return -1;
  }

  function campColor(server, alpha = 1) {
    const camp = campOf(server);
    if (camp === 0) return hexColor(ui.sideAColor.value, alpha);
    if (camp === 1) return hexColor(ui.sideBColor.value, alpha);
    return hexColor("#657486", alpha);
  }

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

  function entityColor(alliance, abbr, server, alpha = 1, playerIndex = -1) {
    if (playerIndex >= 0 && playerIndex === selectedPlayer) return hexColor(ui.highlightColor.value, alpha);
    const key = allianceKey(alliance, abbr);
    if (highlightAllianceGroups.get(ui.highlightAlliance.value)?.has(key)) {
      return hexColor(ui.highlightColor.value, alpha);
    }
    if (ui.colorMode.value === "alliance") {
      return colorFor(key || server || "unknown", alpha);
    }
    if (playerIndex >= 0 && focusUI?.featuredVisible.checked && featuredPlayers.has(playerIndex)) return campColor(server, alpha);
    if (ui.colorMode.value === "spotlight" && ui.highlightAlliance.value) alpha *= .22;
    return campOf(server) === -1 ? hexColor("#657486", alpha * .62) : campColor(server, alpha);
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

  function shieldActive(base) {
    return base.shieldEnd > 0 && base.shieldEnd * 1000 > manifest.start + currentTime;
  }

  function marchPosition(march, time) {
    const duration = Math.max(1, march.end - march.start);
    const progress = clamp((time - march.start) / duration, 0, 1);
    return {
      x: march.sx + (march.tx - march.sx) * progress,
      y: march.sy + (march.ty - march.sy) * progress,
    };
  }

  // observedBase is the base a type-2 create/change/relocate tuple describes.
  function observedBase(event) {
    return {
      actor: event[3],
      position: event[4],
      instance: event[5],
      observed: true,
      confidence: 100,
      operation: event[2],
      updatedAt: event[1],
      // Live tuples carry the shield end (unix seconds); replays do not.
      shieldEnd: Number(event[6]) || 0,
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
        placeBase(observedBase(event));
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

  function formatClock(time) {
    return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function updateReadout() {
    ui.clock.textContent = formatClock(manifest.start + currentTime);
    if (live) {
      ui.elapsed.textContent = live.lastDataAt ? `last change ${HeimdallLive.ago(Date.now() - live.lastDataAt)}` : "waiting for data";
    } else {
      const seconds = Math.floor(currentTime / 1000);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      ui.elapsed.textContent = `+${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
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
    ui.eventCount.textContent = (live ? live.received : eventIndex).toLocaleString();
    updateIntegrityReadout();
    updateCaptureReadout();
  }

  function updateIntegrityReadout() {
    if (live) {
      renderLiveStatus();
      return;
    }
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
    if (live) {
      fitLiveView();
      return;
    }
    const { width, height } = screenSize();
    const capitolViewSpan = battle?.layout === "none" ? 1060 : 180;
    camera = {
      x: CAPITOL.x,
      y: CAPITOL.y,
      zoom: clamp(Math.min(width, height) / capitolViewSpan, .75, 8),
    };
    redrawNeeded = true;
  }

  const warzoneSize = () => manifest?.mapWidth || 1000;

  // The smallest zoom still shows the whole warzone plus VIEW_MARGIN on each
  // side along the screen's shorter axis.
  function minZoom(width, height) {
    return Math.min(width, height) / (warzoneSize() * (1 + 2 * VIEW_MARGIN));
  }

  // constrainView keeps the warzone in sight: no zooming out past it and its
  // margin, and no panning the view further than the margin beyond its edge.
  function constrainView(width, height) {
    camera.zoom = clamp(camera.zoom, minZoom(width, height), MAX_ZOOM);
    const size = warzoneSize();
    const margin = size * VIEW_MARGIN;
    const axis = (center, span) => {
      const low = -margin + span / 2;
      const high = size + margin - span / 2;
      return low > high ? size / 2 : clamp(center, low, high);
    };
    camera.x = axis(camera.x, width / camera.zoom);
    camera.y = axis(camera.y, height / camera.zoom);
  }

  function zoomAt(x, y, nextZoom) {
    const { width, height } = screenSize();
    const before = toWorld(x, y, width, height);
    camera.zoom = clamp(nextZoom, minZoom(width, height), MAX_ZOOM);
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

  // drawCameraAreas outlines what each live camera watches, coloured by its
  // state, and dims the rest of the warzone, where nothing is observed.
  function drawCameraAreas(width, height) {
    const watched = live ? live.cameras.filter(camera => camera.area) : [];
    if (!watched.length) return;
    const box = ({ left, bottom, right, top }) => {
      const a = toScreen(left, bottom, width, height);
      const b = toScreen(right, top, width, height);
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    };
    const size = warzoneSize();
    ctx.save();
    ctx.beginPath();
    for (const rect of [box({ left: 0, bottom: 0, right: size, top: size }), ...watched.map(camera => box(camera.area))]) {
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
    }
    ctx.fillStyle = "rgba(0,0,0,.34)";
    ctx.fill("evenodd");
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 5]);
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (const camera of watched) {
      const rect = box(camera.area);
      const color = CAMERA_STATE_COLORS[camera.state] || CAMERA_STATE_COLORS.down;
      ctx.strokeStyle = hexColor(color, .85);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = hexColor(color, .95);
      ctx.fillText(`CAMERA ${camera.camera.toUpperCase()} · ${camera.state.toUpperCase()}`, rect.x + 6, rect.y + 6);
    }
    ctx.restore();
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
    const color = entityColor(meta[3], meta[1], meta[2], 1, meta[4]);
    const size = Math.max(4, camera.zoom * 3);
    const emphasized = meta[4] === selectedPlayer && selectedPlayer >= 0 || focusUI?.featuredVisible.checked && featuredPlayers.has(meta[4]) || highlightAllianceGroups.get(ui.highlightAlliance.value)?.has(allianceKey(meta[3], meta[1]));
    ctx.fillStyle = entityColor(meta[3], meta[1], meta[2], emphasized ? .9 : base.observed ? .35 : .05, meta[4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = base.observed ? 1 : 1.25;
    ctx.setLineDash(base.observed ? [] : [3, 2]);
    ctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    ctx.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
    ctx.setLineDash([]);
    if (shieldActive(base)) {
      ctx.strokeStyle = "rgba(124,225,255,.9)";
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.arc(point.x, point.y, size * .75 + 3, 0, Math.PI * 2); ctx.stroke();
    }
    if (ui.showLabels.checked && meta[1] && camera.zoom > 1.4) {
      ctx.fillStyle = "rgba(232,238,245,.72)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(meta[1], point.x + size / 2 + 3, point.y + 3);
    }
    renderHits.push({ kind: "base", x: point.x, y: point.y, data: base });
    if (ui.colorMode.value === "alliance") {
      ctx.strokeStyle = campColor(meta[2]);
      ctx.strokeRect(point.x - size / 2 - 2, point.y - size / 2 - 2, size + 4, size + 4);
    }
    playerBadge(meta[4], point, meta[2], base.observed);
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
    const color = entityColor(player[4], player[2], player[3], 1, march.player);
    if (ui.showRoutes.checked || march.player === selectedPlayer) drawArrow(point, target, entityColor(player[4], player[2], player[3], march.player === selectedPlayer ? .9 : .28, march.player));
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
    if (ui.colorMode.value === "alliance") {
      ctx.strokeStyle = campColor(player[3]);
      ctx.beginPath(); ctx.arc(point.x, point.y, 7, 0, Math.PI * 2); ctx.stroke();
    }
    if (march.player === selectedPlayer || featuredPlayers.has(march.player)) playerBadge(march.player, point, player[3], false);
  }

  function render() {
    if (focusUI && selectedPlayer < 0) setText(focusUI.playerStatus, "Select a player to spotlight their base and marches. Queens and stars are curated, not rankings.");
    if (focusUI && selectedPlayer >= 0) {
      const gapNow = integrityGapAt(manifest.start + currentTime);
      const base = [...bases.values()].find(b => b.observed && baseMeta(b.actor)[4] === selectedPlayer);
      setText(focusUI.playerStatus, gapNow ? "Coverage gap: position unavailable." : base ? "Last observed base position; marches are interpolated. Featured markers are curated, not rankings." : "Base not currently observed; recorded marches may still be visible.");
      if (!gapNow && base && focusUI.followPlayer.checked) Object.assign(camera, unpack(base.position));
    }
    resizeCanvas();
    const { width, height, ratio } = screenSize();
    constrainView(width, height);
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
      ctx.fillText(gap.reason || "Events in this interval were not observed", width / 2, height / 2 + 18);
      ctx.restore();
      renderHits = [];
      redrawNeeded = false;
      return;
    }
    drawCameraAreas(width, height);
    drawCapitol(width, height);
    // Discrete breadcrumbs, never a fabricated path between teleports.
    const trail = (playerObservations.get(selectedPlayer) || []).filter(p => p.time <= currentTime && p.time >= currentTime - 300000 && !integrityGapAt(manifest.start + p.time));
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.55)";
    ctx.setLineDash([2, 2]);
    for (const sample of trail.slice(-100)) {
      const world = unpack(sample.position);
      const point = toScreen(world.x, world.y, width, height);
      ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    renderHits = [];
    const server = selectedServer();
    if (ui.showBases.checked) for (const base of bases.values()) drawBase(base, width, height, server);
    for (const march of activeMarches.values()) drawMarch(march, width, height, server);
    redrawNeeded = false;
  }

  function frame(now) {
    // Re-arm first: an exception below must not stop the map for good.
    requestAnimationFrame(frame);
    if (live) {
      tickLive(now);
    } else if (playing && manifest) {
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
    if (redrawNeeded || playing || live) render();
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
      const rows = [
        ["Alliance", meta[1]],
        ["Server", String(meta[2] || "")],
        ["Coordinates", `${world.x}, ${world.y}`],
        ["Footprint", "3 × 3 tiles"],
        ["Evidence", live ? "Live map" : base.observed ? baseOperationName(base.operation) : "March + later point confirmation"],
        ["Confidence", `${base.confidence}%`],
      ];
      if (shieldActive(base)) {
        const until = new Date(base.shieldEnd * 1000);
        rows.push(["Shield until", until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })]);
      }
      detailRows(rows);
    }
    ui.inspector.hidden = false;
  }

  async function loadReplay() {
    try {
      const catalogResponse = await fetch(CATALOG_URL, { cache: "no-store" });
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

      const manifestResponse = await fetch(`${dataRoot}manifest.json`, { cache: "no-store" });
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
        const response = await fetch(dataRoot + chunk.file, { cache: "no-store" });
        if (!response.ok) throw new Error(`${chunk.file} HTTP ${response.status}`);
        const payload = await response.json();
        events.push(...payload.e);
      }
      events.sort((a, b) => a[1] - b[1]);
      populateServers();
      restorePalette();
      setupPlayerControls();
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

  // Live mode: the relay's snapshot and batches feed the same state the
  // replay builds. Players are keyed by the relay's index, so a base actor
  // is its owner's player index and baseActors mirrors players.
  function startLive() {
    if (!window.HeimdallLive) {
      ui.loadState.textContent = "Live mode is unavailable on this page";
      ui.loadState.className = "load-state error";
      return;
    }
    battleId = "live";
    battle = { id: "live", title: "Live world map" };
    manifest = { mapWidth: 1000, start: 0, duration: 0, players: [], baseActors: [] };
    live = {
      connection: { state: "connecting", attempt: 0, retryAt: 0 },
      cameras: [],
      hasSnapshot: false,
      fitted: false,
      fitPending: false,
      lastDataAt: 0,
      lastDataT: 0,
      clockOffset: null,
      received: 0,
      readoutAt: 0,
      tickAt: performance.now(),
      rosterAt: 0,
      rosterDirty: false,
      selectBusyUntil: 0,
      feed: null,
      paletteRestored: false,
      pendingSelection: null,
      uidIndex: new Map(),
      chips: null,
    };
    document.body.classList.add("is-live");
    ui.battleTitle.textContent = battle.title;
    document.title = `${battle.title} — Heimdall`;
    mountLiveControls();
    populateServers();
    setupPlayerControls();
    resetView();
    renderLiveStatus();
    live.feed = HeimdallLive.connect(HeimdallLive.relayUrl(location.href), {
      onMessage: handleLiveMessage,
      onConnection: change => {
        live.connection = change;
        if (change.state === "open") live.hasSnapshot = false;
        renderLiveStatus();
        renderCameraChips();
      },
    });
    window.addEventListener("online", () => live.feed.reconnectNow());
  }

  function mountLiveControls() {
    ui.showInferred.closest("label").hidden = true;
    document.querySelector(".key-inferred")?.closest("span")?.remove();
    for (const [className, label] of [["key-shield", "Shield"], ["key-camera", "Camera area"]]) {
      const key = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.className = className;
      key.append(swatch, label);
      document.querySelector(".map-key")?.append(key);
    }
    // Live colours split the home server from every foreign one (campOf).
    const campOption = ui.colorMode.querySelector('option[value="server"]');
    if (campOption) campOption.textContent = "Home vs foreign";
    ui.sideAServer.setAttribute("aria-label", "Home server");
    ui.sideAColor.setAttribute("aria-label", "Home server color");
    ui.sideBColor.setAttribute("aria-label", "Foreign servers color");
    ui.sideBServer.hidden = true;
    const foreign = document.createElement("span");
    foreign.className = "foreign-label";
    foreign.textContent = "Foreign";
    ui.sideBServer.after(foreign);
    const eyebrow = ui.integrityNotice.querySelector(".eyebrow");
    if (eyebrow) eyebrow.textContent = "Live feed";
    live.chips = document.createElement("div");
    live.chips.className = "live-cameras";
    live.chips.setAttribute("aria-label", "Camera status");
    ui.timeline.after(live.chips);
    // A native select keeps focus after a choice, so focus alone can't tell
    // an open dropdown; a recent pointer or key press on one can.
    const trackSelect = event => {
      if (!(event.target instanceof HTMLSelectElement)) return;
      const settled = event.type === "change" || event.type === "focusout";
      live.selectBusyUntil = settled ? 0 : Date.now() + LIVE_SELECT_BUSY_MS;
    };
    for (const type of ["pointerdown", "keydown", "change", "focusout"]) {
      document.addEventListener(type, trackSelect, true);
    }
  }

  function handleLiveMessage(message) {
    live.clockOffset = HeimdallLive.syncClock(live.clockOffset, message, Date.now());
    if (message.t) live.lastDataT = message.type === "snap" ? message.t : Math.max(live.lastDataT, message.t);
    if (message.type === "status") {
      live.cameras = message.cameras;
      // The watched server is the natural home side, unless the viewer
      // picked one already (populateServers keeps a previous choice).
      const home = message.cameras.find(camera => camera.area?.server)?.area.server;
      if (home && battle.servers?.[0] !== home) {
        battle.servers = [home];
        live.rosterDirty = true;
      }
      renderCameraChips();
      renderLiveStatus();
      return;
    }
    if (message.type === "snap") resetLiveState(message.mapWidth);
    applyLivePlayers(message.players);
    const fromSnapshot = message.type === "snap";
    for (const event of message.events) applyLiveEvent(event, fromSnapshot);
    live.received += message.events.length;
    live.lastDataAt = Date.now();
    if (message.type === "snap") {
      live.hasSnapshot = true;
      restoreLiveSelection();
      live.rosterAt = 0;
      // Fit on the next frame: a tab opened in the background has no canvas
      // size yet, and frames only run once it is shown.
      if (!live.fitted) live.fitPending = true;
    }
    redrawNeeded = true;
    renderLiveStatus();
  }

  // resetLiveState empties the map for a fresh snapshot. Relay indices can
  // change (the relay restarted), so selections are carried over by uid.
  function resetLiveState(mapWidth) {
    live.pendingSelection = {
      selected: selectedPlayer >= 0 ? playerFor(selectedPlayer)[0] : "",
      featured: [...featuredPlayers].map(index => playerFor(index)[0]).filter(Boolean),
    };
    manifest.mapWidth = mapWidth || manifest.mapWidth;
    manifest.players = [];
    manifest.baseActors = [];
    live.uidIndex = new Map();
    bases = new Map();
    activeMarches = new Map();
    playerObservations.clear();
    featuredPlayers.clear();
    selectedPlayer = -1;
    // The lists must be rebuilt even if the snapshot has no players.
    live.rosterDirty = true;
  }

  function restoreLiveSelection() {
    const pending = live.pendingSelection;
    live.pendingSelection = null;
    if (!pending) return;
    for (const uid of pending.featured) {
      const index = live.uidIndex.get(uid);
      if (index !== undefined) featuredPlayers.add(index);
    }
    selectedPlayer = pending.selected ? live.uidIndex.get(pending.selected) ?? -1 : -1;
  }

  function applyLivePlayers(rows) {
    for (const row of rows) {
      manifest.players[row.index] = [row.uid, row.name, row.abbr, row.server, ""];
      manifest.baseActors[row.index] = [row.name, row.abbr, row.server, "", row.index];
      live.uidIndex.set(row.uid, row.index);
      if (isCurated(row.name)) featuredPlayers.add(row.index);
    }
    if (rows.length) live.rosterDirty = true;
  }

  // applyLiveEvent also keeps a short trail of each player's base positions
  // for the spotlight breadcrumbs. A snapshot is the relay's whole, already
  // consistent state, so its bases skip placeBase's overlap scan (O(n²)).
  function applyLiveEvent(event, fromSnapshot) {
    const baseSeen = event[0] === 2 && event[2] === 0;
    if (fromSnapshot && baseSeen && event[3] >= 0) bases.set(event[3], observedBase(event));
    else applyEvent(event);
    if (!baseSeen) return;
    const trail = playerObservations.get(event[3]) || [];
    if (trail.at(-1)?.position === event[4]) return;
    trail.push({ time: event[1], position: event[4] });
    if (trail.length > LIVE_TRAIL_LIMIT) trail.shift();
    playerObservations.set(event[3], trail);
  }

  function liveClock() {
    return Date.now() + (live.clockOffset ?? 0);
  }

  function tickLive(now) {
    currentTime = liveClock();
    checkLiveFeed(now);
    if (live.fitPending && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      live.fitPending = false;
      live.fitted = true;
      fitLiveView();
    }
    if (now - live.readoutAt >= LIVE_READOUT_MS) {
      live.readoutAt = now;
      updateReadout();
    }
    if (live.rosterDirty && now - live.rosterAt >= LIVE_ROSTER_MS) refreshLiveRoster(now);
  }

  // checkLiveFeed replaces a socket that has gone quiet: always after
  // LIVE_IDLE_MS, and after LIVE_WAKE_IDLE_MS when frames resume following a
  // gap (sleep, hidden tab), when a dead link is likely.
  function checkLiveFeed(now) {
    const gap = now - live.tickAt;
    live.tickAt = now;
    const idle = live.feed?.idleFor() ?? 0;
    if (idle > LIVE_IDLE_MS || (gap > LIVE_WAKE_GAP_MS && idle > LIVE_WAKE_IDLE_MS)) {
      live.feed.reconnectNow();
    }
  }

  function refreshLiveRoster(now) {
    // Rebuilding a select closes it, so wait while the viewer is using one.
    if (Date.now() < live.selectBusyUntil) return;
    live.rosterAt = now;
    populateServers();
    if (!live.paletteRestored && manifest.players.length) {
      live.paletteRestored = true;
      restorePalette();
    } else {
      updatePaletteControls();
    }
    refreshPlayerList();
    live.rosterDirty = false;
  }

  // fitLiveView frames every known base, or the whole map before any arrive.
  function fitLiveView() {
    resizeCanvas();
    const { width, height } = screenSize();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const base of bases.values()) {
      const { x, y } = unpack(base.position);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (minX > maxX) {
      const half = manifest.mapWidth / 2;
      camera = { x: half, y: half, zoom: clamp(Math.min(width, height) / (manifest.mapWidth * 1.06), .25, 20) };
    } else {
      const spanX = maxX - minX + LIVE_FIT_MARGIN;
      const spanY = maxY - minY + LIVE_FIT_MARGIN;
      camera = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: clamp(Math.min(width / spanX, height / spanY), .25, 20) };
    }
    redrawNeeded = true;
  }

  function renderLiveStatus() {
    const status = HeimdallLive.describeStatus(live, Date.now(), formatClock);
    setText(ui.loadState, status.headline);
    ui.loadState.className = `load-state live-state is-${status.level}`;
    ui.integrityNotice.hidden = status.level === "live";
    ui.integrityNotice.classList.toggle("is-gap", status.level === "down" || status.level === "offline");
    ui.integrityNotice.classList.toggle("is-warn", status.level === "stale" || status.level === "connecting");
    setText(ui.integrityTitle, status.title);
    setText(ui.integrityText, status.detail);
    setText(ui.integrityState, status.pill);
  }

  function renderCameraChips() {
    if (!live.chips) return;
    live.chips.replaceChildren(...live.cameras.map(camera => {
      const chip = document.createElement("span");
      chip.className = `camera-chip is-${camera.state}`;
      chip.title = camera.detail || camera.state;
      const state = document.createElement("b");
      state.textContent = camera.state;
      chip.append(document.createElement("i"), camera.camera, state);
      return chip;
    }));
    live.chips.classList.toggle("is-frozen", live.connection.state !== "open");
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
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
    // forEach skips holes: live player indices can arrive out of order.
    manifest.players.forEach(player => remember(player[2], player[3], player[4]));
    manifest.baseActors.forEach(base => remember(base[1], base[2], base[3]));
    const servers = [...serverCounts].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
    // Rebuilt on every live roster change, so keep whatever the viewer chose.
    const previous = {
      filter: ui.serverFilter.value,
      sideA: ui.sideAServer.value,
      sideB: ui.sideBServer.value,
      alliance: ui.highlightAlliance.value,
    };
    const serverOptions = () => servers.map(([server]) => new Option(`Server ${server}`, String(server)));
    ui.serverFilter.replaceChildren(new Option("All servers", "all"), ...serverOptions());
    ui.sideAServer.replaceChildren(...serverOptions());
    ui.sideBServer.replaceChildren(...serverOptions());
    const preferredServers = battle?.servers || [];
    selectFirst(ui.serverFilter, [previous.filter, "all"]);
    selectFirst(ui.sideAServer, [previous.sideA, preferredServers[0], servers[0]?.[0]]);
    // Side B skips side A's server, which a roster that started with a single
    // server would otherwise leave selected on both sides.
    const sideA = ui.sideAServer.value;
    selectFirst(ui.sideBServer, [previous.sideB, preferredServers[1], ...servers.map(([server]) => server)]
      .filter(value => value !== undefined && String(value) !== sideA));
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
    // Values are label-based so a growing live roster does not shift them.
    const allianceOptions = [...allianceGroups]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, keys]) => [`highlight:${label}`, label, keys]);
    highlightAllianceGroups = new Map(allianceOptions.map(([group, , keys]) => [group, keys]));
    ui.highlightAlliance.replaceChildren(
      new Option("None", ""),
      ...allianceOptions.map(([group, label]) => new Option(label, group)),
    );
    selectFirst(ui.highlightAlliance, [previous.alliance, ""]);
  }

  // selectFirst selects the first candidate value the select offers.
  function selectFirst(select, candidates) {
    const offered = new Set([...select.options].map(option => option.value));
    const choice = candidates.find(value => value !== undefined && value !== null && offered.has(String(value)));
    if (choice !== undefined) select.value = String(choice);
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
    ui.sideControls.hidden = false;
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
      camera.zoom = clamp(pinch.zoom * distance / pinch.distance, minZoom(width, height), MAX_ZOOM);
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
    if (!manifest || live || ["INPUT", "SELECT", "BUTTON"].includes(document.activeElement.tagName)) return;
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
  if (LIVE_REQUESTED) startLive();
  else loadReplay();
})();
