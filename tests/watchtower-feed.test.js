"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const live = require("../heimdall-live.js");
const feedModel = require("../watchtower-feed.js");

const message = raw => live.parseMessage(JSON.stringify(raw));
const pos = (x, y) => x + 1000 * y;

test("a snapshot replaces the feed and later batches change it", () => {
  const feed = feedModel.createFeed();
  feed.bases.set(99, { player: 99, pos: 1, shieldEnd: 0 }); // left over from before a reconnect
  feedModel.applyMessage(feed, message({
    type: "snap", t: 5000, mapWidth: 1000,
    players: [[0, "1000472", "Ann", "ABC", 472], [1, "2000474", "Bo", "", 474]],
    events: [
      [2, 5000, 0, 0, pos(10, 20), 0, 1790000000],
      [2, 5000, 0, 1, pos(30, 40), 0, 0],
      [0, 5000, 7, 0, 1, pos(10, 20), pos(50, 20), 4000, 8000, 14, 0, 1.5],
    ],
  }), 1000);
  assert.equal(feed.hasSnapshot, true);
  assert.deepEqual([...feed.bases.keys()].sort(), [0, 1]);
  assert.equal(feed.players[0].name, "Ann");
  assert.equal(feed.marches.get(7).target, pos(50, 20));
  assert.equal(feed.clockOffset, 4000);
  assert.equal(feed.lastDataT, 5000);

  feedModel.applyMessage(feed, message({ type: "ev", t: 6000, events: [[2, 6000, 3, 1, pos(30, 40), 0, 0], [1, 6000, 7]] }), 2000);
  assert.deepEqual([...feed.bases.keys()], [0]);
  assert.equal(feed.marches.size, 0);
  assert.equal(feed.lastDataAt, 2000);
});

test("status messages set the cameras without counting as map data", () => {
  const feed = feedModel.createFeed();
  feedModel.applyMessage(feed, message({
    type: "status", t: 0,
    cameras: [{ camera: "sat01", name: "Sentinel", state: "moving", movedAt: 1790000000000,
      area: { server: 472, left: 0, bottom: 500, right: 500, top: 1000 } }],
  }), 1000);
  const camera = feedModel.cameraFor(feed, "sat01");
  assert.equal(camera.state, "moving");
  assert.equal(camera.area.bottom, 500);
  assert.equal(feedModel.cameraFor(feed, "sat02"), null);
  assert.equal(feed.lastDataAt, 0);
});

test("marchPoint interpolates on the relay clock and stops at the target", () => {
  const march = { start: pos(0, 0), target: pos(100, 50), startMs: 1000, endMs: 3000 };
  assert.deepEqual(feedModel.marchPoint(march, 2000, 1000), { x: 50, y: 25, tx: 100, ty: 50, progress: 0.5 });
  assert.equal(feedModel.marchPoint(march, 9000, 1000).x, 100);
  assert.equal(feedModel.marchPoint(march, 0, 1000).x, 0);
  assert.equal(feedModel.marchPoint({ ...march, endMs: 1000 }, 2000, 1000).progress, 0);
});

test("sideOf splits home, foreign and unaffiliated players", () => {
  assert.equal(feedModel.sideOf({ abbr: "ABC", server: 472 }, 472), "home");
  assert.equal(feedModel.sideOf({ abbr: "ABC", server: 474 }, 472), "foreign");
  assert.equal(feedModel.sideOf({ abbr: "", server: 472 }, 472), "none");
  assert.equal(feedModel.sideOf(undefined, 472), "none");
});

test("sameArea compares every edge", () => {
  const a = { server: 472, left: 0, bottom: 0, right: 500, top: 500 };
  assert.equal(feedModel.sameArea(a, { ...a }), true);
  assert.equal(feedModel.sameArea(a, { ...a, top: 525 }), false);
  assert.equal(feedModel.sameArea(a, null), false);
});

test("shield uses absolute seconds, ignores sentinels, and expires without another event", () => {
  const now = Date.UTC(2026, 9, 2, 12);
  const end = now / 1000 + 3;
  assert.equal(feedModel.shieldRemaining(end, now), 3);
  assert.equal(feedModel.shieldRemaining(end, now + 2000), 1);
  assert.equal(feedModel.shieldRemaining(end, now + 3000), 0);
  for (const missing of [undefined, null, 0, -1, NaN, Infinity, Number(9223372036854775807n), end * 1000]) {
    assert.equal(feedModel.shieldRemaining(missing, now), 0);
  }
});

