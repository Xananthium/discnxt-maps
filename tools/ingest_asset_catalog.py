#!/usr/bin/env python3
"""Build the public cemetery release asset graph from its accepted manifests."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import sqlite3
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = (
    "https://maps.discnxt.com/epochs/2026-07-29-v1/tiles/"
)
DEFAULT_OUTPUT_DIR = (
    Path(__file__).resolve().parents[1]
    / "public"
    / "catalog"
    / "2026-07-29-v1"
)
MANIFEST_NAMES = ("release-assets.json", "release.json", "tileset.json")
MAX_MANIFEST_BYTES = 64 * 1024
WGS84_A = 6_378_137.0
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)

SCHEMA = """
CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
        'release',
        'epoch',
        'tileset',
        'content_asset',
        'license',
        'source_manifest',
        'validator',
        'coordinate_reference_system',
        'local_frame'
    )),
    name TEXT NOT NULL,
    uri TEXT UNIQUE,
    media_type TEXT,
    bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
    sha256 TEXT CHECK (
        sha256 IS NULL OR (
            length(sha256) = 64
            AND sha256 NOT GLOB '*[^0-9a-f]*'
        )
    ),
    metadata_json TEXT NOT NULL,
    UNIQUE (kind, name)
) WITHOUT ROWID;

