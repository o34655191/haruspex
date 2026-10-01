// Heimdall live feed: one WebSocket to the lwlive relay. The relay sends a full
// "snap" on connect, then batched "ev" changes and "status" camera health.
// Events use the replay tuple format that heimdall.js applyEvent understands:
//   [0, t, march, player, marchType, start, target, startMs, endMs, targetKind, team, speed]
//   [1, t, march]
//   [2, t, op, player, pos, 0, shieldEnd]   op 0 = base seen, 3 = base gone
// Player rows are [index, uid, name, abbr, server]; t is unix ms.
((root) => {
  "use strict";

  const DEFAULT_RELAY = "wss://heimdall.tailc3e099.ts.net/ws";
  const RETRY_BASE_MS = 1000;
  const RETRY_MAX_MS = 30000;
  // A connection that stayed up this long resets the backoff. Shorter ones
  // (refused, or dropped right after the snapshot) keep backing off, so a
  // struggling relay is not hammered with snapshot requests.
  const STABLE_MS = 30000;
  // Player indices are dense from 0; the cap keeps one corrupt row from
  // growing the page's player arrays to a huge sparse length.
  const MAX_PLAYER_INDEX = 100000;
  // Packed positions (x + mapWidth·y) stay far below this on any real map;
  // the cap keeps a corrupt value from wrecking the view.
  const MAX_POSITION = 10000000;
  const MAX_AREA_COORD = 10000;
  const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const MIN_EVENT_LENGTH = new Map([[0, 12], [1, 3], [2, 5]]);
  const POSITION_SLOTS = new Map([[0, [5, 6]], [1, []], [2, [4]]]);
  const CAMERA_STATES = new Set(["connecting", "live", "moving", "stale", "down"]);

  const scalar = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
  const validPosition = value => Number.isInteger(value) && value >= 0 && value < MAX_POSITION;

  // relayUrl picks the feed address. ?relay= is honoured only when the page
  // itself runs on a local dev host and the relay is local too, so a shared
  // link cannot point viewers (or Mission Control's key) at somebody else's
  // server.
  function relayUrl(pageUrl) {
    const page = new URL(pageUrl);
    const override = page.searchParams.get("relay");
    if (!override || !DEV_HOSTS.has(page.hostname)) return DEFAULT_RELAY;
    try {
      const target = new URL(override);
      const local = DEV_HOSTS.has(target.hostname);
      return local && (target.protocol === "ws:" || target.protocol === "wss:") ? target.href : DEFAULT_RELAY;
    } catch {
      return DEFAULT_RELAY;
    }
  }

  // retryDelay is exponential backoff with jitter, so viewers do not all
  // reconnect in the same instant after a relay restart.
  function retryDelay(attempt, random = Math.random) {
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
    return Math.round(ceiling * (0.5 + random() * 0.5));
  }

  function validPlayers(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(row => Array.isArray(row) && Number.isInteger(row[0]) && row[0] >= 0 && row[0] < MAX_PLAYER_INDEX)
      .map(row => ({
        index: row[0],
        uid: scalar(row[1]),
        name: scalar(row[2]),
        abbr: scalar(row[3]),
        server: Number.isFinite(row[4]) ? row[4] : 0,
      }))
      .filter(row => row.uid !== "");
  }

  function validEvents(events) {
    if (!Array.isArray(events)) return [];
    return events.filter(event => Array.isArray(event)
      && event.length >= (MIN_EVENT_LENGTH.get(event[0]) ?? Infinity)
      && event.every(Number.isFinite)
      && POSITION_SLOTS.get(event[0]).every(slot => validPosition(event[slot])));
  }

  // validArea checks the rectangle a camera watches: local tiles, with the
  // right and top edges exclusive. Anything else means "area unknown".
  function validArea(area) {
    if (!area || typeof area !== "object") return null;
    const { server, left, bottom, right, top } = area;
    const inMap = value => Number.isInteger(value) && value >= 0 && value <= MAX_AREA_COORD;
    if (![left, bottom, right, top].every(inMap) || right <= left || top <= bottom) return null;
    return { server: Number.isInteger(server) && server > 0 ? server : 0, left, bottom, right, top };
  }

  function validCameras(cameras) {
    if (!Array.isArray(cameras)) return [];
    return cameras
      .filter(camera => camera && typeof camera.camera === "string")
      .map(camera => ({
        camera: camera.camera,
        name: typeof camera.name === "string" ? camera.name : "",
        state: CAMERA_STATES.has(camera.state) ? camera.state : "down",
        detail: typeof camera.detail === "string" ? camera.detail : "",
        area: validArea(camera.area),
        movedAt: Number.isFinite(camera.movedAt) && camera.movedAt > 0 ? camera.movedAt : 0,
      }));
  }

  const STRUCTURE_KINDS = ["city", "stronghold", "tradepost", "outpost", "capitol"];
  const MAX_FOOTPRINT = 200;

  function validFootprint(raw) {
    const core = Number.isInteger(raw?.core) && raw.core >= 0 && raw.core <= MAX_FOOTPRINT ? raw.core : 0;
    const zone = Number.isInteger(raw?.zone) && raw.zone >= core && raw.zone <= MAX_FOOTPRINT ? raw.zone : core;
    return { core, zone };
  }

  // parseLayout checks a season layout file (data/heimdall/layouts/<server>.json):
  // per-kind footprints, the core and the grey zone around it in tiles, and
  // structures as [kind, name, level, x, y, buff] at their centre tile.
  function parseLayout(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.structures)) return null;
    const footprints = Object.fromEntries(STRUCTURE_KINDS.map(kind => [kind, validFootprint(raw.footprints?.[kind])]));
    const inMap = value => Number.isInteger(value) && value >= 0 && value <= MAX_AREA_COORD;
    const structures = raw.structures
      .filter(row => Array.isArray(row) && STRUCTURE_KINDS.includes(row[0]) && inMap(row[3]) && inMap(row[4]))
      .map(([kind, name, level, x, y, buff]) => ({
        kind,
        name: scalar(name) || kind,
        level: Number.isInteger(level) && level >= 0 ? level : 0,
        x,
        y,
        buff: scalar(buff),
      }));
    return { footprints, structures };
  }

  // parseMessage turns one relay frame into a checked message, or null.
  function parseMessage(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object" || !["snap", "ev", "status"].includes(raw.type)) return null;
    return {
      type: raw.type,
      t: Number.isFinite(raw.t) && raw.t > 0 ? raw.t : 0,
      mapWidth: Number.isInteger(raw.mapWidth) && raw.mapWidth > 0 ? raw.mapWidth : 0,
      players: validPlayers(raw.players),
      events: validEvents(raw.events),
      cameras: validCameras(raw.cameras),
    };
  }

  // syncClock returns the data-clock offset (relay ms minus local ms). A
  // snapshot sets it outright; later messages only move it forward, so a
  // status message carrying an old data time cannot rewind the map.
  function syncClock(offset, message, wallNow) {
    if (!message.t) return offset;
    const candidate = message.t - wallNow;
    return offset === null || message.type === "snap" || candidate > offset ? candidate : offset;
  }

  function ago(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 2) return "just now";
    if (seconds < 60) return `${seconds} s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    return `${Math.floor(seconds / 3600)} h ago`;
  }

  const CAMERA_PROBLEMS = [
    ["down", "Camera down", "Camera down — the map is not updating", "Down"],
    ["stale", "Camera stale", "Camera stale — the map may be out of date", "Stale"],
    ["connecting", "Camera reconnecting", "Camera reconnecting — the map may be out of date", "Connecting"],
  ];

  const utcTime = t => new Date(t).toISOString().slice(11, 19);

  // describeStatus summarises the feed for the page: the relay connection
  // comes first (without it nothing on the map changes), then the cameras.
  // level is live, connecting, stale, down or offline. lastDataAt is when the
  // page last received map data (local ms); lastDataT is the relay's own time
  // of its latest game data, which a snapshot of a stale camera does not renew.
  function describeStatus({ connection, hasSnapshot, cameras, lastDataAt, lastDataT }, wallNow, formatTime = utcTime) {
    if (connection.state !== "open") {
      const retry = connection.state === "waiting" && connection.retryAt > wallNow
        ? `Retrying in ${Math.ceil((connection.retryAt - wallNow) / 1000)} s.`
        : "Connecting…";
      if (!lastDataAt) {
        return { level: "connecting", headline: "Connecting to the live relay…", title: "Connecting to the live relay", detail: retry, pill: "Connecting" };
      }
      return {
        level: "offline",
        headline: "Relay offline",
        title: "Relay connection lost — the map is frozen",
        detail: `Showing the map as last received ${ago(wallNow - lastDataAt)}. ${retry}`,
        pill: "Offline",
      };
    }
    if (!hasSnapshot) {
      return { level: "connecting", headline: "Loading the live map…", title: "Connected — loading the map", detail: "Waiting for the relay snapshot.", pill: "Syncing" };
    }
    for (const [state, headline, title, pill] of CAMERA_PROBLEMS) {
      if (!cameras.some(camera => camera.state === state)) continue;
      const troubled = cameras
        .filter(camera => camera.state !== "live")
        .map(camera => `${camera.camera}: ${camera.detail || camera.state}`)
        .join(" · ");
      const last = lastDataT ? ` Last map data at ${formatTime(lastDataT)}.` : "";
      return { level: state, headline, title, detail: `${troubled}.${last}`, pill };
    }
    return { level: "live", headline: "Live", title: "", detail: "", pill: "Live" };
  }

  // connect keeps one socket open to url, reconnecting with backoff, and
  // reports each checked message and every connection change:
  //   onConnection({ state: "connecting" | "open" | "waiting", attempt, retryAt })
  // It returns { reconnectNow, idleFor, stop }. The environment hooks exist
  // for tests; browsers use the defaults.
  function connect(url, handlers, env = {}) {
    const {
      WebSocketImpl = root.WebSocket,
      schedule = (fn, ms) => setTimeout(fn, ms),
      cancel = id => clearTimeout(id),
      now = () => Date.now(),
      random = Math.random,
    } = env;
    let socket = null;
    let attempt = 0;
    let timer = null;
    let openedAt = 0;
    let lastMessageAt = 0;
    let stopped = false;

    const report = (state, retryAt = 0) => handlers.onConnection?.({ state, attempt, retryAt });

    function open() {
      timer = null;
      report("connecting");
      let ws;
      try {
        ws = new WebSocketImpl(url);
      } catch (error) {
        console.error("Heimdall live: cannot open the relay socket", error);
        scheduleRetry();
        return;
      }
      socket = ws;
      // A replaced socket can still deliver events (browser close() is
      // asynchronous); only the current one may touch the feed.
      ws.onopen = () => {
        if (socket !== ws) return;
        openedAt = now();
        report("open");
      };
      ws.onmessage = event => {
        if (socket !== ws || typeof event.data !== "string") return;
        lastMessageAt = now();
        try {
          const message = parseMessage(event.data);
          if (message) handlers.onMessage(message);
          else console.warn("Heimdall live: ignored a malformed relay message");
        } catch (error) {
          console.error("Heimdall live: failed to apply a relay message", error);
        }
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        detach();
        if (!stopped) scheduleRetry();
      };
    }

    // detach forgets the current socket, resetting the backoff if it had
    // been up long enough, and returns it so the caller can close it.
    function detach() {
      const ws = socket;
      socket = null;
      if (openedAt && now() - openedAt >= STABLE_MS) attempt = 0;
      openedAt = 0;
      lastMessageAt = 0;
      return ws;
    }

    function scheduleRetry() {
      const wait = retryDelay(attempt, random);
      attempt++;
      report("waiting", now() + wait);
      timer = schedule(open, wait);
    }

    // reconnectNow drops the current socket (it may be silently dead after a
    // sleep or a network change) or skips the remaining backoff, and opens a
    // fresh connection at once.
    function reconnectNow() {
      if (stopped) return;
      if (timer !== null) cancel(timer);
      detach()?.close();
      open();
    }

    // idleFor is how long an open socket has gone without a message; 0 while
    // not connected. The relay sends batches only on change, so a long
    // silence while "open" usually means the link is dead.
    function idleFor() {
      return socket && openedAt ? now() - Math.max(openedAt, lastMessageAt) : 0;
    }

    function stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
      detach()?.close();
    }

    open();
    return { reconnectNow, idleFor, stop };
  }

  const api = { DEFAULT_RELAY, STABLE_MS, relayUrl, retryDelay, parseMessage, parseLayout, syncClock, ago, describeStatus, connect };
  root.HeimdallLive = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