test("base updates replace shield expiry, including older tuples without a shield", () => {
  const feed = feedModel.createFeed(), now = 1790940000000;
  const send = events => feedModel.applyMessage(feed, message({ type: "ev", t: now, events }), now);
  send([[2, now, 0, 1, 1001, 0, now / 1000 + 10]]);
  assert.equal(feedModel.shieldRemaining(feed.bases.get(1).shieldEnd, now), 10);
  send([[2, now, 0, 1, 2002, 0, now / 1000 + 60]]);
  assert.equal(feedModel.shieldRemaining(feed.bases.get(1).shieldEnd, now), 60);
  send([[2, now, 0, 1, 2002]]);
  assert.equal(feed.bases.get(1).shieldEnd, 0);
});

test("foreign alliance overrides beat the mode; domestic alliances keep stable colors", () => {
  const a = { abbr: "AAA", server: 472 }, b = { abbr: "BBB", server: 472 };
  const foreign = { abbr: "AAA", server: 474 }, other = { abbr: "CCC", server: 474 };
  const overrides = new Map();
  const color = (p, mode = "domestic") => feedModel.playerColor(p, 472, mode, overrides);
  assert.notEqual(color(a), color(b));
  assert.equal(color(foreign), color(other));
  assert.equal(color(a), color(a, "alliance"));
  overrides.set(feedModel.allianceKey(foreign), "#123abc");
  assert.equal(color(foreign), "#123abc");
  assert.equal(color(foreign, "alliance"), "#123abc");
  assert.equal(color(other), "#ff5d5d");
  assert.notEqual(color(a), "#123abc");
  overrides.delete(feedModel.allianceKey(foreign));
  assert.equal(color(foreign), "#ff5d5d");
  assert.equal(color(undefined), "#8a96a3");
  assert.notEqual(color({ abbr: "AAA", server: 0 }), "#ff5d5d");
});

test("transport classification uses entity type, never protecting team or attack target", () => {
  assert.equal(feedModel.isTransport({ type: 14, team: 0 }), true);
  assert.equal(feedModel.entityKind({ type: 14 }), "Truck / train");
  assert.equal(feedModel.isTransport({ type: 0, team: 14, targetKind: 14 }), false);
  assert.equal(feedModel.isTransport({ type: 25 }), false); // mummy, not WorldPointType.Truck
  assert.equal(feedModel.isTransport({ type: 999 }), false);
});

test("live rally countdown stays at origin; launched update supplies actual travel", () => {
  // Captured live 2026-10-02: the waiting timer is 180002 ms; launched
  // movement is 4172 ms over sqrt(16^2 + 9^2) tiles at 4.4 tiles/s.
  const rally = { type: 1, start: 596264, target: 605248, speed: 4.4,
    startMs: 1790943156167, endMs: 1790943336169 };
  assert.equal(feedModel.marchState(rally, rally.startMs + 90000, 1000), "rally-waiting");
  assert.equal(feedModel.marchPoint(rally, rally.startMs + 170000, 1000).progress, 0);
  assert.equal(feedModel.marchPoint(rally, rally.endMs + 1000, 1000).progress, 0);
  assert.equal(feedModel.marchState(rally, rally.endMs, 1000), "expired");
  const launched = { ...rally, startMs: 1790943329111, endMs: 1790943333283 };
  assert.equal(feedModel.marchState(launched, launched.startMs + 2086, 1000), "moving");
  assert.equal(feedModel.marchPoint(launched, launched.startMs + 2086, 1000).progress, 0.5);
  assert.equal(feedModel.rallyWaiting({ ...rally, type: 41 }, 1000), true);
  assert.equal(feedModel.rallyWaiting({ ...rally, type: 0, targetKind: 6 }, 1000), false);
});

test("rally updates launch early and deletes remove cancelled rallies", () => {
  const feed = feedModel.createFeed();
  feedModel.applyEvent(feed, [0, 1000, 1, 0, 1, 1001, 1011, 1000, 181000, 7, 5, 2]);
  assert.equal(feedModel.marchState(feed.marches.get(1), 2000, 1000), "rally-waiting");
  feedModel.applyEvent(feed, [0, 2000, 1, 0, 1, 1001, 1011, 2000, 7000, 7, 5, 2]);
  assert.equal(feedModel.marchPoint(feed.marches.get(1), 4500, 1000).progress, 0.5);
  feedModel.applyEvent(feed, [1, 5000, 1]);
  assert.equal(feed.marches.size, 0);
});

test("resource gathering is stationary at the tile, not an outbound army or inferred on arrival", () => {
  const gathering = {type: 0, targetKind: 2, start: 435413, target: 435413,
    startMs: 1000, endMs: 100000, speed: 1.99};
  assert.equal(feedModel.marchState(gathering, 5000, 1000), "gathering");
  assert.equal(feedModel.marchPoint(gathering, 5000, 1000).x, 413);
  assert.equal(feedModel.marchState({...gathering, start: 435400}, 5000, 1000), "moving");
  assert.equal(feedModel.marchState({...gathering, targetKind: 3}, 5000, 1000), "moving");
  assert.equal(feedModel.marchState(gathering, 100000, 1000), "expired");
});
