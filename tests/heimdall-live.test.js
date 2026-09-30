// Run with: node --test "tests/*.test.js"
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const live = require("../heimdall-live.js");

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  close() { this.closed = true; this.onclose?.(); }
  serverOpen() { this.onopen?.(); }
  serverSend(data) { this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) }); }
  serverClose() { this.onclose?.(); }
}

function harness() {
  FakeSocket.instances = [];
  const clock = { now: 1000 };
  const timers = new Map();
  let nextTimer = 1;
  const seen = { messages: [], states: [] };
  const env = {
    WebSocketImpl: FakeSocket,
    schedule: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock.now + ms, ms }); return id; },
    cancel: id => timers.delete(id),
    now: () => clock.now,
    random: () => 0,
  };
  const fire = () => {
    const [id, timer] = [...timers][0];
    timers.delete(id);
    clock.now = timer.at;
    timer.fn();
    return timer.ms;
  };
  const handlers = {
    onMessage: message => seen.messages.push(message),
    onConnection: change => seen.states.push(change.state),
  };
  const socket = () => FakeSocket.instances.at(-1);
  return { clock, timers, seen, env, fire, handlers, socket };
}

test("relayUrl uses the public relay unless a local dev page overrides it", () => {
  const relay = live.DEFAULT_RELAY;
  assert.equal(live.relayUrl("https://o34655191.github.io/haruspex/heimdall.html?live"), relay);
  assert.equal(live.relayUrl("https://o34655191.github.io/heimdall.html?live&relay=wss://evil.example/ws"), relay);
  assert.equal(live.relayUrl("http://localhost:8000/heimdall.html?live&relay=ws://127.0.0.1:8082/ws"), "ws://127.0.0.1:8082/ws");
  assert.equal(live.relayUrl("http://127.0.0.1:8000/heimdall.html?live&relay=wss://heimdall.tailc3e099.ts.net/ws"), relay);
  assert.equal(live.relayUrl("http://localhost:8000/heimdall.html?live&relay=http://127.0.0.1:8082/ws"), relay);
  assert.equal(live.relayUrl("http://localhost:8000/heimdall.html?live&relay=not a url"), relay);
  assert.equal(live.relayUrl("http://[::1]:8000/heimdall.html?live&relay=ws://[::1]:8082/ws"), "ws://[::1]:8082/ws");
  assert.equal(live.relayUrl("http://localhost.evil.com/heimdall.html?live&relay=ws://evil.com/ws"), relay);
});

test("retryDelay doubles from one second, caps at thirty and keeps half as a floor", () => {
  assert.equal(live.retryDelay(0, () => 1), 1000);
  assert.equal(live.retryDelay(3, () => 1), 8000);
  assert.equal(live.retryDelay(20, () => 1), 30000);
  assert.equal(live.retryDelay(20, () => 0), 15000);
  assert.equal(live.retryDelay(-4, () => 0), 500);
});

test("parseMessage rejects frames that are not relay messages", () => {
  assert.equal(live.parseMessage("not json"), null);
  assert.equal(live.parseMessage("null"), null);
  assert.equal(live.parseMessage(JSON.stringify({ type: "hello" })), null);
});

test("parseMessage keeps well-formed rows, events and cameras and drops the rest", () => {
  const message = live.parseMessage(JSON.stringify({
    type: "snap",
    t: 1790000000000,
    mapWidth: 1000,
    players: [[0, "1000472", "Ann", "ABC", 472], [-1, "x"], ["1", "y"], [2, 9, null, undefined, "472"]],
    events: [
      [2, 1790000000000, 0, 0, 250300, 0, 1790003600],
      [0, 1, 2, 0, 1, 10, 20, 0, 1000, 1, 0, 0.5],
      [0, 1, 2],
      [1, 1, 5],
      [1, 1, "5"],
      [9, 1, 1, 1, 1],
      "junk",
    ],
    cameras: [{ camera: "se", state: "live" }, { camera: "nw", state: "exploded", detail: 7 }, { state: "live" }],
  }));
  assert.equal(message.type, "snap");
  assert.equal(message.t, 1790000000000);
  assert.equal(message.mapWidth, 1000);
  assert.deepEqual(message.players, [
    { index: 0, uid: "1000472", name: "Ann", abbr: "ABC", server: 472 },
    { index: 2, uid: "9", name: "", abbr: "", server: 0 },
  ]);
  assert.deepEqual(message.events.map(event => event[0]), [2, 0, 1]);
  assert.deepEqual(message.cameras, [
    { camera: "se", state: "live", detail: "", area: null },
    { camera: "nw", state: "down", detail: "", area: null },
  ]);
});