CREATE TABLE edges (
    source_id TEXT NOT NULL REFERENCES nodes(id),
    relation TEXT NOT NULL CHECK (relation IN (
        'derived_from',
        'validated_by',
        'contains',
        'references',
        'uses_frame',
        'licensed_under'
    )),
    target_id TEXT NOT NULL REFERENCES nodes(id),
    metadata_json TEXT NOT NULL,
    PRIMARY KEY (source_id, relation, target_id, metadata_json)
) WITHOUT ROWID;
"""


def canonical_json(value: object) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def fetch_url_bytes(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": "discnxt-asset-catalog/1.0"})
    with urlopen(request, timeout=30) as response:
        body = response.read(MAX_MANIFEST_BYTES + 1)
    if len(body) > MAX_MANIFEST_BYTES:
        raise ValueError(f"manifest exceeds {MAX_MANIFEST_BYTES} bytes: {url}")
    return body


def fetch_manifests(base_url: str = DEFAULT_BASE_URL, fetch_bytes=None) -> dict:
    base_url = base_url.rstrip("/") + "/"
    fetch_bytes = fetch_bytes or fetch_url_bytes
    raw = {}
    documents = {}
    for name in MANIFEST_NAMES:
        body = fetch_bytes(urljoin(base_url, name))
        raw[name] = body
        documents[name] = json.loads(body.decode("utf-8"))
    return {"base_url": base_url, "raw": raw, "documents": documents}


def _valid_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _capture_date(value: object) -> str:
    try:
        parsed = dt.date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("capture epoch must be an ISO calendar date") from exc
    if parsed.isoformat() != value:
        raise ValueError("capture epoch must be an ISO calendar date")
    return value


def _content_media_type(path: str) -> str:
    suffix = PurePosixPath(path).suffix.lower()
    return {
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".json": "application/json",
    }.get(suffix, "application/octet-stream")


def _relative_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError(f"invalid relative asset path: {value!r}")
    parsed = urlparse(value)
    normalized = str(PurePosixPath(value))
    if (
        parsed.scheme
        or parsed.netloc
        or value.startswith("/")
        or normalized != value
        or ".." in PurePosixPath(value).parts
    ):
        raise ValueError(f"invalid relative asset path: {value!r}")
    return value


def _tileset_content_uris(tile: dict) -> list[str]:
    uris = []
    contents = []
    if tile.get("content") is not None:
        contents.append(tile["content"])
    declared_contents = tile.get("contents", [])
    if not isinstance(declared_contents, list):
        raise ValueError("tileset contents must be a list")
    contents.extend(declared_contents)
    for content in contents:
        if not isinstance(content, dict) or "uri" not in content:
            raise ValueError("tileset content must have a uri")
        uris.append(_relative_path(content["uri"]))
    for child in tile.get("children", []):
        if not isinstance(child, dict):
            raise ValueError("tileset child must be an object")
        uris.extend(_tileset_content_uris(child))
    return uris


def extract_facts(source: dict) -> dict:
    documents = source["documents"]
    raw = source["raw"]
    asset_manifest = documents["release-assets.json"]
    release = documents["release.json"]
    tileset = documents["tileset.json"]

    if asset_manifest.get("status") != "accepted":
        raise ValueError("release-assets.json is not accepted")
    if release.get("status") != "accepted_for_publication":
        raise ValueError("release.json is not accepted for publication")
    if asset_manifest.get("release_id") != release.get("release_id"):
        raise ValueError("release identifiers do not match")
    if asset_manifest.get("root_content_removed") is not True:
        raise ValueError("the accepted release must omit root content")

    assets = asset_manifest.get("assets")
    if not isinstance(assets, list):
        raise ValueError("release-assets.json assets must be a list")
    assets_by_path = {}
    for asset in assets:
        if not isinstance(asset, dict):
            raise ValueError("asset entry must be an object")
        path = _relative_path(asset.get("path"))
        if path in assets_by_path:
            raise ValueError(f"duplicate asset path: {path}")
        if not isinstance(asset.get("bytes"), int) or asset["bytes"] < 0:
            raise ValueError(f"invalid byte count: {path}")
        if not _valid_sha256(asset.get("sha256")):
            raise ValueError(f"invalid sha256: {path}")
        assets_by_path[path] = asset

    for name in ("release.json", "tileset.json"):
        declared = assets_by_path.get(name)
        if declared is None:
            raise ValueError(f"accepted manifest omits {name}")
        observed = hashlib.sha256(raw[name]).hexdigest()
        if observed != declared["sha256"] or len(raw[name]) != declared["bytes"]:
            raise ValueError(f"accepted identity mismatch for {name}")

    root = tileset.get("root")
    if not isinstance(root, dict):
        raise ValueError("tileset root must be an object")
    content_uris = _tileset_content_uris(root)
    if len(content_uris) != len(set(content_uris)):
        raise ValueError("tileset contains duplicate content URIs")
    content_assets = []
    for path in sorted(content_uris):
        asset = assets_by_path.get(path)
        if asset is None:
            raise ValueError(f"tileset content is absent from accepted assets: {path}")
        content_assets.append(
            {
                "path": path,
                "bytes": asset["bytes"],
                "sha256": asset["sha256"],
            }
        )
    declared_content_count = asset_manifest.get("content_assets")
    if (
        declared_content_count != len(content_assets)
        or release.get("content_assets") != len(content_assets)
    ):
        raise ValueError("content asset count does not close")

    transform = root.get("transform")
    if (
        not isinstance(transform, list)
        or len(transform) != 16
        or not all(isinstance(value, (int, float)) for value in transform)
        or not all(math.isfinite(float(value)) for value in transform)
        or not math.isclose(float(transform[15]), 1.0)
    ):
        raise ValueError("tileset root transform is not a finite 4x4 matrix")

    validators = asset_manifest.get("validated_by")
    if not isinstance(validators, list) or not validators:
        raise ValueError("accepted release has no validators")
    validator_keys = set()
    for validator in validators:
        if (
            not isinstance(validator, dict)
            or validator.get("status") != "passed"
            or not validator.get("tool")
            or not validator.get("tool_version")
        ):
            raise ValueError("accepted release contains an unpassed validator")
        key = (validator["tool"], validator["tool_version"])
        if key in validator_keys:
            raise ValueError(f"duplicate validator: {key}")
        validator_keys.add(key)

    if not _valid_sha256(release.get("source_manifest_sha256")):
        raise ValueError("release source manifest identity is invalid")
    _capture_date(release.get("capture_date"))
    if release.get("content_license") != "CC BY 4.0":
        raise ValueError("unexpected content license")

    return {
        "asset_manifest": asset_manifest,
        "release": release,
        "tileset": tileset,
        "content_assets": content_assets,
        "validators": sorted(
            (
                {
                    "tool": validator["tool"],
                    "version": validator["tool_version"],
                    "result": "passed",
                }
                for validator in validators
            ),
            key=lambda validator: (validator["tool"], validator["version"]),
        ),
        "root_transform": [float(value) for value in transform],
        "release_document": assets_by_path["release.json"],
        "tileset_document": assets_by_path["tileset.json"],
    }


def ecef_to_geodetic(x: float, y: float, z: float) -> tuple[float, float, float]:
    longitude = math.atan2(y, x)
    radius = math.hypot(x, y)
    if radius < 1e-9:
        latitude = math.copysign(math.pi / 2.0, z)
        height = abs(z) - WGS84_A * math.sqrt(1.0 - WGS84_E2)
        return math.degrees(longitude), math.degrees(latitude), height

    latitude = math.atan2(z, radius * (1.0 - WGS84_E2))
    for _ in range(15):
        sin_latitude = math.sin(latitude)
        prime_vertical = WGS84_A / math.sqrt(
            1.0 - WGS84_E2 * sin_latitude * sin_latitude
        )
        next_latitude = math.atan2(
            z + WGS84_E2 * prime_vertical * sin_latitude,
            radius,
        )
        if abs(next_latitude - latitude) < 1e-15:
            latitude = next_latitude
            break
        latitude = next_latitude

    sin_latitude = math.sin(latitude)
    prime_vertical = WGS84_A / math.sqrt(
        1.0 - WGS84_E2 * sin_latitude * sin_latitude
    )
    height = radius / math.cos(latitude) - prime_vertical
    return math.degrees(longitude), math.degrees(latitude), height


def geodetic_to_ecef(
    longitude_degrees: float,
    latitude_degrees: float,
    ellipsoid_height_metres: float,
) -> tuple[float, float, float]:
    longitude = math.radians(longitude_degrees)
    latitude = math.radians(latitude_degrees)
    sin_latitude = math.sin(latitude)
    prime_vertical = WGS84_A / math.sqrt(
        1.0 - WGS84_E2 * sin_latitude * sin_latitude
    )
    radial = (prime_vertical + ellipsoid_height_metres) * math.cos(latitude)
    return (
        radial * math.cos(longitude),
        radial * math.sin(longitude),
        (
            prime_vertical * (1.0 - WGS84_E2)
            + ellipsoid_height_metres
        )
        * sin_latitude,
    )


def enu_matrices(
    origin_ecef: tuple[float, float, float],
    longitude_degrees: float,
    latitude_degrees: float,
) -> tuple[list[float], list[float]]:
    longitude = math.radians(longitude_degrees)
    latitude = math.radians(latitude_degrees)
    sin_longitude = math.sin(longitude)
    cos_longitude = math.cos(longitude)
    sin_latitude = math.sin(latitude)
    cos_latitude = math.cos(latitude)

    east = (-sin_longitude, cos_longitude, 0.0)
    north = (
        -sin_latitude * cos_longitude,
        -sin_latitude * sin_longitude,
        cos_latitude,
    )
    up = (
        cos_latitude * cos_longitude,
        cos_latitude * sin_longitude,
        sin_latitude,
    )
    x, y, z = origin_ecef

    enu_to_ecef = [
        east[0],
        east[1],
        east[2],
        0.0,
        north[0],
        north[1],
        north[2],
        0.0,
        up[0],
        up[1],
        up[2],
        0.0,
        x,
        y,
        z,
        1.0,
    ]
    ecef_to_enu = [
        east[0],
        north[0],
        up[0],
        0.0,
        east[1],
        north[1],
        up[1],
        0.0,
        east[2],
        north[2],
        up[2],
        0.0,
        -sum(axis * value for axis, value in zip(east, origin_ecef)),
        -sum(axis * value for axis, value in zip(north, origin_ecef)),
        -sum(axis * value for axis, value in zip(up, origin_ecef)),
        1.0,
    ]
    return enu_to_ecef, ecef_to_enu


def graph_records(source: dict) -> tuple[list[tuple], list[tuple], dict]:
    facts = extract_facts(source)
    release = facts["release"]
    tileset = facts["tileset"]
    release_id = release["release_id"]
    capture_date = release["capture_date"]
    base_url = source["base_url"]
    root_transform = facts["root_transform"]
    origin_ecef = tuple(root_transform[index] for index in (12, 13, 14))
    longitude, latitude, height = ecef_to_geodetic(*origin_ecef)
    enu_to_ecef, ecef_to_enu = enu_matrices(
        origin_ecef, longitude, latitude
    )
    epoch_node = f"epoch:{capture_date}"
    frame_metadata = {
        "ecef_to_enu_column_major": ecef_to_enu,
        "enu_to_ecef_column_major": enu_to_ecef,
        "epoch_id": epoch_node,
        "ground_relationship": (
            "tileset root origin; no surveyed ground relation is established"
        ),
        "origin_ecef_metres": list(origin_ecef),
        "origin_wgs84": {
            "ellipsoid_height_metres": height,
            "latitude_degrees": latitude,
            "longitude_degrees": longitude,
        },
        "provenance": "tileset.json root.transform[12:15]",
        "tileset_root_transform_column_major": root_transform,
        "uncertainty": {
            "horizontal_metres": None,
            "vertical_metres": None,
        },
    }

    release_node = f"release:{release_id}"
    tileset_node = f"tileset:{release_id}"
    license_node = "license:cc-by-4.0"
    source_node = (
        f"source-manifest:sha256:{release['source_manifest_sha256']}"
    )
    world_crs_node = "crs:EPSG:4978"
    geodetic_crs_node = "crs:EPSG:4979"
    frame_node = f"frame:site-enu:{release_id}"

    nodes = [
        (
            epoch_node,
            "epoch",
            capture_date,
            None,
            None,
            None,
            None,
            canonical_json({"capture_date": capture_date}),
        ),
        (
            release_node,
            "release",
            release_id,
            urljoin(base_url, "release.json"),
            "application/json",
            facts["release_document"]["bytes"],
            facts["release_document"]["sha256"],
            canonical_json(
                {
                    "attribution": release["attribution"],
                    "capture_date": capture_date,
                    "publication_note": release["model_status"],
                    "schema_version": release["schema_version"],
                }
            ),
        ),
        (
            tileset_node,
            "tileset",
            f"{release_id} 3D Tiles",
            urljoin(base_url, "tileset.json"),
            "application/json",
            facts["tileset_document"]["bytes"],
            facts["tileset_document"]["sha256"],
            canonical_json(
                {
                    "asset_version": tileset["asset"]["version"],
                    "geometric_error_metres": tileset["geometricError"],
                    "root_bounding_volume": tileset["root"]["boundingVolume"],
                    "root_transform_column_major": root_transform,
                }
            ),
        ),
        (
            license_node,
            "license",
            release["content_license"],
            release["content_license_url"],
            "text/html",
            None,
            None,
            canonical_json({}),
        ),
        (
            source_node,
            "source_manifest",
            release["source_manifest_sha256"],
            None,
            None,
            None,
            release["source_manifest_sha256"],
            canonical_json(
                {
                    "identity_algorithm": "sha256",
                    "provenance": "release.json source_manifest_sha256",
                }
            ),
        ),
        (
            world_crs_node,
            "coordinate_reference_system",
            "WGS 84 geocentric (EPSG:4978)",
            "https://epsg.io/4978",
            "text/html",
            None,
            None,
            canonical_json(
                {
                    "axis_order": ["X", "Y", "Z"],
                    "identifier": "EPSG:4978",
                    "unit": "metre",
                }
            ),
        ),
        (
            geodetic_crs_node,
            "coordinate_reference_system",
            "WGS 84 geographic 3D (EPSG:4979)",
            "https://epsg.io/4979",
            "text/html",
            None,
            None,
            canonical_json(
                {
                    "axis_order": [
                        "latitude",
                        "longitude",
                        "ellipsoid_height",
                    ],
                    "identifier": "EPSG:4979",
                    "units": ["degree", "degree", "metre"],
                }
            ),
        ),
        (
            frame_node,
            "local_frame",
            f"{release_id} fixed site ENU",
            None,
            None,
            None,
            None,
            canonical_json(frame_metadata),
        ),
    ]

    asset_nodes = {}
    for asset in facts["content_assets"]:
        node_id = f"asset:sha256:{asset['sha256']}"
        asset_nodes[asset["path"]] = node_id
        nodes.append(
            (
                node_id,
                "content_asset",
                asset["sha256"],
                None,
                None,
                asset["bytes"],
                asset["sha256"],
                canonical_json(
                    {"identity_algorithm": "sha256"}
                ),
            )
        )

    validator_nodes = {}
    for validator in facts["validators"]:
        node_id = f"validator:{validator['tool']}@{validator['version']}"
        validator_nodes[
            (validator["tool"], validator["version"])
        ] = node_id
        nodes.append(
            (
                node_id,
                "validator",
                f"{validator['tool']} {validator['version']}",
                None,
                None,
                None,
                None,
                canonical_json(
                    {
                        "result": validator["result"],
                        "tool": validator["tool"],
                        "version": validator["version"],
                    }
                ),
            )
        )

    edges = [
        (epoch_node, "contains", release_node, canonical_json({})),
        (release_node, "contains", tileset_node, canonical_json({})),
        (
            release_node,
            "derived_from",
            source_node,
            canonical_json({}),
        ),
        (
            release_node,
            "licensed_under",
            license_node,
            canonical_json({}),
        ),
        (tileset_node, "uses_frame", frame_node, canonical_json({})),
        (
            frame_node,
            "derived_from",
            world_crs_node,
            canonical_json({"role": "world_coordinates"}),
        ),
        (
            frame_node,
            "derived_from",
            geodetic_crs_node,
            canonical_json({"role": "origin_definition"}),
        ),
    ]
    for path, node_id in sorted(asset_nodes.items()):
        edges.append(
            (
                tileset_node,
                "references",
                node_id,
                canonical_json(
                    {
                        "content_uri": path,
                        "media_type": _content_media_type(path),
                        "url": urljoin(base_url, path),
                    }
                ),
            )
        )
    for key, node_id in sorted(validator_nodes.items()):
        edges.append(
            (
                release_node,
                "validated_by",
                node_id,
                canonical_json({}),
            )
        )

    projection = {
        "assets": [
            {
                **asset,
                "url": urljoin(base_url, asset["path"]),
            }
            for asset in facts["content_assets"]
        ],
        "attribution": release["attribution"],
        "capture_date": capture_date,
        "content_bytes": sum(
            asset["bytes"] for asset in facts["content_assets"]
        ),
        "epoch_id": epoch_node,
        "license": {
            "name": release["content_license"],
            "url": release["content_license_url"],
        },
        "release_id": release_id,
        "schema_version": 1,
        "source_manifest_sha256": release["source_manifest_sha256"],
        "spatial": {
            **frame_metadata,
            "geodetic_crs": "EPSG:4979",
            "site_frame": frame_node,
            "world_crs": "EPSG:4978",
        },
        "tileset_url": urljoin(base_url, "tileset.json"),
        "validators": facts["validators"],
    }
    return sorted(nodes), sorted(edges), projection


def _merge_records(records: list[tuple], label: str) -> list[tuple]:
    merged = {}
    for record in records:
        key = record[0] if label == "node" else record
        existing = merged.get(key)
        if existing is not None and existing != record:
            raise ValueError(f"conflicting {label} record: {key}")
        merged[key] = record
    return sorted(merged.values())


def catalog_records(sources: list[dict]) -> tuple[list[tuple], list[tuple], dict]:
    if not sources:
        raise ValueError("at least one accepted release source is required")

    nodes = []
    edges = []
    releases = {}
    for source in sorted(sources, key=lambda item: item["base_url"]):
        source_nodes, source_edges, projection = graph_records(source)
        release_id = projection["release_id"]
        existing = releases.get(release_id)
        if existing is not None and existing != projection:
            raise ValueError(f"conflicting release projection: {release_id}")
        releases[release_id] = projection
        nodes.extend(source_nodes)
        edges.extend(source_edges)

    projection = {
        "releases": sorted(
            releases.values(),
            key=lambda release: (
                release["capture_date"],
                release["release_id"],
            ),
        ),
        "schema_version": 2,
    }
    return (
        _merge_records(nodes, "node"),
        _merge_records(edges, "edge"),
        projection,
    )


def _write_database(
    database_path: Path,
    sources: list[dict],
    nodes: list[tuple],
    edges: list[tuple],
) -> None:
    metadata = [
        ("catalog_schema_version", canonical_json(2)),
        (
            "source_urls",
            canonical_json(
                [
                    {
                        "base_url": source["base_url"],
                        "release_id": source["documents"]["release.json"][
                            "release_id"
                        ],
                        "manifests": {
                            name: urljoin(source["base_url"], name)
                            for name in MANIFEST_NAMES
                        },
                    }
                    for source in sorted(
                        sources, key=lambda item: item["base_url"]
                    )
                ]
            ),
        ),
    ]
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA page_size = 4096")
        connection.execute("PRAGMA journal_mode = OFF")
        connection.execute("PRAGMA synchronous = OFF")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(SCHEMA)
        with connection:
            connection.executemany(
                "INSERT INTO metadata (key, value_json) VALUES (?, ?)",
                metadata,
            )
            connection.executemany(
                """
                INSERT INTO nodes (
                    id, kind, name, uri, media_type, bytes, sha256,
                    metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                nodes,
            )
            connection.executemany(
                """
                INSERT INTO edges (
                    source_id, relation, target_id, metadata_json
                ) VALUES (?, ?, ?, ?)
                """,
                edges,
            )
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("SQLite foreign key check failed")
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        connection.execute("VACUUM")
    finally:
        connection.close()


