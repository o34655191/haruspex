// Watchtower live feed model: folds the relay's snapshot, batched events and
// camera status into what the watch page draws. Pure data, so it runs under
// node:test as well as in the browser. Event tuples (see heimdall-live.js):
//   [0, t, march, player, marchType, start, target, startMs, endMs, targetKind, team, speed]
//   [1, t, march]
//   [2, t, op, player, pos, 0, shieldEnd]   op 0 = base seen, 3 = base gone
((root) => {
  "use strict";

  const live = root.HeimdallLive || (typeof require === "function" ? require("./heimdall-live.js") : null);
  const MARCH = 0;
  const MARCH_GONE = 1;
  const BASE = 2;
  const BASE_GONE = 3;

  // createFeed is an empty store. It is mutated in place: a busy warzone sends
  // thousands of events a minute, and copying it per message buys nothing.
  function createFeed() {
    return {
      players: [], bases: new Map(), marches: new Map(), cameras: [],
      mapWidth: 1000, clockOffset: null, hasSnapshot: false, lastDataAt: 0, lastDataT: 0,
    };
  }

  // applyMessage folds one checked message (HeimdallLive.parseMessage). A
  // snapshot replaces everything; status messages carry no map data.
  function applyMessage(feed, message, wallNow) {
    feed.clockOffset = live.syncClock(feed.clockOffset, message, wallNow);
    if (message.type === "snap") {
      feed.players = [];
      feed.bases.clear();
      feed.marches.clear();
      feed.hasSnapshot = true;
      if (message.mapWidth) feed.mapWidth = message.mapWidth;
    }
    for (const player of message.players) feed.players[player.index] = player;
    for (const event of message.events) applyEvent(feed, event);
    if (message.type === "status") {
      feed.cameras = message.cameras;
      return;
    }
    feed.lastDataAt = wallNow;
    if (message.t) feed.lastDataT = message.t;
  }

  function applyEvent(feed, event) {
    switch (event[0]) {
      case MARCH:
        feed.marches.set(event[2], {
          id: event[2], player: event[3], type: event[4], start: event[5], target: event[6],
          startMs: event[7], endMs: event[8], targetKind: event[9], team: event[10], speed: event[11],
        });
        break;
      case MARCH_GONE:
        feed.marches.delete(event[2]);
        break;
      case BASE:
        if (event[2] === BASE_GONE) feed.bases.delete(event[3]);
        else feed.bases.set(event[3], { player: event[3], pos: event[4], shieldEnd: event[6] || 0 });
        break;
    }
  }

  const unpack = (pos, mapWidth) => ({ x: pos % mapWidth, y: Math.floor(pos / mapWidth) });

  // dataNow is the relay's clock: map times come from the game, not this PC.
  const dataNow = (feed, wallNow) => wallNow + (feed.clockOffset ?? 0);

  // marchPoint is where a march is at time now, between its start and target.
  function marchPoint(march, now, mapWidth) {
    const from = unpack(march.start, mapWidth);
    const to = unpack(march.target, mapWidth);
    const span = march.endMs - march.startMs;
    const progress = rallyWaiting(march, mapWidth) ? 0
      : span > 0 ? Math.min(1, Math.max(0, (now - march.startMs) / span)) : 0;
    return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress, tx: to.x, ty: to.y, progress };
  }

  // The legacy 12-slot relay omits MarchStatus. Live forming rallies have a
  // countdown interval (observed 180002 ms), whereas launched updates have a
  // travel interval matching distance/speed (e.g. 18.3576 / 4.4 = 4.172 s).
  // Never animate across the countdown or automatically launch on its expiry.
  // Allow rounding/ordinary speed variation before inferring a waiting timer.
  function rallyWaiting(march, mapWidth) {
    if (march.type !== 1 && march.type !== 41) return false;
    if (!(march.speed > 0)) return true; // no evidence of travel
    const from = unpack(march.start, mapWidth), to = unpack(march.target, mapWidth);
    const travelMs = Math.hypot(to.x - from.x, to.y - from.y) / march.speed * 1000;
    const span = march.endMs - march.startMs;
    return span > travelMs + Math.max(2000, travelMs * 0.25);
  }

  function marchState(march, now, mapWidth) {
    if (!(march.endMs > now)) return "expired";
    if (rallyWaiting(march, mapWidth)) return "rally-waiting";
    if (march.targetKind === 2 && march.start === march.target) return "gathering";
    return "moving";
  }

  // sideOf colours a player: home (the camera's server), foreign, or none
  // when the game sent no alliance.
  function sideOf(player, homeServer) {
    if (!player || !player.abbr) return "none";
    return homeServer && player.server === homeServer ? "home" : "foreign";
  }

  const cameraFor = (feed, id) => feed.cameras.find(camera => camera.camera === id) || null;

  const sameArea = (a, b) => Boolean(a && b) && a.server === b.server && a.left === b.left && a.bottom === b.bottom
    && a.right === b.right && a.top === b.top;

  // watcher/internal/codec/worldmap.go: field 11 is absolute Unix seconds,
  // not a duration. MaxInt64 (rounded by JSON/JS) means no timed shield.
  function shieldRemaining(end, nowMs) {
    if (!Number.isSafeInteger(end) || end <= 0 || end > 253402300799) return 0;
    return Math.max(0, end - Math.floor(nowMs / 1000));
  }
  function duration(seconds) {
    seconds = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = seconds % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  }

  // NewMarchType.TRAIN = 14 covers TrainType.Truck AND TrainType.Train.
  // The deployed relay omits TrainType, so do not guess from team/targetKind.
  const isTransport = march => march.type === 14;
  const entityKind = march => isTransport(march) ? "Truck / train" : "March";
  const allianceKey = player => player?.abbr ? JSON.stringify([player.server || 0, player.abbr]) : "";
  function allianceColor(key) {
    let hash = 2166136261;
    for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    // Convert HSL to hex because canvas route transparency uses hex colours.
    const hue = (hash >>> 0) % 360 / 30;
    const channel = n => {
      const k = (n + hue) % 12;
      return Math.round(255 * (0.65 - 0.24 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0");
    };
    return `#${channel(0)}${channel(8)}${channel(4)}`;
  }
  function playerColor(player, home, mode, overrides) {
    const key = allianceKey(player);
    if (key && /^#[0-9a-f]{6}$/i.test(overrides.get(key) || "")) return overrides.get(key);
    if (mode === "domestic" && home && player?.server && player.server !== home) return "#ff5d5d";
    return key ? allianceColor(key) : "#8a96a3";
  }

  const api = { createFeed, applyMessage, applyEvent, unpack, dataNow, marchPoint, sideOf, cameraFor, sameArea,
    shieldRemaining, duration, isTransport, entityKind, allianceKey, allianceColor, playerColor, rallyWaiting, marchState };
  root.WatchtowerFeed = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
