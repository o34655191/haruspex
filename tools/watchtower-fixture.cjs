// Local-only UI smoke fixture. Run with node tools/watchtower-fixture.cjs,
// then open live-watch.html?relay=ws://127.0.0.1:8766/ws on localhost.
// No packages required; this server only sends small, unmasked JSON frames.
const http = require("node:http");
const { createHash } = require("node:crypto");
const server = http.createServer((req, res) => res.writeHead(404).end());
server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws" || !req.headers["sec-websocket-key"]) return socket.destroy();
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = value => {
    const body = Buffer.from(JSON.stringify(value));
    const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([header, body]));
  };
  const t = Date.now(), pos = (x, y) => x + 1000 * y;
  send({ type: "snap", t: t - (process.argv.includes("--stale") ? 3600000 : 0), mapWidth: 1000,
    players: [[0, "fixture-a", "Player A with a deliberately long name", "HOME", 472], [1, "fixture-b", "Player B", "FOREIGN", 474], [2, "fixture-c", "Player C", "OTHER", 474]],
    events: [[2, t, 0, 0, pos(480, 500), 0, Math.floor(t/1000) + 20], [2, t, 0, 1, pos(520, 500), 0, 9223372036854776000], [2, t, 0, 2, pos(500, 520), 0, 0],
      [0, t, 1, 0, 0, pos(470, 490), pos(510, 490), t, t+600000, 14, 7, 1],
      [0, t, 2, 1, 14, pos(530, 510), pos(490, 510), t, t+600000, 0, 0, 1],
      [0, t, 3, 2, 0, pos(525, 530), pos(525, 530), t-1000, t+600000, 2, 0, 2],
      [0, t, 4, 0, 1, pos(475, 530), pos(515, 530), t, t+180000, 7, 8, 2],
      [0, t, 5, 1, 1, pos(475, 515), pos(515, 515), t, t+180000, 7, 9, 2]] });
  send({ type: "status", t: 0, cameras: [{ camera: "sat01", name: "Local fixture", state: "live", area: { server: 472, left: 450, bottom: 470, right: 550, top: 550 } }] });
  const update = setTimeout(() => send({ type: "ev", t: Date.now(), events: [[2, Date.now(), 0, 0, pos(480, 500), 0, Math.floor(Date.now()/1000) + 8]] }), 25000);
  const launch = setTimeout(() => {
    const now = Date.now();
    send({type:"ev",t:now,events:[[0,now,4,0,1,pos(475,530),pos(515,530),now,now+20000,7,8,2],[1,now,5]]});
  },15000);
  socket.on("data", data => { if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
  socket.on("error", () => {});
  socket.on("close", () => { clearTimeout(update); clearTimeout(launch); });
});
server.listen(8766, "127.0.0.1", () => console.log("Watchtower fixture on ws://127.0.0.1:8766/ws"));