test("parseMessage keeps a camera's area only when it is a real rectangle", () => {
  const areaOf = area => live.parseMessage(JSON.stringify({ type: "status", cameras: [{ camera: "se", state: "live", area }] })).cameras[0].area;
  assert.deepEqual(areaOf({ server: 472, left: 0, bottom: 300, right: 500, top: 900 }), { server: 472, left: 0, bottom: 300, right: 500, top: 900 });
  assert.deepEqual(areaOf({ left: 1, bottom: 1, right: 2, top: 2 }), { server: 0, left: 1, bottom: 1, right: 2, top: 2 }, "server is optional");
  assert.equal(areaOf({ server: 472, left: 500, bottom: 300, right: 500, top: 900 }), null, "empty width");
  assert.equal(areaOf({ server: 472, left: 0, bottom: 900, right: 500, top: 300 }), null, "upside down");
  assert.equal(areaOf({ server: 472, left: -1, bottom: 0, right: 5, top: 5 }), null);
  assert.equal(areaOf({ server: 472, left: 0, bottom: 0, right: 1e9, top: 5 }), null);
  assert.equal(areaOf({ server: 472, left: "0", bottom: 0, right: 5, top: 5 }), null);
  assert.equal(areaOf("0,0,5,5"), null);
});

test("parseMessage drops rows without a uid and indices past the cap", () => {
  const message = live.parseMessage(JSON.stringify({
    type: "ev",
    players: [[99999, "u1", "A", "B", 1], [100000, "u2"], [3, ""], [4, { nested: [1] }, "n"], [5.5, "u3"]],
  }));
  assert.deepEqual(message.players.map(row => row.index), [99999]);
});

test("parseMessage drops events whose positions are off any real map", () => {
  const message = live.parseMessage(JSON.stringify({
    type: "ev",
    events: [
      [2, 1, 0, 1, 999999, 0, 0],
      [2, 1, 0, 1, -1, 0, 0],
      [2, 1, 0, 1, 1e21, 0, 0],
      [2, 1, 0, 1, 10.5, 0, 0],
      [0, 1, 2, 0, 1, 10, 20000000, 0, 1000, 1, 0, 0.5],
      [0, 1, 2, 0, 1, 10, 20, 0, 1000, 1, 0, 0.5],
    ],
  }));
  assert.deepEqual(message.events.map(event => [event[0], event[4]]), [[2, 999999], [0, 1]]);
});

test("parseMessage rejects a top-level array and ignores a bad clock", () => {
  assert.equal(live.parseMessage("[1,2]"), null);
  assert.equal(live.parseMessage(JSON.stringify({ type: "ev", t: "soon" })).t, 0);
  assert.equal(live.parseMessage(JSON.stringify({ type: "ev", t: -5 })).t, 0);
});

test("parseMessage defaults a missing clock and map width to zero", () => {
  const message = live.parseMessage(JSON.stringify({ type: "status", cameras: [] }));
  assert.equal(message.t, 0);
  assert.equal(message.mapWidth, 0);
  assert.deepEqual(message.events, []);
});

test("syncClock takes a snapshot's clock and otherwise only moves forward", () => {
  assert.equal(live.syncClock(null, { type: "ev", t: 0 }, 100), null);
  assert.equal(live.syncClock(null, { type: "status", t: 5000 }, 1000), 4000);
  assert.equal(live.syncClock(4000, { type: "status", t: 3000 }, 1000), 4000, "an old data time does not rewind");
  assert.equal(live.syncClock(4000, { type: "ev", t: 9000 }, 1000), 8000);
  assert.equal(live.syncClock(4000, { type: "snap", t: 1500 }, 1000), 500, "a new snapshot resets the clock");
});

test("ago rounds to the largest sensible unit", () => {
  assert.equal(live.ago(-5), "just now");
  assert.equal(live.ago(1999), "just now");
  assert.equal(live.ago(12000), "12 s ago");
  assert.equal(live.ago(125000), "2 min ago");
  assert.equal(live.ago(7300000), "2 h ago");
});

test("describeStatus reports the relay connection before the cameras", () => {
  const cameras = [{ camera: "se", state: "down", detail: "login failed" }];
  const first = live.describeStatus({ connection: { state: "connecting" }, hasSnapshot: false, cameras, lastDataAt: 0 }, 1000);
  assert.equal(first.level, "connecting");
  assert.equal(first.detail, "Connecting…");
  const lost = live.describeStatus({ connection: { state: "waiting", retryAt: 9500 }, hasSnapshot: true, cameras, lastDataAt: 1000 }, 5000);
  assert.equal(lost.level, "offline");
  assert.equal(lost.detail, "Showing the map as last received 4 s ago. Retrying in 5 s.");
  const syncing = live.describeStatus({ connection: { state: "open" }, hasSnapshot: false, cameras, lastDataAt: 1000 }, 5000);
  assert.equal(syncing.pill, "Syncing");
});

test("describeStatus ranks camera trouble down, stale, then connecting", () => {
  const status = cameras => live.describeStatus({
    connection: { state: "open" }, hasSnapshot: true, cameras, lastDataAt: 31000, lastDataT: Date.UTC(2026, 8, 30, 5, 54, 14),
  }, 31000);
  assert.equal(status([]).level, "live");
  assert.equal(status([{ camera: "se", state: "live", detail: "" }]).level, "live");
  const stale = status([
    { camera: "nw", state: "connecting", detail: "" },
    { camera: "se", state: "stale", detail: "session ended; reconnecting in 5s" },
  ]);
  assert.equal(stale.level, "stale");
  assert.equal(stale.detail, "nw: connecting · se: session ended; reconnecting in 5s. Last map data at 05:54:14.");
  const custom = live.describeStatus({
    connection: { state: "open" }, hasSnapshot: true, cameras: [{ camera: "se", state: "down", detail: "" }], lastDataAt: 0, lastDataT: 0,
  }, 0, () => "never");
  assert.equal(custom.detail, "se: down.", "no data time means no suffix");
  assert.equal(status([{ camera: "se", state: "stale", detail: "" }, { camera: "nw", state: "down", detail: "" }]).level, "down");
  assert.equal(status([{ camera: "se", state: "connecting", detail: "" }]).pill, "Connecting");
});

