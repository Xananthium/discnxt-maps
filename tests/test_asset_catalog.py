import hashlib
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


VIEWER_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = VIEWER_ROOT / "tools" / "ingest_asset_catalog.py"
SPEC = importlib.util.spec_from_file_location("ingest_asset_catalog", SCRIPT_PATH)
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


def apply_column_major(matrix, point):
    x, y, z = point
    return (
        matrix[0] * x
        + matrix[4] * y
        + matrix[8] * z
        + matrix[12],
        matrix[1] * x
        + matrix[5] * y
        + matrix[9] * z
        + matrix[13],
        matrix[2] * x
        + matrix[6] * y
        + matrix[10] * z
        + matrix[14],
    )


class AssetCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = catalog.fetch_manifests()
        cls.facts = catalog.extract_facts(cls.source)
        cls.temporary_directory = tempfile.TemporaryDirectory()
        cls.output_dir = Path(cls.temporary_directory.name) / "catalog"
        cls.summary = catalog.build_catalog(cls.output_dir, cls.source)
        cls.database_path = cls.output_dir / "catalog.sqlite3"
        cls.projection_path = cls.output_dir / "catalog.json"
        cls.projection = json.loads(
            cls.projection_path.read_text(encoding="utf-8")
        )

    @classmethod
    def tearDownClass(cls):
        cls.temporary_directory.cleanup()

    def test_only_the_three_small_manifest_urls_are_fetched(self):
        observed_urls = []

        def fake_fetch(url):
            observed_urls.append(url)
            name = url.rsplit("/", 1)[-1]
            self.assertIn(name, catalog.MANIFEST_NAMES)
            return self.source["raw"][name]

        fetched = catalog.fetch_manifests(fetch_bytes=fake_fetch)
        catalog.extract_facts(fetched)
        self.assertEqual(
            observed_urls,
            [
                catalog.DEFAULT_BASE_URL + name
                for name in catalog.MANIFEST_NAMES
            ],
        )
        self.assertFalse(
            any(url.lower().endswith(".b3dm") for url in observed_urls)
        )

    def test_graph_is_closed_and_contains_only_asset_domain_state(self):
        expected_kinds = {
            "content_asset": 4,
            "coordinate_reference_system": 2,
            "epoch": 1,
            "license": 1,
            "local_frame": 1,
            "release": 1,
            "source_manifest": 1,
            "tileset": 1,
            "validator": 5,
        }
        forbidden_fields = {"task", "status", "assignment", "blocker"}
        connection = sqlite3.connect(self.database_path)
        try:
            tables = {
                row[0]
                for row in connection.execute(
                    """
                    SELECT name
                    FROM sqlite_master
                    WHERE type = 'table'
                    """
                )
            }
            self.assertEqual(tables, {"metadata", "nodes", "edges"})
            for table in tables:
                self.assertTrue(forbidden_fields.isdisjoint(table.split("_")))
                columns = {
                    row[1]
                    for row in connection.execute(
                        f"PRAGMA table_info({table})"
                    )
                }
                self.assertTrue(
                    forbidden_fields.isdisjoint(
                        part
                        for column in columns
                        for part in column.split("_")
                    )
                )

            observed_kinds = dict(
                connection.execute(
                    """
                    SELECT kind, COUNT(*)
                    FROM nodes
                    GROUP BY kind
                    ORDER BY kind
                    """
                )
            )
            self.assertEqual(observed_kinds, expected_kinds)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM nodes").fetchone()[0],
                17,
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM edges").fetchone()[0],
                16,
            )

            manifest_assets = {
                asset["path"]: (
                    asset["bytes"],
                    asset["sha256"],
                    catalog.urljoin(
                        catalog.DEFAULT_BASE_URL, asset["path"]
                    ),
                )
                for asset in self.facts["content_assets"]
            }
            database_assets = {
                name: (byte_count, sha256, uri)
                for name, byte_count, sha256, uri in connection.execute(
                    """
                    SELECT name, bytes, sha256, uri
                    FROM nodes
                    WHERE kind = 'content_asset'
                    ORDER BY name
                    """
                )
            }
            self.assertEqual(database_assets, manifest_assets)

            referenced_paths = {
                json.loads(metadata_json)["content_uri"]
                for (metadata_json,) in connection.execute(
                    """
                    SELECT e.metadata_json
                    FROM edges e
                    JOIN nodes source ON source.id = e.source_id
                    JOIN nodes target ON target.id = e.target_id
                    WHERE e.relation = 'references'
                      AND source.kind = 'tileset'
                      AND target.kind = 'content_asset'
                    """
                )
            }
            self.assertEqual(referenced_paths, set(manifest_assets))

            source_identity = connection.execute(
                """
                SELECT sha256
                FROM nodes
                WHERE kind = 'source_manifest'
                """
            ).fetchone()[0]
            self.assertEqual(
                source_identity,
                self.facts["release"]["source_manifest_sha256"],
            )
            self.assertEqual(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM edges
                    WHERE relation = 'validated_by'
                    """
                ).fetchone()[0],
                len(self.facts["validators"]),
            )

            stored_json = [
                value
                for (value,) in connection.execute(
                    "SELECT value_json FROM metadata"
                )
            ]
            stored_json.extend(
                value
                for (value,) in connection.execute(
                    "SELECT metadata_json FROM nodes"
                )
            )
            stored_json.extend(
                value
                for (value,) in connection.execute(
                    "SELECT metadata_json FROM edges"
                )
            )
            for raw_json in stored_json:
                pending = [json.loads(raw_json)]
                while pending:
                    value = pending.pop()
                    if isinstance(value, dict):
                        self.assertTrue(
                            forbidden_fields.isdisjoint(value.keys())
                        )
                        pending.extend(value.values())
                    elif isinstance(value, list):
                        pending.extend(value)
        finally:
            connection.close()

        projected_assets = {
            asset["path"]: asset["url"]
            for asset in self.projection["assets"]
        }
        self.assertEqual(set(projected_assets), set(manifest_assets))
        self.assertTrue(
            all(url.startswith("https://") for url in projected_assets.values())
        )
        self.assertEqual(
            self.projection["tileset_url"],
            catalog.DEFAULT_BASE_URL + "tileset.json",
        )
        self.assertEqual(
            self.projection["content_bytes"],
            sum(asset["bytes"] for asset in self.facts["content_assets"]),
        )

    def test_fixed_site_enu_round_trips_through_ecef(self):
        spatial = self.projection["spatial"]
        enu_to_ecef = spatial["enu_to_ecef_column_major"]
        ecef_to_enu = spatial["ecef_to_enu_column_major"]
        for local_point in (
            (0.0, 0.0, 0.0),
            (10.0, -20.0, 30.0),
            (-100.0, 50.0, 3.25),
            (500.0, 500.0, 500.0),
        ):
            ecef_point = apply_column_major(enu_to_ecef, local_point)
            observed_local = apply_column_major(ecef_to_enu, ecef_point)
            for observed, expected in zip(observed_local, local_point):
                self.assertAlmostEqual(observed, expected, delta=1e-8)

        origin = spatial["origin_wgs84"]
        reconstructed_ecef = catalog.geodetic_to_ecef(
            origin["longitude_degrees"],
            origin["latitude_degrees"],
            origin["ellipsoid_height_metres"],
        )
        for observed, expected in zip(
            reconstructed_ecef, spatial["origin_ecef_metres"]
        ):
            self.assertAlmostEqual(observed, expected, delta=1e-6)

        self.assertEqual(spatial["world_crs"], "EPSG:4978")
        self.assertEqual(spatial["geodetic_crs"], "EPSG:4979")
        self.assertEqual(spatial["epoch_id"], "epoch:2026-07-29")
        self.assertEqual(
            spatial["provenance"],
            "tileset.json root.transform[12:15]",
        )
        self.assertEqual(
            spatial["tileset_root_transform_column_major"],
            self.facts["root_transform"],
        )
        self.assertEqual(
            spatial["uncertainty"],
            {"horizontal_metres": None, "vertical_metres": None},
        )

    def test_rebuild_is_byte_deterministic_and_integral(self):
        first_directory = Path(self.temporary_directory.name) / "first"
        second_directory = Path(self.temporary_directory.name) / "second"
        catalog.build_catalog(first_directory, self.source)
        catalog.build_catalog(second_directory, self.source)

        for filename in ("catalog.sqlite3", "catalog.json"):
            first = (first_directory / filename).read_bytes()
            second = (second_directory / filename).read_bytes()
            self.assertEqual(hashlib.sha256(first).digest(), hashlib.sha256(second).digest())
            self.assertEqual(first, second)

        connection = sqlite3.connect(first_directory / "catalog.sqlite3")
        try:
            self.assertEqual(
                connection.execute("PRAGMA foreign_key_check").fetchall(), []
            )
            self.assertEqual(
                connection.execute("PRAGMA integrity_check").fetchall(),
                [("ok",)],
            )
        finally:
            connection.close()

        self.assertEqual(list(first_directory.glob("*.tmp")), [])
        self.assertEqual(list(second_directory.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
