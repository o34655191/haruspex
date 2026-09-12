import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.convert_replay import (
    BASE_CREATE,
    BASE_FOLD_UP,
    BASE_RELOCATE,
    MAP_REMOVE,
    anchors_overlap,
    convert,
    build_base_actors,
)


START = datetime(2026, 8, 8, 13, 0, tzinfo=timezone.utc)


class IdentityTests(unittest.TestCase):
    def test_uid_links_renamed_base(self):
        actors, _ = build_base_actors([["123", "New name", "TAG", 472, "a"]], [["Old name", "TAG", 472, "a"]], ["base"], {"base": "123"})
        self.assertEqual(actors[0][4], 0)

    def test_conflicting_uid_does_not_fall_back_to_name(self):
        actors, _ = build_base_actors([["123", "Alice", "TAG", 472, "a"]], [["Alice", "TAG", 472, "a"]], ["base"], {"base": "456"})
        self.assertEqual(actors[0][4], -1)


def record(offset_ms, route, fields):
    timestamp = START + timedelta(milliseconds=offset_ms)
    return {
        "ts": timestamp.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "route": route,
        "fields": fields,
    }


def player_point(operation, position, point_id, name="Alice", kind=6, config=10_100_000):
    return {
        "type": operation,
        "sid": 435,
        "points": [
            {
                "f1": position,
                "f2": kind,
                "f100": point_id,
                "f102": 435,
                "f103": 472,
                "f3": {
                    "f2": point_id,
                    "f3": config,
                    "f7": "alliance-id",
                    "f14": name,
                    "f15": "TAG",
                },
            }
        ],
    }


def removal(operation, *positions):
    return {"type": operation, "sid": 435, "pointIds": list(positions)}


def march(position):
    start_ms = round(START.timestamp() * 1000)
    return {
        "uuid": 9001,
        "ownerUid": "1000000000000472",
        "_proto": {
            "ownerName": "Alice",
            "allianceAbbr": "TAG",
            "allianceId": "alliance-id",
            "homeServerId": 472,
            "marchType": 1,
            "marchSpeed": 0.3125,
            "startPos": 490490,
            "targetPos": 510510,
            "targetPosAlt": position,
            "sendTime": start_ms,
            "arriveTime": start_ms + 60_000,
        },
    }


class ConvertReplayTests(unittest.TestCase):
    def convert_records(self, records):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        source = root / "capture.ndjson"
        output = root / "data"
        with source.open("w", encoding="utf-8") as handle:
            for item in records:
                handle.write(json.dumps(item) + "\n")
        manifest = convert(source, output, 60_000)
        events = []
        for chunk in manifest["chunks"]:
            events.extend(json.loads((output / chunk["file"]).read_text())["e"])
        diagnostics = json.loads((output / "diagnostics.json").read_text())
        return manifest, events, diagnostics

    def test_reconstructs_one_logical_player_across_point_ids(self):
        old_position = 500500
        new_position = 600600
        records = [
            record(0, "push.world.march.new", march(old_position)),
            record(1_000, "push.world.point.update", player_point("create", old_position, 111)),
            record(2_000, "push.world.point.update", removal("foldUp", old_position)),
            record(2_001, "push.world.point.update", player_point("relocate", new_position, 222)),
            record(3_000, "push.world.point.update", removal("remove", new_position)),
        ]

        manifest, events, diagnostics = self.convert_records(records)

        self.assertEqual(manifest["version"], 3)
        self.assertEqual(len(manifest["baseActors"]), 1)
        self.assertEqual(manifest["baseInstances"], [0, 0])
        self.assertEqual(manifest["baseActors"][0][4], 0)
        operations = [event[2] for event in events if event[0] == 2]
        self.assertEqual(
            operations,
            [BASE_CREATE, BASE_FOLD_UP, BASE_RELOCATE, MAP_REMOVE],
        )
        self.assertEqual(diagnostics["summary"]["genericRemoveAtKnownBase"], 1)
        self.assertEqual(diagnostics["summary"]["pairedRelocations"], 1)

        march_event = next(event for event in events if event[0] == 0)
        self.assertEqual(march_event[11], 0.3125)

    def test_infers_only_a_march_position_confirmed_by_a_later_point(self):
        confirmed_position = 500500
        records = [
            record(0, "push.world.march.new", march(confirmed_position)),
            record(
                1_000,
                "push.world.point.update",
                player_point("create", confirmed_position, 111),
            ),
        ]

        manifest, events, _diagnostics = self.convert_records(records)

        inferred = [event for event in events if event[0] == 3]
        self.assertEqual(manifest["counts"]["inferredBases"], 1)
        self.assertEqual(len(inferred), 1)
        self.assertEqual(inferred[0][4], confirmed_position)
        self.assertGreaterEqual(inferred[0][5], 80)

    def test_non_player_points_never_become_bases(self):
        records = [
            record(
                0,
                "push.world.point.update",
                player_point("create", 400400, 123, name="Mine", kind=17),
            ),
            record(1, "push.world.point.update", removal("remove", 400400)),
        ]

        manifest, events, diagnostics = self.convert_records(records)

        self.assertEqual(manifest["baseActors"], [])
        self.assertFalse(any(event[0] == 2 and event[3] >= 0 for event in events))
        self.assertEqual(diagnostics["pointEntityKinds"]["17"], 1)
        self.assertEqual(diagnostics["summary"].get("genericRemoveAtKnownBase", 0), 0)

    def test_rubble_city_entity_never_becomes_player_base(self):
        records = [
            record(
                0,
                "push.world.point.update",
                player_point("create", 400400, 123, name="Burned city", config=10_301_000),
            ),
        ]

        manifest, events, _diagnostics = self.convert_records(records)

        self.assertEqual(manifest["baseActors"], [])
        self.assertFalse(any(event[0] == 2 and event[3] >= 0 for event in events))

    def test_world_snapshot_seeds_observed_player_bases(self):
        fields = player_point("create", 500500, 111)
        fields.pop("type")
        records = [record(0, "world.get.block", fields)]

        manifest, events, _diagnostics = self.convert_records(records)

        self.assertEqual(manifest["counts"]["worldSnapshots"], 1)
        observed = [event for event in events if event[0] == 2 and event[3] >= 0]
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0][2], BASE_CREATE)

    def test_three_by_three_overlap_uses_centre_anchors(self):
        self.assertTrue(anchors_overlap(500500, 502502))
        self.assertFalse(anchors_overlap(500500, 503500))
        self.assertFalse(anchors_overlap(500500, 500503))


if __name__ == "__main__":
    unittest.main()
