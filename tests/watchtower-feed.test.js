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