test("connect opens at once and hands over checked messages", () => {
  const h = harness();
  live.connect("ws://relay/ws", h.handlers, h.env);
  assert.equal(h.socket().url, "ws://relay/ws");
  h.socket().serverOpen();
  h.socket().serverSend({ type: "ev", t: 5, events: [[1, 5, 3]] });
  h.socket().serverSend("{broken");
  assert.deepEqual(h.seen.states, ["connecting", "open"]);
  assert.equal(h.seen.messages.length, 1);
  assert.deepEqual(h.seen.messages[0].events, [[1, 5, 3]]);
});

test("connect keeps delivering after a handler throws", () => {
  const h = harness();
  let calls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    live.connect("ws://relay/ws", { onMessage: () => { calls++; throw new Error("boom"); } }, h.env);
    h.socket().serverOpen();
    h.socket().serverSend({ type: "ev" });
    h.socket().serverSend({ type: "ev" });
  } finally {
    console.error = originalError;
  }
  assert.equal(calls, 2);
});

test("connect backs off after short connections and resets after a stable one", () => {
  const h = harness();
  live.connect("ws://relay/ws", h.handlers, h.env);
  h.socket().serverClose();
  assert.equal(h.fire(), 500);
  h.socket().serverOpen();
  h.socket().serverClose();
  assert.equal(h.fire(), 1000);
  h.socket().serverClose();
  assert.equal(h.fire(), 2000);
  h.socket().serverOpen();
  h.clock.now += live.STABLE_MS;
  h.socket().serverClose();
  assert.equal(h.fire(), 500);
  assert.equal(FakeSocket.instances.length, 5);
  assert.ok(h.seen.states.includes("waiting"));
});

test("reconnectNow skips the wait, and stop closes without reconnecting", () => {
  const h = harness();
  const feed = live.connect("ws://relay/ws", h.handlers, h.env);
  h.socket().serverClose();
  assert.equal(h.timers.size, 1);
  feed.reconnectNow();
  assert.equal(h.timers.size, 0);
  assert.equal(FakeSocket.instances.length, 2);
  const current = h.socket();
  feed.stop();
  assert.ok(current.closed);
  assert.equal(h.timers.size, 0);
  assert.equal(FakeSocket.instances.length, 2);
  feed.reconnectNow();
  assert.equal(FakeSocket.instances.length, 2, "a stopped feed stays stopped");
});

test("reconnectNow replaces a possibly dead open socket at once", () => {
  const h = harness();
  const feed = live.connect("ws://relay/ws", h.handlers, h.env);
  const dead = h.socket();
  dead.serverOpen();
  feed.reconnectNow();
  assert.ok(dead.closed);
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(h.timers.size, 0, "the replaced socket's close does not schedule a retry");
  dead.serverSend({ type: "ev", events: [[1, 1, 1]] });
  dead.serverOpen();
  assert.equal(h.seen.messages.length, 0, "late events from the old socket are ignored");
  assert.deepEqual(h.seen.states, ["connecting", "open", "connecting"]);
});

test("idleFor measures silence on an open socket only", () => {
  const h = harness();
  const feed = live.connect("ws://relay/ws", h.handlers, h.env);
  assert.equal(feed.idleFor(), 0, "not open yet");
  h.socket().serverOpen();
  h.clock.now += 4000;
  assert.equal(feed.idleFor(), 4000);
  h.socket().serverSend({ type: "status", cameras: [] });
  h.clock.now += 1500;
  assert.equal(feed.idleFor(), 1500);
  h.socket().serverSend(new Uint8Array([1]));
  assert.equal(h.seen.messages.length, 1, "binary frames are ignored");
  h.socket().serverClose();
  assert.equal(feed.idleFor(), 0, "closed");
});

test("a waiting retry reports when it will fire", () => {
  const h = harness();
  const changes = [];
  live.connect("ws://relay/ws", { onMessage() {}, onConnection: change => changes.push(change) }, h.env);
  h.socket().serverClose();
  assert.deepEqual(changes.at(-1), { state: "waiting", attempt: 1, retryAt: h.clock.now + 500 });
});

test("connect retries when the socket cannot even be constructed", () => {
  const h = harness();
  const originalError = console.error;
  console.error = () => {};
  try {
    live.connect("ws://relay/ws", h.handlers, { ...h.env, WebSocketImpl: class { constructor() { throw new Error("blocked"); } } });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(h.seen.states, ["connecting", "waiting"]);
  assert.equal(h.timers.size, 1);
});
