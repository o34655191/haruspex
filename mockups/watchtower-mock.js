// Watchtower mockups: sample satellites, the AWS-side camera config and a
// small SVG warzone drawer shared by the list and Mission Control pages.
// Everything here is sample data; the real pages will read it from the relay.
(() => {
  "use strict";

  const WARZONE = 1000;
  const NOW = Date.now();
  const MINUTE = 60000;

  // Owned by AWS (/etc/lwlive/<id>.json); the site only displays it.
  const CONFIG = { boxSize: 500, blockSize: 25, intervalMs: 500, requestsPerRefresh: 4, cooldownS: 60 };

  // One allowed-servers file shared by every satellite. Offsets other than
  // 472's are placeholders until the real ones are supplied.
  const SERVERS = [
    { id: 472, zone: [0, 1000], sample: false },
    { id: 474, zone: [1000, 1000], sample: true },
    { id: 476, zone: [2000, 1000], sample: true },
    { id: 421, zone: [0, 0], sample: true },
  ];

  const STATES = {
    live: { label: "Live", line: "Live pictures" },
    moving: { label: "Repositioning", line: "Repositioning" },
    down: { label: "Disconnected", line: "Reconnecting" },
    pad: { label: "Not implemented", line: "Future camera" },
  };

  const TONES = { live: "#8de0b5", moving: "#ffd166", down: "#ff5d5d", pad: "#7f93a6", preview: "#a7b6ff", other: "#9db0c2" };

  const SATELLITES = [
    {
      id: "sat01", code: "SAT 01", name: "Sentinel", state: "live", server: 472,
      area: { left: 0, bottom: 500, right: 500, top: 1000 },
      previous: { server: 472, area: { left: 250, bottom: 250, right: 750, top: 750 } },
      movedAt: NOW - 3 * MINUTE, bases: 1116, marches: 71, viewers: 6,
      namesake: "After ESA's Sentinel fleet, Europe's eyes on Earth. Never blinks.",
    },
    {
      id: "sat02", code: "SAT 02", name: "Tycho", state: "moving", server: 474,
      area: { left: 250, bottom: 250, right: 750, top: 750 },
      previous: { server: 474, area: { left: 500, bottom: 0, right: 1000, top: 500 } },
      movedAt: NOW - 20000, bases: 0, marches: 0, viewers: 2,
      namesake: "After Tycho Brahe, who mapped the sky without a telescope. Also a fine place to get a Rocinante fixed.",
    },
    {
      id: "sat03", code: "SAT 03", name: "Hayabusa", state: "down", server: 472,
      area: { left: 500, bottom: 0, right: 1000, top: 500 },
      lostAt: NOW - 17 * MINUTE, lostReason: "login rejected", movedAt: NOW - 95 * MINUTE,
      bases: 842, marches: 0, viewers: 1,
      namesake: "After JAXA's falcon, which flew home with pieces of an asteroid. Settles for marches.",
    },
    {
      id: "sat04", code: "SAT 04", name: "Leonardo", state: "pad", server: null, area: null, viewers: 0,
      namesake: "After da Vinci and the ISS module that carries his name. Still sketching the launch.",
    },
  ];

  // Future cameras are identities only, never simulated operational feeds.
  SATELLITES.forEach((sat, index) => {
    sat.implemented = index === 0;
    if (!sat.implemented) Object.assign(sat, {
      state: "pad", server: null, area: null, previous: null,
      bases: 0, marches: 0, viewers: 0,
    });
  });

  const STRUCTURE_COLORS = { city: "#f0b35a", stronghold: "#46d6b0", tradepost: "#b99cff", outpost: "#ff8fa3", capitol: "#ffd166" };

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const byId = id => SATELLITES.find(sat => sat.id === id);
  const centre = area => ({ x: (area.left + area.right) / 2, y: (area.bottom + area.top) / 2 });
  const fmtCentre = area => (area ? `${centre(area).x}, ${centre(area).y}` : "—");
  const fmtArea = area => (area ? `${area.left},${area.bottom} → ${area.right},${area.top}` : "—");
  const sameArea = (a, b) => Boolean(a && b) && a.left === b.left && a.bottom === b.bottom;
  const clock = ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function ago(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return `${seconds} s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min ago`;
  }

  // boxAt returns the satellite box around a centre: snapped to whole blocks
  // and kept inside the warzone, the same rule the relay will enforce.
  function boxAt(cx, cy, size = CONFIG.boxSize, block = CONFIG.blockSize) {
    const snap = value => Math.round(value / block) * block;
    const left = clamp(snap(cx - size / 2), 0, WARZONE - size);
    const bottom = clamp(snap(cy - size / 2), 0, WARZONE - size);
    return { left, bottom, right: left + size, top: bottom + size };
  }

  let layoutPromise = null;
  // loadLayout reads the Season 6 structures. Every sample server reuses
  // 472's layout; without HTTP (file://) the maps simply show no structures.
  function loadLayout() {
    layoutPromise ||= fetch("../data/heimdall/layouts/472.json")
      .then(response => (response.ok ? response.json() : null))
      .then(json => ({
        footprints: json?.footprints || {},
        structures: (json?.structures || []).map(([kind, name, level, x, y]) => ({ kind, name, level, x, y })),
      }))
      .catch(error => {
        console.warn("Season layout unavailable:", error);
        return { footprints: {}, structures: [] };
      });
    return layoutPromise;
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
  // half-grid lines and structure cores for the larger Mission Control map.
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
        const x = svgEl("text", { x: v, y: 990, fill: "#adbdce", "font-size": 16, "text-anchor": "middle" }, svg);
        x.textContent = v;
        const y = svgEl("text", { x: 8, y: WARZONE - v, fill: "#adbdce", "font-size": 16 }, svg);
        y.textContent = v;
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

  // dimOutside darkens everything a set of boxes does not cover.
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
      const cx = (next.left + next.right) / 2, cy = WARZONE - (next.bottom + next.top) / 2;
      crosshair.setAttribute("d", `M${cx-12} ${cy}h24 M${cx} ${cy-12}v24`);
      caption.setAttribute("x", next.left + 10);
      caption.setAttribute("y", WARZONE - next.top + 30);
    };
    place(area);
    return { group, rect, caption, place };
  }

  window.Watchtower = {
    WARZONE, CONFIG, SERVERS, STATES, TONES, SATELLITES, STRUCTURE_COLORS,
    clamp, byId, centre, fmtCentre, fmtArea, sameArea, clock, ago, boxAt,
    loadLayout, svgEl, rectAttrs, warzoneSvg, dimPathData, dimOutside, boxShape,
  };
})();
