#!/usr/bin/env python3
"""Convert watcher NDJSON into compact Project Heimdall playback data.

The converter builds an event-sourced player-base ledger. Only entity type 6
is considered a player base; generic map removals remain diagnostics so mines,
resource tiles, rubble, and other objects cannot relocate a player.
"""

from __future__ import annotations

import argparse
import bisect
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


MARCH_NEW = "push.world.march.new"
MARCH_DEL = "push.world.march.del"
POINT_UPDATE = "push.world.point.update"

# Base event operations consumed by heimdall.js.
BASE_CREATE = 0
BASE_CHANGE = 1
BASE_RELOCATE = 2
BASE_FOLD_UP = 3
MAP_REMOVE = 4
OP_CODES = {
    "create": BASE_CREATE,
    "change": BASE_CHANGE,
    "relocate": BASE_RELOCATE,
    "foldUp": BASE_FOLD_UP,
    "remove": MAP_REMOVE,
}

INFERENCE_WINDOW_MS = 5 * 60_000
PLAYER_ENTITY_TYPE = 6
MAP_WIDTH = 1000


def parse_time(value: str) -> int:
    """Parse an RFC3339 timestamp into Unix milliseconds."""
    return round(
        datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    )


def first(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def as_string(value: Any) -> str:
    return "" if value is None else str(value)


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return default


def text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return next((item for item in value if isinstance(item, dict)), {})
    return {}


def normalise(value: Any) -> str:
    return " ".join(text(value).casefold().split())


def anchors_overlap(left: int, right: int) -> bool:
    """Return whether two centre-anchored 3x3 bases occupy a common tile."""
    lx, ly = left % MAP_WIDTH, left // MAP_WIDTH
    rx, ry = right % MAP_WIDTH, right // MAP_WIDTH
    return abs(lx - rx) <= 2 and abs(ly - ry) <= 2


class Index:
    """Stable insertion-order dictionary used by the compact wire format."""

    def __init__(self) -> None:
        self.values: list[str] = []
        self.by_value: dict[str, int] = {}

    def add(self, value: Any) -> int:
        key = as_string(value)
        if key not in self.by_value:
            self.by_value[key] = len(self.values)
            self.values.append(key)
        return self.by_value[key]


def choose_player(
    base: list[Any], players: list[list[Any]], players_by_name: dict[str, list[int]]
) -> int:
    """Resolve a point identity to one unambiguous march owner, or -1."""
    name, abbr, server, _alliance = base
    candidates = players_by_name.get(normalise(name), [])
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        return -1

    wanted_abbr = normalise(abbr)
    if wanted_abbr:
        matching = [i for i in candidates if normalise(players[i][2]) == wanted_abbr]
        if len(matching) == 1:
            return matching[0]
        if matching:
            candidates = matching

    if server:
        matching = [i for i in candidates if players[i][3] == server]
        if len(matching) == 1:
            return matching[0]
    return -1


def build_base_actors(
    players: list[list[Any]], bases: list[list[Any]], base_ids: list[str]
) -> tuple[list[list[Any]], list[int]]:
    """Merge changing map-point IDs into persistent logical player actors."""
    players_by_name: dict[str, list[int]] = defaultdict(list)
    for index, player in enumerate(players):
        if normalise(player[1]):
            players_by_name[normalise(player[1])].append(index)

    actor_by_key: dict[tuple[Any, ...], int] = {}
    actors: list[list[Any]] = []
    instance_actors: list[int] = []

    for instance, base in enumerate(bases):
        player = choose_player(base, players, players_by_name)
        name, abbr, server, alliance = base
        if player >= 0:
            key: tuple[Any, ...] = ("player", player)
        elif normalise(name):
            key = ("named", normalise(name), normalise(abbr), server)
        else:
            key = ("point", base_ids[instance])

        actor = actor_by_key.get(key)
        if actor is None:
            actor = len(actors)
            actor_by_key[key] = actor
            actors.append([name, abbr, server, alliance, player])
        else:
            current = actors[actor]
            incoming = [name, abbr, server, alliance, player]
            actors[actor] = [
                incoming[i] if incoming[i] not in ("", 0, -1) else current[i]
                for i in range(5)
            ]
        instance_actors.append(actor)

    return actors, instance_actors


def add_confirmed_inferences(
    events: list[list[Any]], actors: list[list[Any]]
) -> int:
    """Add dashed base events only when a later point update confirms the tile.

    March endpoints are ambiguous. An inferred base is therefore emitted only
    when one of that march's candidate positions is directly observed for the
    same resolved player within five minutes.
    """
    observations: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
    for event in events:
        if event[0] != 2 or event[2] > BASE_RELOCATE or event[3] < 0:
            continue
        actor = event[3]
        player = actors[actor][4]
        if player >= 0:
            observations[player].append((event[1], event[4], actor))

    observation_times = {
        player: [item[0] for item in items] for player, items in observations.items()
    }
    active_actor_position: dict[int, int] = {}
    active_player_actor: dict[int, int] = {}
    inferred_player_position: dict[int, int] = {}
    inferred: list[list[Any]] = []

    for event in sorted(events, key=lambda item: item[1]):
        if event[0] == 2:
            operation, actor, position = event[2], event[3], event[4]
            if operation <= BASE_RELOCATE and actor >= 0:
                old_position = active_actor_position.get(actor)
                if old_position is not None and old_position != position:
                    active_actor_position.pop(actor, None)
                active_actor_position[actor] = position
                player = actors[actor][4]
                if player >= 0:
                    active_player_actor[player] = actor
                    inferred_player_position.pop(player, None)
            elif operation == BASE_FOLD_UP:
                departed = [
                    actor_index
                    for actor_index, actor_position in active_actor_position.items()
                    if actor_position == position
                ]
                for actor_index in departed:
                    active_actor_position.pop(actor_index, None)
                    player = actors[actor_index][4]
                    if player >= 0:
                        active_player_actor.pop(player, None)
                        inferred_player_position.pop(player, None)
            continue

        if event[0] != 0:
            continue
        player = event[3]
        if player in active_player_actor:
            continue
        player_observations = observations.get(player)
        if not player_observations:
            continue

        now = event[1]
        at = bisect.bisect_left(observation_times[player], now)
        candidate_weights = {
            as_int(event[11]): 90,  # outer named startPos, when present
            as_int(event[12]): 82,  # protobuf targetPosAlt
            as_int(event[5]): 75,   # protobuf path start
        }
        candidate_weights.pop(0, None)
        match = None
        for observed_at, position, actor in player_observations[at:]:
            if observed_at - now > INFERENCE_WINDOW_MS:
                break
            if position in candidate_weights:
                match = (position, actor, candidate_weights[position], observed_at)
                break
        if match is None:
            continue

        position, actor, confidence, confirmed_at = match
        if inferred_player_position.get(player) == position:
            continue
        inferred_player_position[player] = position
        inferred.append([3, now, player, actor, position, confidence, confirmed_at])

    events.extend(inferred)
    return len(inferred)


def build_diagnostics(
    source: Path,
    events: list[list[Any]],
    actors: list[list[Any]],
    point_operations: Counter[str],
    entity_kinds: Counter[str],
) -> dict[str, Any]:
    active: dict[int, int] = {}
    pending_departures: dict[int, int] = {}
    summary = Counter()
    samples: dict[str, list[dict[str, Any]]] = {
        "genericRemoveAtPlayer": [],
        "overlapEvictions": [],
        "pairedRelocations": [],
    }
    players_with_marches: set[int] = set()
    players_with_observed_bases: set[int] = set()

    for event in sorted(events, key=lambda item: item[1]):
        if event[0] == 0:
            players_with_marches.add(event[3])
            continue
        if event[0] == 3:
            summary["inferredBasePlacements"] += 1
            continue
        if event[0] != 2:
            continue

        operation, actor, position = event[2], event[3], event[4]
        if operation <= BASE_RELOCATE and actor >= 0:
            player = actors[actor][4]
            if player >= 0:
                players_with_observed_bases.add(player)
            previous = active.get(actor)
            if previous is not None and previous != position:
                summary["sameActorMovedWithoutDeparture"] += 1

            for other, other_position in list(active.items()):
                if other == actor or not anchors_overlap(position, other_position):
                    continue
                summary["overlapEvictions"] += 1
                if len(samples["overlapEvictions"]) < 20:
                    samples["overlapEvictions"].append(
                        {"time": event[1], "position": position, "evicted": other_position}
                    )
                active.pop(other, None)
            active[actor] = position

            departed_at = pending_departures.pop(actor, None)
            if departed_at is not None:
                delay = event[1] - departed_at
                if 0 <= delay <= 120_000:
                    summary["pairedRelocations"] += 1
                    if delay <= 1000:
                        summary["pairedWithinOneSecond"] += 1
                    if len(samples["pairedRelocations"]) < 20:
                        samples["pairedRelocations"].append(
                            {"departed": departed_at, "arrived": event[1], "delayMs": delay}
                        )
                else:
                    summary["lateUnpairedReappearance"] += 1

        elif operation == BASE_FOLD_UP:
            departed = [key for key, value in active.items() if value == position]
            if departed:
                summary["foldUpAtKnownBase"] += 1
                for key in departed:
                    active.pop(key, None)
                    pending_departures[key] = event[1]
            else:
                summary["foldUpAtUnknownPosition"] += 1

        elif operation == MAP_REMOVE:
            summary["genericRemovePositions"] += 1
            occupying = [key for key, value in active.items() if value == position]
            if occupying:
                summary["genericRemoveAtKnownBase"] += 1
                if len(samples["genericRemoveAtPlayer"]) < 20:
                    samples["genericRemoveAtPlayer"].append(
                        {"time": event[1], "position": position, "actors": occupying}
                    )
            # Deliberately do not mutate player state for generic remove.

    linked_actors = sum(1 for actor in actors if actor[4] >= 0)
    summary["logicalBaseActors"] = len(actors)
    summary["actorsLinkedToMarchPlayers"] = linked_actors
    summary["marchPlayers"] = len(players_with_marches)
    summary["marchPlayersWithObservedBase"] = len(
        players_with_marches & players_with_observed_bases
    )
    summary["unresolvedMarchPlayers"] = len(
        players_with_marches - players_with_observed_bases
    )

    return {
        "version": 1,
        "source": source.name,
        "summary": dict(summary),
        "pointOperations": dict(point_operations),
        "pointEntityKinds": dict(entity_kinds),
        "semantics": {
            "create": "observed player appearance",
            "change": "observed player refresh in place",
            "relocate": "observed player arrival",
            "foldUp": "observed vacancy at an old player anchor",
            "remove": "generic map-object removal; does not mutate player state",
            "inferred": "march candidate confirmed by a later player point within five minutes",
        },
        "assumptions": [
            "Only point entity type 6 is a player base.",
            "The packed player point is the centre anchor of a 3x3 footprint.",
            "foldUp alone does not distinguish voluntary and forced relocation.",
            "This capture contains no world.get.block snapshot, so initial coverage is partial.",
        ],
        "samples": samples,
    }


def convert(source: Path, output: Path, chunk_ms: int) -> dict[str, Any]:
    march_ids = Index()
    team_ids = Index()
    base_ids = Index()
    player_by_uid: dict[str, int] = {}
    players: list[list[Any]] = []
    bases: list[list[Any]] = []
    events: list[list[Any]] = []
    point_operations: Counter[str] = Counter()
    entity_kinds: Counter[str] = Counter()
    counts = {
        "marches": 0,
        "deletions": 0,
        "baseUpdates": 0,
        "genericRemovals": 0,
        "skipped": 0,
    }
    start = end = None

    def player_index(uid: Any, name: Any, abbr: Any, server: Any, alliance: Any) -> int:
        key = as_string(uid)
        if key not in player_by_uid:
            player_by_uid[key] = len(players)
            players.append([key, text(name), text(abbr), as_int(server), text(alliance)])
        else:
            row = players[player_by_uid[key]]
            incoming = [key, text(name), text(abbr), as_int(server), text(alliance)]
            players[player_by_uid[key]] = [
                incoming[i] if incoming[i] not in ("", 0) else row[i]
                for i in range(5)
            ]
        return player_by_uid[key]

    with source.open("r", encoding="utf-8", errors="replace") as handle:
        for line_number, line in enumerate(handle, 1):
            try:
                record = json.loads(line)
                capture_time = parse_time(record["ts"])
            except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                counts["skipped"] += 1
                continue

            if start is None:
                start = capture_time
            end = capture_time
            fields = as_dict(record.get("fields"))
            route = record.get("route")
            event_time = capture_time - start

            if route == MARCH_NEW:
                proto = as_dict(fields.get("_proto"))
                roster = as_dict(proto.get("armyRoster"))
                summary = as_dict(roster.get("summary"))
                march_id = first(
                    fields.get("uuid"), fields.get("marchUid"), summary.get("marchUid")
                )
                start_pos = first(proto.get("startPos"), fields.get("startPos"))
                target_pos = first(proto.get("targetPos"), fields.get("targetPos"))
                if march_id is None or start_pos is None or target_pos is None:
                    counts["skipped"] += 1
                    continue

                owner_uid = first(
                    fields.get("ownerUid"),
                    fields.get("ownerId"),
                    proto.get("ownerUid"),
                    summary.get("ownerUid"),
                    "",
                )
                player = player_index(
                    owner_uid,
                    first(proto.get("ownerName"), fields.get("name")),
                    first(proto.get("allianceAbbr"), fields.get("abbr")),
                    first(
                        proto.get("homeServerId"),
                        proto.get("ownerServerId"),
                        proto.get("serverId"),
                        fields.get("serverId"),
                        record.get("serverId"),
                    ),
                    first(proto.get("allianceId"), fields.get("allianceId")),
                )
                move_start = (
                    as_int(first(proto.get("sendTime"), fields.get("sendTime")), capture_time)
                    - start
                )
                move_end = (
                    as_int(
                        first(proto.get("arriveTime"), fields.get("arriveTime")),
                        capture_time + 1000,
                    )
                    - start
                )
                if move_end <= move_start:
                    move_start = event_time
                    move_end = event_time + 1000
                events.append(
                    [
                        0,
                        event_time,
                        march_ids.add(march_id),
                        player,
                        as_int(first(proto.get("marchType"), fields.get("mt"))),
                        as_int(start_pos),
                        as_int(target_pos),
                        move_start,
                        move_end,
                        as_int(proto.get("targetKind")),
                        team_ids.add(first(fields.get("teamUuid"), 0)),
                        as_int(fields.get("startPos")),
                        as_int(proto.get("targetPosAlt")),
                        as_float(first(proto.get("marchSpeed"), fields.get("marchSpeed"))),
                    ]
                )
                counts["marches"] += 1

            elif route == MARCH_DEL:
                march_id = first(fields.get("uuid"), fields.get("marchUid"))
                if march_id is None:
                    counts["skipped"] += 1
                    continue
                events.append(
                    [1, event_time, march_ids.add(march_id), 1 if fields.get("isBattleFail") else 0]
                )
                counts["deletions"] += 1

            elif route == POINT_UPDATE:
                operation = text(fields.get("type"))
                if operation not in OP_CODES:
                    counts["skipped"] += 1
                    continue
                point_operations[operation] += 1
                op = OP_CODES[operation]

                if operation in ("foldUp", "remove"):
                    for position in fields.get("pointIds") or []:
                        events.append([2, event_time, op, -1, as_int(position), -1])
                        if operation == "remove":
                            counts["genericRemovals"] += 1
                        else:
                            counts["baseUpdates"] += 1
                    continue

                points = fields.get("points") or []
                if isinstance(points, dict):
                    points = [points]
                for point in points:
                    if not isinstance(point, dict):
                        continue
                    kind = as_int(point.get("f2"), -1)
                    entity_kinds[str(kind)] += 1
                    if kind != PLAYER_ENTITY_TYPE:
                        continue
                    position = point.get("f1")
                    if position is None:
                        continue
                    details = as_dict(point.get("f3"))
                    base_id = first(
                        point.get("f100"), details.get("f2"), f"position:{position}"
                    )
                    base_index = base_ids.add(base_id)
                    while len(bases) <= base_index:
                        bases.append(["", "", 0, ""])
                    incoming = [
                        text(details.get("f14")),
                        text(details.get("f15")),
                        as_int(
                            first(
                                point.get("f103"),
                                point.get("f102"),
                                fields.get("sid"),
                            )
                        ),
                        text(details.get("f7")),
                    ]
                    existing = bases[base_index]
                    bases[base_index] = [
                        incoming[i] if incoming[i] not in ("", 0) else existing[i]
                        for i in range(4)
                    ]
                    events.append(
                        [2, event_time, op, base_index, as_int(position), base_index]
                    )
                    counts["baseUpdates"] += 1

            if line_number % 100_000 == 0:
                print(f"read {line_number:,} records", flush=True)

    if start is None or end is None:
        raise ValueError(f"no valid records in {source}")

    actors, instance_actors = build_base_actors(players, bases, base_ids.values)
    for event in events:
        if event[0] == 2 and event[3] >= 0:
            event[3] = instance_actors[event[3]]

    events.sort(key=lambda event: event[1])
    counts["inferredBases"] = add_confirmed_inferences(events, actors)
    diagnostics = build_diagnostics(
        source, events, actors, point_operations, entity_kinds
    )

    # Candidate positions are converter-only evidence; keep browser chunks compact
    # while retaining march speed as the final browser-facing field.
    for event in events:
        if event[0] == 0 and len(event) > 13:
            speed = event[13]
            del event[11:]
            event.append(speed)
    events.sort(key=lambda event: event[1])

    output.mkdir(parents=True, exist_ok=True)
    for old_chunk in output.glob("chunk-*.json"):
        old_chunk.unlink()

    duration = max(0, end - start)
    chunk_count = duration // chunk_ms + 1
    chunks: list[list[list[Any]]] = [[] for _ in range(chunk_count)]
    for event in events:
        index = min(event[1] // chunk_ms, chunk_count - 1)
        chunks[index].append(event)

    chunk_manifest = []
    for index, chunk in enumerate(chunks):
        filename = f"chunk-{index:03d}.json"
        with (output / filename).open("w", encoding="utf-8", newline="\n") as handle:
            json.dump({"e": chunk}, handle, ensure_ascii=False, separators=(",", ":"))
        chunk_manifest.append(
            {
                "file": filename,
                "start": index * chunk_ms,
                "end": min((index + 1) * chunk_ms, duration),
                "events": len(chunk),
            }
        )

    manifest = {
        "version": 3,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": source.name,
        "start": start,
        "end": end,
        "duration": duration,
        "mapWidth": MAP_WIDTH,
        "baseSize": 3,
        "chunkMs": chunk_ms,
        "counts": counts,
        "diagnostics": diagnostics["summary"],
        "chunks": chunk_manifest,
        "marchIds": march_ids.values,
        "teamIds": team_ids.values,
        "players": players,
        "baseIds": base_ids.values,
        "baseInstances": instance_actors,
        "baseActors": actors,
    }
    with (output / "manifest.json").open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))
    with (output / "diagnostics.json").open(
        "w", encoding="utf-8", newline="\n"
    ) as handle:
        json.dump(diagnostics, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    total_bytes = sum(path.stat().st_size for path in output.glob("*.json"))
    print(
        f"wrote {len(events):,} events in {len(chunks)} chunks "
        f"({total_bytes / 1024 / 1024:.1f} MiB) to {output}"
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="watcher NDJSON capture")
    parser.add_argument("output", type=Path, help="static output directory")
    parser.add_argument("--chunk-minutes", type=int, default=5)
    args = parser.parse_args()
    if args.chunk_minutes < 1:
        parser.error("--chunk-minutes must be at least 1")
    convert(args.source, args.output, args.chunk_minutes * 60_000)


if __name__ == "__main__":
    main()
