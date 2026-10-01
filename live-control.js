// Watchtower Mission Control: aim a satellite and send the move to its relay.
// The relay is the source of truth: GET /control/state says where the box is
// and what AWS allows; POST /control/move (with the operator key) moves it.
// The page only previews until the relay confirms.
(() => {
  "use strict";

  const W = window.Watchtower;
  const $ = id => document.getElementById(id);
  const relay = W.relayHttp();
  const KEY_STORE = "watchtower.operatorKey";
  const POLL_MS = 3000;
  const POLL_MOVING_MS = 1000;
  const LOG_LIMIT = 12;
  const QUIPS = [
    "The Outer Space Treaty has opinions.",
    "Request logged. Request ignored.",
    "Article IV says no. We read it twice.",
  ];
  const MOVE_STEPS = ["Sent to the relay", "Relay saved the new box", "Pictures from the new box"];
  const PRESETS = [["Capitol", 500, 500], ["NW", 250, 750], ["NE", 750, 750], ["SW", 250, 250], ["SE", 750, 250]];

  const sat = W.SATELLITES.find(s => s.live);
  let state = null;        // the relay's last /control/state
  let stateError = "";     // why the last poll failed
  let cooldownUntil = 0;   // local deadline from the relay's cooldownLeftMs
  let draft = null;        // { left, bottom, right, top } previewed, not sent
  let pending = null;      // { index, area } while a move is on its way
  let picker = null;
  let layout = { footprints: {}, structures: [] };
  let quip = 0;
  let log = [];
  let pollTimer = null;

  // ---- small helpers -------------------------------------------------------
  const cfg = () => ({ width: state.width, height: state.height, blockSize: state.blockSize, warzone: state.warzone });
  const isSame = () => Boolean(state && draft) && W.sameArea(draft, state.area);
  const cooldownLeft = () => Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const locked = () => !state || Boolean(pending);
  const fmtCountdown = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const where = area => `S${area.server} ${W.fmtCentre(area)}`;
  const shownState = () => (stateError ? "offline" : state ? state.state : "connecting");

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function addLog(text, tone = "") {
    log = [{ at: Date.now(), text, tone }, ...log].slice(0, LOG_LIMIT);
    renderLog();
  }

  // The key is kept for this tab only (sessionStorage): every page on the
  // site's origin could read a localStorage copy. Storage can also be
  // blocked (private windows); the key then lives only in the field.
  function storedKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
  }
  function storeKey(key) {
    try {
      if (key) sessionStorage.setItem(KEY_STORE, key);
      else sessionStorage.removeItem(KEY_STORE);
    } catch (error) {
      console.warn("Watchtower: cannot remember the key on this device", error);
    }
  }

  // ---- relay ---------------------------------------------------------------
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const response = await fetch(`${relay}/control/state`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applyState(await response.json());
      stateError = "";
    } catch (error) {
      console.warn("Watchtower: relay state unavailable", error);
      stateError = "The relay is not answering.";
    }
    render();
    pollTimer = setTimeout(poll, pending || state?.state === "moving" ? POLL_MOVING_MS : POLL_MS);
  }

  function applyState(next) {
    const first = !state;
    state = next;
    cooldownUntil = Date.now() + (next.cooldownLeftMs || 0);
    if (first || !draft) draft = { ...next.area };
    if (first) {
      addLog(next.movedAt ? `Watching ${where(next.area)} since ${W.clock(next.movedAt)}` : `Watching ${where(next.area)}`, "ok");
      W.loadLayout(next.area.server).then(loaded => { layout = loaded; picker = null; render(); });
    }
    // A move is done once the relay reports pictures from the box we sent.
    if (pending && pending.index >= 2 && next.state !== "moving" && W.sameArea(next.area, pending.area)) {
      pending = null;
      draft = { ...next.area };
      addLog(`${state.name || sat.name} is live over ${where(next.area)}`, "ok");
    }
  }

  async function applyMove() {
    const key = $("opKey").value.trim();
    if (!key || !draft || locked()) return;
    const area = { ...draft, server: state.area.server };
    pending = { index: 0, area };
    $("xyHint").textContent = "";
    render();
    let response;
    let body = {};
    try {
      response = await fetch(`${relay}/control/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ left: area.left, bottom: area.bottom }),
      });
      body = await response.json().catch(() => ({}));
    } catch (error) {
      console.warn("Watchtower: move request failed", error);
      pending = null;
      addLog("Move not sent: the relay is not answering", "bad");
      render();
      return;
    }
    if (!response.ok) {
      pending = null;
      const reason = body.error || `HTTP ${response.status}`;
      addLog(`Move refused: ${reason}`, "bad");
      if (response.status === 401) {
        $("opKey").setAttribute("aria-invalid", "true");
        storeKey(""); // a rejected key is not worth keeping
      }
      render();
      poll();
      return;
    }
    $("opKey").removeAttribute("aria-invalid");
    if ($("rememberKey").checked) storeKey(key);
    pending = { index: 2, area };
    addLog(`Move accepted · ${where(area)}`);
    applyState(body);
    render();
    poll();
  }

  // ---- picker map ------------------------------------------------------------
  function buildPicker() {
    const svg = W.warzoneSvg(layout, { detail: true, label: `Warzone S${state.area.server} with ${sat.name}'s box` });
    const dim = W.dimOutside(svg, [draft], 0.45);
    const overlays = W.svgEl("g", {}, svg);
    const box = W.boxShape(svg, draft, { tone: "preview", fill: 0.1, width: 2 });
    box.group.classList.add("drag-box");
    box.group.setAttribute("tabindex", "0");
    box.group.setAttribute("aria-label", `${sat.name} preview box. Arrow keys move it by ${state.blockSize} tiles, Shift by 100.`);
    picker = { svg, dim, overlays, box };
    $("picker").replaceChildren(svg);
    wirePicker();
  }

  function renderPicker() {
    if (!state) return;
    if (!picker) buildPicker();
    picker.dim.setAttribute("d", W.dimPathData([draft]));
    picker.overlays.replaceChildren();
    const same = isSame();
    if (!same) W.boxShape(picker.overlays, state.area, { tone: shownState(), dashed: false, fill: 0.03, width: 1, text: "NOW" });
    picker.box.place(draft);
    picker.box.caption.textContent = same ? `${sat.code} · ${state.name || sat.name}`.toUpperCase() : `${sat.code} · PREVIEW`;
    const tone = pending || state.state === "moving" ? W.TONES.moving : W.TONES.preview;
    for (const node of [picker.box.rect, picker.box.crosshair]) node.setAttribute("stroke", tone);
    picker.box.rect.setAttribute("fill", tone);
    picker.box.caption.setAttribute("fill", tone);
    $("picker").classList.toggle("is-locked", locked());
    setText($("pickerTitle"), `S${state.area.server}`);
    setText($("pickerSub"), `box ${W.fmtArea(draft)}`);
    setText($("pickerHelp"), `Box is ${state.width}×${state.height}, snaps to ${state.blockSize}-tile blocks and stays inside the warzone. Click to place, drag to adjust, arrow keys nudge.`);
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
    if (!state || locked()) return;
    draft = W.boxAt(cx, cy, cfg());
    if (!typed) $("xyHint").textContent = "";
    render(typed);
  }

  function wirePicker() {
    const { svg, box } = picker;
    let drag = null;
    svg.addEventListener("pointerdown", event => {
      if (locked()) return;
      const p = worldAt(event);
      const c = W.centre(draft);
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
      const step = event.shiftKey ? 100 : state.blockSize;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (!moves[event.key] || locked()) return;
      event.preventDefault();
      const c = W.centre(draft);
      moveDraft(c.x + moves[event.key][0], c.y + moves[event.key][1]);
    });
  }

  // ---- side panel ------------------------------------------------------------
  function renderRoster() {
    const roster = $("roster");
    if (!roster.children.length) {
      roster.append(...W.SATELLITES.map(s => {
        const button = Object.assign(document.createElement("button"), { type: "button", className: "roster-item", disabled: !s.live });
        button.append(
          Object.assign(document.createElement("span"), { className: "r-code", textContent: s.code }),
          Object.assign(document.createElement("span"), { className: "r-name", textContent: s.name }),
          document.createElement("span"),
          Object.assign(document.createElement("span"), { className: "r-where" }),
        );
        button.setAttribute("aria-pressed", String(s === sat));
        return button;
      }));
    }
    W.SATELLITES.forEach((s, index) => {
      const [, name, pill, spot] = roster.children[index].children;
      const st = s === sat ? shownState() : "pad";
      if (s === sat && state?.name) setText(name, state.name);
      pill.className = `state-pill is-${st}`;
      setText(pill, W.STATES[st]);
      setText(spot, s === sat && state ? `S${state.area.server} · ${W.fmtCentre(state.area)}` : s.live ? "" : "Not implemented");
      roster.children[index].setAttribute("aria-label", `${s.code} ${s.name}, ${W.STATES[st]}`);
    });
  }

  function renderServer() {
    if (!state) return;
    const select = $("server");
    if (select.value !== String(state.area.server)) select.replaceChildren(new Option(`S${state.area.server}`, String(state.area.server)));
    setText($("serverHint"), `Zone (${state.zoneX}, ${state.zoneY}) · set on AWS`);
  }

  function renderCentre(typed) {
    if (!draft) return;
    const c = W.centre(draft);
    for (const [id, value] of [["cx", c.x], ["cy", c.y]]) {
      const input = $(id);
      input.disabled = locked();
      // Never overwrite a field the operator is typing in.
      if (typed !== id && document.activeElement !== input) {
        input.value = value;
        input.removeAttribute("aria-invalid");
      }
    }
  }

  function renderActions() {
    const wait = cooldownLeft();
    const same = isSame();
    const invalid = ["cx", "cy"].some(id => $(id).getAttribute("aria-invalid") === "true");
    const hasKey = $("opKey").value.trim() !== "";
    const confirm = $("confirm");
    setText(confirm, pending ? "Applying…" : wait ? `Cooldown ${fmtCountdown(wait)}` : "Apply position");
    confirm.disabled = locked() || same || wait > 0 || invalid || !hasKey || state?.control === false;
    $("reset").disabled = locked() || same;
    setText($("previewChip"), pending ? "Applying position…" : same ? "Current position" : "Preview · not sent");
    $("previewChip").classList.toggle("is-same", same && !pending);
    for (const button of $("presets").children) button.disabled = locked();

    const name = state?.name || sat.name;
    const [text, tone] =
      stateError ? [`${stateError} Moves can't be sent until it is back.`, "err"]
      : !state ? ["Contacting the relay…", ""]
      : state.control === false ? ["Moving is switched off on this relay: it has no operator key file.", "err"]
      : pending ? [`Repositioning. Controls unlock when ${name} reports pictures from the new box.`, "warn"]
      : state.state === "moving" ? [`${name} is still repositioning.`, "warn"]
      : state.state === "down" || state.state === "stale" ? [`${name} is ${W.STATES[state.state].toLowerCase()}. A move is saved and used once it reconnects.`, "warn"]
      : wait ? [`Moved recently. The next move is allowed in ${fmtCountdown(wait)}.`, ""]
      : !hasKey ? ["Paste the operator key to move the satellite.", ""]
      : ["Dragging is a preview. Nothing moves until you apply.", ""];
    setText($("actionNote"), text);
    $("actionNote").className = `mc-note${tone ? ` ${tone}` : ""}`;

    const stepper = $("stepper");
    stepper.hidden = !pending;
    if (pending) {
      stepper.replaceChildren(...MOVE_STEPS.map((step, index) => {
        const item = document.createElement("li");
        item.textContent = step;
        if (index < pending.index) item.className = "done";
        if (index === pending.index) item.className = "now";
        return item;
      }));
    }
  }

  function renderConfig() {
    if (!state) return;
    const rows = [
      ["Box", `${state.width} × ${state.height} tiles`],
      ["Block size", `${state.blockSize} tiles`],
      ["Refresh", `every ${state.intervalMs} ms`],
      ["Requests per refresh", `${state.requests}`],
      ["Move cooldown", `${Math.round(state.cooldownMs / 1000)} s`],
      ["Server", `S${state.area.server}`],
    ];
    $("cfg").replaceChildren(...rows.flatMap(([term, value]) => [
      Object.assign(document.createElement("dt"), { textContent: term }),
      Object.assign(document.createElement("dd"), { textContent: value }),
    ]));
    setText($("cfgNote"), `Change these in /etc/lwlive/${state.camera}.viewport.json on AWS, then restart lwlive@${state.camera}.`);
  }

  function renderLog() {
    $("log").replaceChildren(...log.map(entry => {
      const item = document.createElement("li");
      const time = Object.assign(document.createElement("time"), { textContent: W.clock(entry.at), dateTime: new Date(entry.at).toISOString() });
      const who = Object.assign(document.createElement("span"), { className: "who", textContent: `${sat.code} ${state?.name || sat.name}` });
      const what = Object.assign(document.createElement("span"), { className: entry.tone, textContent: entry.text });
      item.append(time, who, what);
      return item;
    }));
  }

  function render(typed = null) {
    const st = shownState();
    setText($("aimTitle"), `Aim · ${sat.code} ${state?.name || sat.name}`);
    setText($("fleetSummary"), `${state?.name || sat.name}: ${W.STATES[st]} · ${W.SATELLITES.length - 1} not implemented`);
    renderRoster();
    renderPicker();
    renderServer();
    renderCentre(typed);
    renderActions();
    renderConfig();
  }

  function onCentreInput(event) {
    if (locked()) return;
    const input = event.target;
    const value = Number(input.value);
    if (input.value.trim() === "" || !Number.isInteger(value) || value < 0 || value > 999) {
      input.setAttribute("aria-invalid", "true");
      $("xyHint").textContent = `${input.id === "cx" ? "X" : "Y"} must be a whole number from 0 to 999.`;
      renderActions();
      return;
    }
    input.removeAttribute("aria-invalid");
    const x = input.id === "cx" ? value : W.centre(draft).x;
    const y = input.id === "cy" ? value : W.centre(draft).y;
    moveDraft(x, y, input.id);
    const c = W.centre(draft);
    $("xyHint").textContent = c.x === x && c.y === y ? `Box ${W.fmtArea(draft)}` : `Snapped to centre ${c.x}, ${c.y}: whole blocks, inside the warzone.`;
  }

  // ---- wiring ------------------------------------------------------------
  $("presets").replaceChildren(...PRESETS.map(([name, x, y]) => {
    const button = Object.assign(document.createElement("button"), { type: "button", textContent: name, title: `Centre ${x}, ${y}` });
    button.addEventListener("click", () => moveDraft(x, y));
    return button;
  }));
  $("cx").addEventListener("input", onCentreInput);
  $("cy").addEventListener("input", onCentreInput);
  for (const id of ["cx", "cy"]) {
    $(id).addEventListener("change", () => {
      if ($(id).getAttribute("aria-invalid") === "true") $("xyHint").textContent = "";
      $(id).removeAttribute("aria-invalid");
      render();
    });
  }
  const saved = storedKey();
  $("opKey").value = saved;
  $("rememberKey").checked = Boolean(saved);
  $("opKey").addEventListener("input", () => { $("opKey").removeAttribute("aria-invalid"); renderActions(); });
  $("rememberKey").addEventListener("change", () => storeKey($("rememberKey").checked ? $("opKey").value.trim() : ""));
  $("confirm").addEventListener("click", applyMove);
  $("reset").addEventListener("click", () => {
    if (!state) return;
    draft = { ...state.area };
    $("xyHint").textContent = "";
    render();
  });
  $("strike").addEventListener("click", () => {
    $("strikeQuip").textContent = QUIPS[quip % QUIPS.length];
    quip++;
    addLog("Orbital strike requested · denied", "bad");
  });
  // The cooldown counts down between polls.
  setInterval(() => { if (state) renderActions(); }, 1000);

  render();
  poll();
})();
