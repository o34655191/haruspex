// Watchtower Mission Control mockup: aim a satellite by server + centre or by
// dragging its box, then confirm. Nothing leaves the page; the real page posts
// to the relay's control API, which is reachable only on the tailnet.
(() => {
  "use strict";

  const W = window.Watchtower;
  const $ = id => document.getElementById(id);
  const STEP_MS = 1300;
  const LOG_LIMIT = 12;
  const QUIPS = [
    "The Outer Space Treaty has opinions.",
    "Request logged. Request ignored.",
    "Article IV says no. We read it twice.",
  ];
  const MOVE_STEPS = ["Command sent to the relay", "Relay checked the box and saved it", "Old picture cleared", "First pictures from the new box"];
  const LAUNCH_STEPS = ["Launch command sent", "Session logging in", "Relay saved the position", "First pictures from orbit"];
  const REACQUIRE_STEPS = ["Re-login requested", "Session up", "First pictures since the outage"];
  const PRESETS = [
    ["Capitol", 500, 500], ["NW", 250, 750], ["NE", 750, 750], ["SW", 250, 250], ["SE", 750, 250],
  ];

  let fleet = W.SATELLITES.map(sat => ({ ...sat, cooldownUntil: 0 }));
  let selectedId = fleet[0].id;
  let draft = null; // { server, area } previewed on the map, not yet sent
  let picker = null;
  let layout = { footprints: {}, structures: [] };
  let quip = 0;
  const sequences = new Map(); // satellite id → { steps, index }

  const satById = id => fleet.find(sat => sat.id === id);
  const selected = () => satById(selectedId);
  const label = sat => `${sat.code} ${sat.name}`;
  const where = (server, area) => `S${server} ${W.fmtCentre(area)}`;
  const patchSat = (id, patch) => { fleet = fleet.map(sat => (sat.id === id ? { ...sat, ...patch } : sat)); };

  const drafts = new Map();
  let log = [{ at: fleet[0].movedAt, sat: label(fleet[0]), text: "Position set · " + where(fleet[0].server, fleet[0].area), tone: "ok" }];
  function addLog(sat, text, tone = "") {
    log = [{ at: Date.now(), sat: label(sat), text, tone }, ...log].slice(0, LOG_LIMIT);
  }

  // ---- state helpers -----------------------------------------------------
  const cooldownLeft = sat => Math.max(0, Math.ceil((sat.cooldownUntil - Date.now()) / 1000));
  const isSame = sat => draft.server === sat.server && W.sameArea(draft.area, sat.area);
  const locked = sat => !sat.implemented || sat.state === "moving" || sequences.has(sat.id) || draft.server == null;
  const fmtCountdown = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  function draftFor(sat) {
    return sat.area ? { server: sat.server, area: sat.area } : { server: null, area: W.boxAt(500, 500) };
  }

  // ---- picker map --------------------------------------------------------
  function buildPicker() {
    const sat = selected();
    const svg = W.warzoneSvg(layout, { detail: true, label: `Warzone S${draft.server ?? "—"} with ${sat.name}'s box` });
    const dim = W.dimOutside(svg, [draft.area], 0.45);
    const overlays = W.svgEl("g", {}, svg);
    const box = W.boxShape(svg, draft.area, { tone: "preview", fill: 0.1, width: 2 });
    box.group.classList.add("drag-box");
    box.group.setAttribute("tabindex", "0");
    box.group.setAttribute("aria-label", `${sat.name} preview box. Arrow keys move it by ${W.CONFIG.blockSize} tiles, Shift by 100.`);
    picker = { svg, dim, overlays, box, key: `${sat.id}:${draft.server}` };
    $("picker").replaceChildren(svg);
    wirePicker();
  }

  function renderPicker() {
    const sat = selected();
    if (!picker || picker.key !== `${sat.id}:${draft.server}`) buildPicker();
    picker.dim.setAttribute("d", W.dimPathData([draft.area]));
    picker.overlays.replaceChildren();
    for (const other of fleet) {
      if (other === sat || !other.area || other.server !== draft.server) continue;
      W.boxShape(picker.overlays, other.area, { tone: other.state, fill: 0, width: 1, text: label(other).toUpperCase() });
    }
    const same = isSame(sat);
    if (sat.area && sat.server === draft.server && !same) {
      W.boxShape(picker.overlays, sat.area, { tone: sat.state, dashed: false, fill: 0.03, width: 1, text: "NOW" });
    }
    picker.box.place(draft.area);
    picker.box.caption.textContent = same ? `${sat.code} · ${sat.name}`.toUpperCase() : `${sat.code} · PREVIEW`;
    const tone = sat.state === "moving" ? W.TONES.moving : W.TONES.preview;
    for (const attr of ["stroke", "fill"]) picker.box.rect.setAttribute(attr, tone);
    picker.box.caption.setAttribute("fill", tone);
    $("picker").classList.toggle("is-locked", locked(sat));
    $("pickerTitle").textContent = draft.server == null ? "No server chosen" : `S${draft.server}`;
    $("pickerSub").textContent = draft.server == null ? `choose a server to place ${sat.name}` : `box ${W.fmtArea(draft.area)}`;
    $("pickerHelp").textContent = `Box is ${W.CONFIG.boxSize}×${W.CONFIG.boxSize}, snaps to ${W.CONFIG.blockSize}-tile blocks and stays inside the warzone. Click to place, drag to adjust, arrow keys nudge.`;
  }

  function worldAt(event) {
    const point = picker.svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const p = point.matrixTransform(picker.svg.getScreenCTM().inverse());
    return { x: p.x, y: W.WARZONE - p.y };
  }

  // moveDraft previews a new centre; the X/Y hint belongs to typed input
  // only, so any other way of moving the box clears it.
  function moveDraft(cx, cy, typed = null) {
    if (!draft) return;
    draft = { ...draft, area: W.boxAt(cx, cy) };
    if (!typed) $("xyHint").textContent = "";
    render(typed);
  }

  function wirePicker() {
    const { svg, box } = picker;
    let drag = null;
    svg.addEventListener("pointerdown", event => {
      if (locked(selected())) return;
      const p = worldAt(event);
      const c = W.centre(draft.area);
      drag = box.group.contains(event.target) ? { dx: p.x - c.x, dy: p.y - c.y } : { dx: 0, dy: 0 };
      svg.setPointerCapture(event.pointerId);
      $("picker").classList.add("dragging");
      moveDraft(p.x - drag.dx, p.y - drag.dy);
    });
    svg.addEventListener("pointermove", event => {
      if (!drag) return;
      const p = worldAt(event);
      moveDraft(p.x - drag.dx, p.y - drag.dy);
    });
    const end = () => { drag = null; $("picker").classList.remove("dragging"); };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    box.group.addEventListener("keydown", event => {
      const step = event.shiftKey ? 100 : W.CONFIG.blockSize;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (!moves[event.key] || locked(selected())) return;
      event.preventDefault();
      const c = W.centre(draft.area);
      moveDraft(c.x + moves[event.key][0], c.y + moves[event.key][1]);
    });
  }

  // ---- side panel --------------------------------------------------------
  // setText writes only on change, so live regions don't re-announce and
  // focused controls survive the frequent re-renders of a drag or a burn.
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function rosterButton(sat) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "roster-item" });
    const code = Object.assign(document.createElement("span"), { className: "r-code", textContent: sat.code });
    const name = Object.assign(document.createElement("span"), { className: "r-name", textContent: sat.name });
    button.append(code, name, document.createElement("span"), Object.assign(document.createElement("span"), { className: "r-where" }));
    button.disabled = !sat.implemented;
    button.addEventListener("click", () => select(sat.id));
    return button;
  }

  // renderRoster builds the buttons once and then only updates them, so a
  // re-render never steals keyboard focus from the roster.
  function renderRoster() {
    const roster = $("roster");
    if (!roster.children.length) roster.append(...fleet.map(rosterButton));
    fleet.forEach((sat, index) => {
      const button = roster.children[index];
      const [, , pill, spot] = button.children;
      button.setAttribute("aria-pressed", String(sat.id === selectedId));
      button.setAttribute("aria-label", `${label(sat)}, ${W.STATES[sat.state].label}`);
      pill.className = `state-pill is-${sat.state}`;
      setText(pill, W.STATES[sat.state].label);
      setText(spot, sat.area ? `S${sat.server} · ${W.fmtCentre(sat.area)}` : "Not implemented");
    });
  }

  function renderServer(sat) {
    const select = $("server");
    const options = W.SERVERS.map(server => new Option(`S${server.id}`, String(server.id)));
    if (draft.server == null) options.unshift(new Option("Choose a server…", ""));
    select.replaceChildren(...options);
    select.value = draft.server == null ? "" : String(draft.server);
    select.disabled = sat.state === "moving" || sequences.has(sat.id);
    const server = W.SERVERS.find(s => s.id === draft.server);
    $("serverHint").textContent = server ? `Zone (${server.zone.join(", ")}) · ${server.sample ? "sample offset" : "from AWS"}` : "From the allowed-servers file on AWS";
  }

  function renderCentre(sat, typed) {
    const c = W.centre(draft.area);
    for (const [id, value] of [["cx", c.x], ["cy", c.y]]) {
      const input = $(id);
      input.disabled = locked(sat);
      // Never overwrite a field the operator is typing in (a burn on another
      // satellite re-renders every step).
      if (typed !== id && document.activeElement !== input) {
        input.value = value;
        input.removeAttribute("aria-invalid");
      }
    }
  }

  function renderActions(sat) {
    const wait = cooldownLeft(sat);
    const same = isSame(sat);
    const invalid = ["cx", "cy"].some(id => $(id).getAttribute("aria-invalid") === "true");
    const confirm = $("confirm");
    confirm.textContent = wait ? `Cooldown ${fmtCountdown(wait)}` : sat.state === "pad" ? "Launch" : sat.state === "down" ? "Save aim" : "Apply position";
    confirm.disabled = locked(sat) || same || wait > 0 || invalid;
    $("reset").disabled = same || sat.state === "moving" || sequences.has(sat.id);
    $("previewChip").textContent = sat.state === "moving" ? "Applying position…" : same ? "Current position" : "Preview · not sent";
    $("previewChip").classList.toggle("is-same", same);
    for (const button of $("presets").children) button.disabled = locked(sat);

    const note = $("actionNote");
    const [text, tone] =
      sat.state === "moving" ? [`Repositioning. Controls unlock when ${sat.name} reports in.`, "warn"]
      : sat.state === "down" ? [`Disconnected ${W.ago(sat.lostAt)} (${sat.lostReason}). You can still aim it: the relay keeps the box and uses it once the link is back.`, "err"]
      : sat.state === "pad" ? [`${sat.name} is on the pad. Pick a server and a box, then launch.`, ""]
      : wait ? [`Moved recently. The next move is allowed in ${fmtCountdown(wait)}.`, ""]
      : ["Dragging is a preview. Nothing moves until you confirm.", ""];
    setText(note, text);
    note.className = `mc-note${tone ? ` ${tone}` : ""}`;

    const sequence = sequences.get(sat.id);
    const stepper = $("stepper");
    stepper.hidden = !sequence;
    if (sequence) {
      stepper.replaceChildren(...sequence.steps.map((step, index) => {
        const item = document.createElement("li");
        item.textContent = step;
        if (index < sequence.index) item.className = "done";
        if (index === sequence.index) item.className = "now";
        return item;
      }));
    }
    $("reacquire").hidden = sat.state !== "down" || Boolean(sequence);
  }

  function renderConfig(sat) {
    const rows = [
      ["Box", `${W.CONFIG.boxSize} × ${W.CONFIG.boxSize} tiles`],
      ["Block size", `${W.CONFIG.blockSize} tiles`],
      ["Refresh", `every ${W.CONFIG.intervalMs} ms`],
      ["Requests per refresh", `${W.CONFIG.requestsPerRefresh}`],
      ["Move cooldown", `${W.CONFIG.cooldownS} s`],
      ["Allowed servers", W.SERVERS.map(s => s.id).join(", ")],
    ];
    $("cfg").replaceChildren(...rows.flatMap(([term, value]) => [
      Object.assign(document.createElement("dt"), { textContent: term }),
      Object.assign(document.createElement("dd"), { textContent: value }),
    ]));
    $("cfgNote").textContent = `${sat.name}: /etc/lwlive/${sat.id}.json · servers: the shared allowed-servers file. Restart lwlive@${sat.id} after editing.`;
  }

  function renderLog() {
    $("log").replaceChildren(...log.map(entry => {
      const item = document.createElement("li");
      const time = Object.assign(document.createElement("time"), { textContent: W.clock(entry.at), dateTime: new Date(entry.at).toISOString() });
      const who = Object.assign(document.createElement("span"), { className: "who", textContent: entry.sat });
      const what = Object.assign(document.createElement("span"), { className: entry.tone, textContent: entry.text });
      item.append(time, who, what);
      return item;
    }));
  }

  function renderSummary() {
    const count = state => fleet.filter(sat => sat.state === state).length;
    const parts = [[count("live"), "live"], [count("moving"), "repositioning"], [count("down"), "disconnected"], [count("pad"), "not implemented"]];
    setText($("fleetSummary"), parts.filter(([n]) => n).map(([n, text]) => `${n} ${text}`).join(" · "));
  }

  function render(typed = null) {
    const sat = selected();
    $("aimTitle").textContent = `Aim · ${label(sat)}`;
    renderRoster();
    renderPicker();
    renderServer(sat);
    renderCentre(sat, typed);
    renderActions(sat);
    renderConfig(sat);
    renderLog();
    renderSummary();
  }

  // ---- actions -----------------------------------------------------------
  function select(id) {
    if (!satById(id)?.implemented) return;
    drafts.set(selectedId, draft);
    selectedId = id;
    draft = drafts.get(id) || draftFor(selected());
    $("xyHint").textContent = "";
    render();
  }

  // runSequence walks a satellite through simulated relay steps; the real
  // page advances these from the relay's camera status instead of timers.
  function runSequence(id, steps, onDone, startIndex = 0, stepMs = STEP_MS) {
    sequences.set(id, { steps, index: startIndex });
    render();
    const tick = () => {
      const index = sequences.get(id).index + 1;
      if (index >= steps.length) {
        sequences.delete(id);
        onDone();
        if (id === selectedId) draft = draftFor(selected());
        render();
        return;
      }
      sequences.set(id, { steps, index });
      render();
      setTimeout(tick, stepMs);
    };
    setTimeout(tick, stepMs);
  }

  function confirmMove() {
    const sat = selected();
    const to = where(draft.server, draft.area);
    $("xyHint").textContent = "";
    if (sat.state === "down") {
      patchSat(sat.id, { server: draft.server, area: draft.area });
      addLog(sat, `Aim saved · ${to} · applies when the link is back`);
      render();
      return;
    }
    const launching = sat.state === "pad";
    patchSat(sat.id, {
      state: "moving", server: draft.server, area: draft.area, movedAt: Date.now(),
      previous: sat.area ? { server: sat.server, area: sat.area } : null,
    });
    addLog(sat, launching ? `Launch · → ${to}` : `Move requested · ${where(sat.server, sat.area)} → ${to}`);
    runSequence(sat.id, launching ? LAUNCH_STEPS : MOVE_STEPS, () => {
      patchSat(sat.id, { state: "live", cooldownUntil: Date.now() + W.CONFIG.cooldownS * 1000 });
      addLog(sat, launching ? "Live · first pictures received" : "Live · new box is live", "ok");
    });
  }

  function reacquire() {
    const sat = selected();
    addLog(sat, "Re-acquire requested · re-login");
    runSequence(sat.id, REACQUIRE_STEPS, () => {
      patchSat(sat.id, { state: "live", lostAt: null, lostReason: "" });
      addLog(sat, "Signal re-acquired", "ok");
    });
  }

  function onCentreInput(event) {
    const sat = selected();
    if (locked(sat)) return;
    const input = event.target;
    const value = Number(input.value);
    if (input.value.trim() === "" || !Number.isInteger(value) || value < 0 || value > 999) {
      input.setAttribute("aria-invalid", "true");
      $("xyHint").textContent = `${input.id === "cx" ? "X" : "Y"} must be a whole number from 0 to 999.`;
      renderActions(sat);
      return;
    }
    input.removeAttribute("aria-invalid");
    const x = input.id === "cx" ? value : W.centre(draft.area).x;
    const y = input.id === "cy" ? value : W.centre(draft.area).y;
    moveDraft(x, y, input.id);
    const c = W.centre(draft.area);
    $("xyHint").textContent = c.x === x && c.y === y ? `Box ${W.fmtArea(draft.area)}` : `Snapped to centre ${c.x}, ${c.y}: whole blocks, inside the warzone.`;
  }

  // ---- wiring ------------------------------------------------------------
  $("presets").replaceChildren(...PRESETS.map(([name, x, y]) => {
    const button = Object.assign(document.createElement("button"), { type: "button", textContent: name, title: `Centre ${x}, ${y}` });
    button.addEventListener("click", () => { if (draft && !locked(selected())) moveDraft(x, y); });
    return button;
  }));
  $("server").addEventListener("change", event => {
    draft = { ...draft, server: event.target.value ? Number(event.target.value) : null };
    render();
  });
  $("cx").addEventListener("input", onCentreInput);
  $("cy").addEventListener("input", onCentreInput);
  // On blur the field snaps back to the box's real centre, so an error
  // about the abandoned value no longer applies.
  for (const id of ["cx", "cy"]) {
    $(id).addEventListener("change", () => {
      if ($(id).getAttribute("aria-invalid") === "true") $("xyHint").textContent = "";
      $(id).removeAttribute("aria-invalid");
      render();
    });
  }
  $("confirm").addEventListener("click", confirmMove);
  $("reset").addEventListener("click", () => { draft = draftFor(selected()); $("xyHint").textContent = ""; render(); });
  $("reacquire").addEventListener("click", reacquire);
  $("strike").addEventListener("click", () => {
    $("strikeQuip").textContent = QUIPS[quip % QUIPS.length];
    quip++;
    addLog(selected(), "Orbital strike requested · denied", "bad");
    renderLog();
  });
  // Tick while any cooldown runs, plus once after the last one ends so
  // Confirm unlocks without waiting for another interaction.
  let cooling = false;
  setInterval(() => {
    const active = fleet.some(sat => cooldownLeft(sat) > 0);
    if (draft && (active || cooling)) renderActions(selected());
    cooling = active;
  }, 1000);

  W.loadLayout().then(loaded => {
    layout = loaded;
    draft = draftFor(selected());
    render();
    // Tycho is mid-burn when the page opens; let it report in like the
    // watch-page mock does.
    const burning = fleet.find(sat => sat.state === "moving");
    if (burning) {
      runSequence(burning.id, MOVE_STEPS, () => {
        patchSat(burning.id, { state: "live", cooldownUntil: Date.now() + W.CONFIG.cooldownS * 1000 });
        addLog(burning, "Live · new box is live", "ok");
      }, 2, 3200);
    }
  });
})();