def build_catalog(
    output_dir: Path,
    source: dict | list[dict] | tuple[dict, ...] | None = None,
) -> dict:
    if source is None:
        sources = [fetch_manifests()]
    elif isinstance(source, dict):
        sources = [source]
    else:
        sources = list(source)
    nodes, edges, projection = catalog_records(sources)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    database_path = output_dir / "catalog.sqlite3"
    projection_path = output_dir / "catalog.json"
    temporary_database = output_dir / "catalog.sqlite3.tmp"
    temporary_projection = output_dir / "catalog.json.tmp"

    for path in (temporary_database, temporary_projection):
        path.unlink(missing_ok=True)
    try:
        temporary_projection.write_text(
            json.dumps(
                projection,
                allow_nan=False,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        _write_database(temporary_database, sources, nodes, edges)
        temporary_database.replace(database_path)
        temporary_projection.replace(projection_path)
    finally:
        temporary_database.unlink(missing_ok=True)
        temporary_projection.unlink(missing_ok=True)

    return {
        "content_bytes": sum(
            release["content_bytes"] for release in projection["releases"]
        ),
        "database": str(database_path),
        "edges": len(edges),
        "json": str(projection_path),
        "nodes": len(nodes),
        "releases": len(projection["releases"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Build a deterministic SQLite/JSON asset graph from the accepted "
            "public cemetery release manifests."
        )
    )
    parser.add_argument(
        "--base-url",
        action="append",
        dest="base_urls",
        help=(
            "Directory URL containing one accepted release's three manifests. "
            "Repeat for every release; defaults to the published baseline."
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for catalog.sqlite3 and catalog.json.",
    )
    arguments = parser.parse_args()
    base_urls = arguments.base_urls or [DEFAULT_BASE_URL]
    sources = [fetch_manifests(base_url) for base_url in base_urls]
    print(canonical_json(build_catalog(arguments.output, sources)))


if __name__ == "__main__":
    main()
