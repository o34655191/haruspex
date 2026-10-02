# Watchtower map additions

The existing canvas, satellite controls, view state, connection/reconnect logic,
routes and labels are retained. Changes are in `live-watch.html`, `live-watch.js`,
`watchtower-feed.js`, and scoped additions to `watchtower.css`.

## Verified payload and transport limits

Inspected the configured live relay (`wss://heimdall.tailc3e099.ts.net/ws`) on
2026-10-02. It sends numeric event tuples and player rows; observed march types
included 0, 2, 3, 9, 11, 14 and 15. No power or hero roster is in this public
payload. Local relay source in `lastwar-client-main/internal/livemap/extract.go`
and `state.go` confirms the compact contract:

- Player: `[index, uid, name, alliance abbreviation, home server]`.
- March: `[0, t, id, player index, type, start, target, startMs, endMs,
  targetKind, team index, speed]`.
- Base: `[2, t, operation, player index, position, 0, shieldEndSeconds]`.

The recovered game client `Global/EnumType.lua` defines `NewMarchType.TRAIN = 14`
and `TrainType = {Truck = 1, Train = 2}`. `LWRailway/Train/TrainData.lua` handles
both subtypes, but the relay retains only the march type. Therefore type 14 gets
a vehicle silhouette (cargo body, cab, wheels), labelled **Truck / train**.
Ordinary marches keep their arrows. Neither a team index nor a march targeting
a truck classifies that march as a transport. Type 25 is a mummy in the march
enum; the unrelated world-point enum's Truck=25 is not used.

The relay normalizes current `type` and legacy `marchType`/`mt` fields to tuple
slot 4, and current/legacy shield names to slot 6. Those existing contracts and
the shared parser remain unchanged. We cannot safely recover the truck subtype,
cargo, actual escort, heroes or power from these tuples. The detail panel says
so instead of treating the rally/team index as an escort roster. A future relay
extension could expose the subtype and separate escort data.

## Colors, highlights and details

- Stable alliance colors use home-server + abbreviation (the feed has no
  alliance UID), preventing identical abbreviations on different servers from
  sharing overrides. Unknown home servers are not assumed foreign.
- Domestic vs Foreign mode keeps domestic alliance colors and groups known
  foreign players in red. Alliance mode colors each alliance normally.
- Valid explicit alliance override > chosen mode > neutral fallback.
- Player highlights are a separate white ring with dark backing above the
  underlying color; they never replace it. All entities belonging to each
  selected UID are highlighted. Highlights survive snapshot reindexing and can
  be removed individually or cleared together. Settings last for this page
  session, including reconnects.
- Search matches names, UIDs and abbreviations. Results are capped at 30 with a
  refine-search message. It does not hide other players or change zoom/pan.
- Tap/click base details: player, UID, alliance, home server, coordinates and
  current timed shield. March/transport details also show interpolated location,
  start/destination, type IDs, supplied speed, arrival countdown, and relay team
  ID when nonzero. No guessed power or hero values are displayed.
- Selection resolves against current feed objects, so realtime changes update
  details and removals show unavailable. Reconnect clears snapshot-local march
  selection to avoid accidentally selecting a reused index; base selection uses
  stable UID. Dragging does not trigger a selection. Escape/Close dismisses it.

## Shield calculation

Ported the semantics of `workspace/watcher/internal/codec/worldmap.go`:
field 11 is an absolute Unix timestamp in **seconds**; zero/missing,
`math.MaxInt64` and expired values mean no active timed shield. The relay reads
`protectEndTime` or the legacy `f11` and sends seconds unchanged.

Remaining time is `max(0, expirySeconds - floor(Date.now()/1000))`. No date-string
parsing or local timezone offset is involved. Unsafe integers (including the
rounded MaxInt64 sentinel), invalid values and values beyond year 9999 are
rejected; millisecond timestamps are not misinterpreted as centuries of shield.
The renderer recalculates every frame and the open panel every 250 ms. Only time
remaining is added beside shielded bases at readable zoom. Expiry removes that
text. A new base event replaces the previous expiry; older events without it
clear the shield rather than retaining stale state.

Per the follow-up request, active shields also draw a translucent blue bubble
at every zoom, with a curved reflection and blue rim. The alliance-colored base
remains visible inside it. White player-highlight rings sit outside the bubble.
The bubble and countdown disappear together when the shield expires or clears.

Unlike movement interpolation, shields deliberately do not use `feed.clockOffset`:
relay `hub.go` stamps snapshots with `h.dataT` (last observation time), which can
be stale. Using it as a current server time would extend shields after reconnect.
This matches watcher's use of the current system clock, so an inaccurate device
clock remains a limitation until the relay supplies a separate current-clock field.

## Responsive behavior and checks

Controls sit in one collapsed disclosure. They stack on phones/tablets, wrap long
names, and use 44px buttons and native touch color input. Details use a compact
desktop panel and a bottom panel capped at 45% of the map below 820px. The close
header stays visible while scrolling; map zoom controls remain accessible.

Run `node --test tests/heimdall-live.test.js tests/watchtower-feed.test.js`.
For deterministic browser checks, run `python -m http.server 8765 --bind 127.0.0.1`
and `node tools/watchtower-fixture.cjs`, then open
`http://127.0.0.1:8765/live-watch.html?relay=ws://127.0.0.1:8766/ws`.
The fixture includes three players, a transport, a normal march targeting type
14, a sentinel shield, expiry and realtime replacement, and a deliberately stale
snapshot time. It binds only to loopback and does not modify the real relay.

## Gathering, rally countdowns and restored capitol

Follow-up live inspection on 2026-10-02 confirmed stationary resource entries:
target kind 2 with identical start and destination positions and a future end
time. These now use a pickaxe marker, appear in a separate gathering count, and
show gathering time remaining in details. Outbound resource marches remain
arrows; simply reaching a destination does not invent a gathering state.

The legacy relay does not transmit `MarchStatus` (the game distinguishes
WAIT_RALLY=6, MOVING=1, COLLECTING=3). For rally types 1/41 only, the frontend
compares the supplied interval with distance divided by supplied speed. An
interval exceeding that travel time by more than max(2 seconds, 25%) is treated
as a forming rally. Live examples had 180002 ms countdown intervals, versus a
launched rally's 4172 ms interval matching 18.3576 tiles / 4.4 tiles per second.
This is a documented inference, not an explicit status field. Missing rally
speed conservatively holds at origin. Unusual terrain/path-speed discrepancies
could still require explicit backend status to resolve perfectly.

Forming rallies use an upright flag at the origin and no travel line. They do
not begin moving merely because the countdown reaches zero: a fresh travel
update starts movement, deletion removes a cancelled rally, and an elapsed
unrefreshed timer is no longer drawn. Joining armies (target kind 6) continue
moving normally. Tests cover early launch, cancellation, timer expiry, and the
live timing examples. The fixture launches one rally and cancels another after
15 seconds. Add `--stale` to the fixture command for the stale-clock shield case.

The capitol overlay reuses the earlier `heimdall.js` CAPITOL/drawCapitol geometry:
centre (500,499), 100x100 cross with 25x25 corner cutouts, central 21x21 restricted
zone, and four cannons at (+/-9,+/-9). The cross has a grey fill, dashed border,
and the existing red restricted-zone and gold capitol/cannon treatment. The
approximate season-layout capitol diamond is skipped to avoid double drawing.

Additional ideas requiring approval (not implemented): saved highlight/color
presets across visits; a searchable list of all nearby entities for crowded maps.
