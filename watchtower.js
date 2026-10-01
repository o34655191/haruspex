// Watchtower: the satellites, where their relay lives, and the small SVG
// warzone drawer the satellite list and Mission Control share. Where each
// satellite looks and how it is doing come from its relay, never from here.
(() => {
  "use strict";

  const WARZONE = 1000;
  const live = window.HeimdallLive;

  // Identities only. Sentinel is the one satellite in orbit so far.
  const SATELLITES = [
    { id: "sat01", code: "SAT 01", name: "Sentinel", live: true,
      namesake: "After ESA's Sentinel fleet, Europe's eyes on Earth. Never blinks." },
    { id: "sat02", code: "SAT 02", name: "Tycho", live: false,
      namesake: "After Tycho Brahe, who mapped the sky without a telescope. Also a fine place to get a Rocinante fixed." },
    { id: "sat03", code: "SAT 03", name: "Hayabusa", live: false,
      namesake: "After JAXA's falcon, which flew home with pieces of an asteroid. Settles for marches." },
    { id: "sat04", code: "SAT 04", name: "Leonardo", live: false,
      namesake: "After da Vinci and the ISS module that carries his name. Still sketching the launch." },
  ];

  const STATES = {
    live: "Live", moving: "Repositioning", connecting: "Connecting", stale: "Signal weak",
    down: "Disconnected", offline: "Relay offline", pad: "Not implemented",
  };

  const TONES = {
    live: "#8de0b5", moving: "#ffd166", connecting: "#ffd166", stale: "#ffd166", down: "#ff5d5d",
    offline: "#ff5d5d", pad: "#7f93a6", preview: "#a7b6ff", other: "#9db0c2",
  };

  const STRUCTURE_COLORS = { city: "#f0b35a", stronghold: "#46d6b0", tradepost: "#b99cff", outpost: "#ff8fa3", capitol: "#ffd166" };

  // relayHttp is the relay's https origin. It shares the live feed's host, so
  // ?relay=ws://localhost:8082/ws (honoured on dev hosts only) moves both.
  function relayHttp() {
    const url = new URL(live.relayUrl(location.href));
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  }

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const byId = id => SATELLITES.find(sat => sat.id === id);
  const centre = area => ({ x: (area.left + area.right) / 2, y: (area.bottom + area.top) / 2 });
  const fmtCentre = area => (area ? `${centre(area).x}, ${centre(area).y}` : "—");
  const fmtArea = area => (area ? `${area.left},${area.bottom} → ${area.right},${area.top}` : "—");
  const sameArea = (a, b) => Boolean(a && b) && a.left === b.left && a.bottom === b.bottom && a.right === b.right && a.top === b.top;
  const clock = ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function ago(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return `${seconds} s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min ago`;
  }

  // boxAt is the box of the relay's size around a centre, snapped to whole
  // blocks and kept inside the warzone: the same rule the relay enforces.
  function boxAt(cx, cy, { width, height, blockSize, warzone = WARZONE }) {
    const snap = value => Math.round(value / blockSize) * blockSize;
    const maxLeft = Math.floor((warzone - width) / blockSize) * blockSize;
    const maxBottom = Math.floor((warzone - height) / blockSize) * blockSize;
    const left = clamp(snap(cx - width / 2), 0, maxLeft);
    const bottom = clamp(snap(cy - height / 2), 0, maxBottom);
    return { left, bottom, right: left + width, top: bottom + height };
  }

  const layouts = new Map();
  // loadLayout reads a server's season structures; a server without a layout
  // file (or a page opened as file://) simply shows none.
  function loadLayout(server) {
    if (!layouts.has(server)) {
      layouts.set(server, fetch(`data/heimdall/layouts/${encodeURIComponent(server)}.json`)
        .then(response => (response.ok ? response.json() : null))
        .then(raw => live.parseLayout(raw) || { footprints: {}, structures: [] })
        .catch(error => {
          console.warn("Season layout unavailable:", error);
          return { footprints: {}, structures: [] };
        }));
    }
    return layouts.get(server);
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (parent) parent.append(node);
    return node;
  }

  // Map y runs north-up like the game, so world y=1000 is the SVG top edge.
  const rectAttrs = area => ({ x: area.left, y: WARZONE - area.top, width: area.right - area.left, height: area.top - area.bottom });

  // warzoneSvg draws the warzone grid and season structures; `detail` adds
  // half-grid lines, structure cores and axis labels for Mission Control.
  function warzoneSvg(layout, { detail = false, label = "" } = {}) {
    const svg = svgEl("svg", { viewBox: "-6 -6 1012 1012", role: "img", "aria-label": label || "Warzone map" });
    svgEl("rect", { x: 0, y: 0, width: WARZONE, height: WARZONE, fill: "#0b1018" }, svg);
    const grid = svgEl("g", { "stroke-width": detail ? 1 : 2 }, svg);
    const step = detail ? 50 : 100;
    for (let v = step; v < WARZONE; v += step) {
      const stroke = v % 100 === 0 ? "rgba(95,114,133,.28)" : "rgba(95,114,133,.12)";
      svgEl("line", { x1: v, y1: 0, x2: v, y2: WARZONE, stroke }, grid);
      svgEl("line", { x1: 0, y1: v, x2: WARZONE, y2: v, stroke }, grid);
    }
    const structures = svgEl("g", {}, svg);
    for (const s of layout.structures) {
      const print = layout.footprints[s.kind] || { core: 0, zone: 0 };
      const color = STRUCTURE_COLORS[s.kind] || "#9db0c2";
      if (s.kind === "capitol") {
        const r = detail ? 14 : 20;
        svgEl("path", { d: `M${s.x} ${WARZONE - s.y - r}l${r} ${r}l${-r} ${r}l${-r} ${-r}z`, fill: "rgba(255,209,102,.25)", stroke: color, "stroke-width": detail ? 2 : 4 }, structures);
        continue;
      }
      const zone = Math.max(print.zone, 10);
      svgEl("rect", { x: s.x - zone / 2, y: WARZONE - s.y - zone / 2, width: zone, height: zone, fill: detail ? "rgba(150,160,172,.16)" : `${color}55` }, structures);
      if (detail && print.core) {
        svgEl("rect", { x: s.x - print.core / 2, y: WARZONE - s.y - print.core / 2, width: print.core, height: print.core, fill: `${color}66`, stroke: color, "stroke-width": 1 }, structures);
      }
    }
    svgEl("rect", { x: 0, y: 0, width: WARZONE, height: WARZONE, fill: "none", stroke: "rgba(157,176,194,.45)", "stroke-width": detail ? 2 : 4 }, svg);
    if (detail) {
      for (let v = 100; v < WARZONE; v += 100) {
        svgEl("text", { x: v, y: 990, fill: "#adbdce", "font-size": 16, "text-anchor": "middle" }, svg).textContent = v;
        svgEl("text", { x: 8, y: WARZONE - v, fill: "#adbdce", "font-size": 16 }, svg).textContent = v;
      }
    }
    return svg;
  }

  // dimPathData is the warzone with a hole cut for each box (even-odd fill).
  function dimPathData(areas) {
    const holes = areas.filter(Boolean).map(area => {
      const r = rectAttrs(area);
      return `M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}z`;
    });
    return `M0 0H${WARZONE}V${WARZONE}H0z ${holes.join(" ")}`;
  }

  function dimOutside(svg, areas, opacity = 0.5) {
    return svgEl("path", { d: dimPathData(areas), "fill-rule": "evenodd", fill: `rgba(0,0,0,${opacity})`, "pointer-events": "none" }, svg);
  }

  // boxShape draws one satellite box and returns it so callers can move it.
  function boxShape(parent, area, { tone = "live", dashed = true, text = "", fill = 0.06, width = 2 } = {}) {
    const color = TONES[tone] || tone;
    const group = svgEl("g", {}, parent);
    const rect = svgEl("rect", { ...rectAttrs(area), fill: color, "fill-opacity": fill, stroke: color, "stroke-width": width, "stroke-dasharray": dashed ? "7 5" : "none", "vector-effect": "non-scaling-stroke" }, group);
    const caption = svgEl("text", { fill: color, "font-size": 22, "font-family": "ui-monospace, Consolas, monospace", "letter-spacing": 1.5 }, group);
    caption.textContent = text;
    const crosshair = svgEl("path", { stroke: color, "stroke-width": 2, fill: "none", "pointer-events": "none" }, group);
    const place = next => {
      for (const [key, value] of Object.entries(rectAttrs(next))) rect.setAttribute(key, value);
      const cx = (next.left + next.right) / 2;
      const cy = WARZONE - (next.bottom + next.top) / 2;
      crosshair.setAttribute("d", `M${cx - 12} ${cy}h24 M${cx} ${cy - 12}v24`);
      caption.setAttribute("x", next.left + 10);
      caption.setAttribute("y", WARZONE - next.top + 30);
    };
    place(area);
    return { group, rect, caption, crosshair, place };
  }

  window.Watchtower = {
    WARZONE, SATELLITES, STATES, TONES, STRUCTURE_COLORS,
    relayHttp, clamp, byId, centre, fmtCentre, fmtArea, sameArea, clock, ago, boxAt,
    loadLayout, svgEl, rectAttrs, warzoneSvg, dimPathData, dimOutside, boxShape,
  };
})();
