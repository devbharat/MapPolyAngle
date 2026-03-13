#!/usr/bin/env python3
"""
Build and serve a side-by-side lidar mission comparison page.

Left pane:
- actual delivered LAS density raster
- planned polygons
- actual flown trajectory

Right pane:
- iframe of the running webapp for visual comparison

Example:
  python3 scripts/compare_lidar_mission.py \
    --mission-root /Volumes/Untitled/Ecores \
    --webapp-url http://127.0.0.1:5180/
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import socketserver
import threading
import webbrowser
from dataclasses import dataclass
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any

import laspy
import numpy as np
from pyproj import CRS, Transformer
from shapely import contains_xy
from shapely.geometry import Polygon
from shapely.ops import unary_union


WGS84 = CRS.from_epsg(4326)
DEFAULT_CELL_SIZE_M = 5.0
DEFAULT_PORT = 8765


@dataclass
class PlannedArea:
    area_index: int
    polygon_wgs84: list[list[float]]
    polygon_projected: Polygon
    centroid_wgs84: list[float]
    area_m2: float
    altitude_m: float
    spacing_m: float
    point_density_planned: float | None
    angle_deg: float | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Visual compare actual lidar density against the webapp.")
    parser.add_argument("--mission-root", required=True, help="Mission folder or parent folder containing the mission data.")
    parser.add_argument("--flightplan", help="Optional explicit .flightplan path.")
    parser.add_argument("--webapp-url", default="http://127.0.0.1:5180/", help="URL of the running webapp to embed on the right side.")
    parser.add_argument(
        "--mapbox-token",
        default=os.getenv("VITE_MAPBOX_TOKEN") or os.getenv("VITE_MAPBOX_ACCESS_TOKEN") or os.getenv("MAPBOX_TOKEN") or "",
        help="Optional Mapbox token for rendering the left pane with Mapbox satellite + terrain.",
    )
    parser.add_argument("--cell-size", type=float, default=DEFAULT_CELL_SIZE_M, help="Density raster cell size in meters.")
    parser.add_argument("--trajectory-decimate", type=int, default=20, help="Keep every Nth trajectory sample.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Local server port.")
    parser.add_argument("--output-dir", help="Optional output directory. Defaults to .mission_compare/<mission-name>.")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open the browser.")
    parser.add_argument("--generate-only", action="store_true", help="Only generate the HTML and JSON files, do not start a server.")
    return parser.parse_args()


def find_files(mission_root: Path, explicit_flightplan: str | None) -> tuple[Path, list[Path], list[Path]]:
    if explicit_flightplan:
        flightplan = Path(explicit_flightplan).expanduser().resolve()
    else:
        flightplans = sorted(mission_root.rglob("*.flightplan"))
        if len(flightplans) != 1:
            raise SystemExit(
                f"Expected exactly one .flightplan under {mission_root}, found {len(flightplans)}. "
                "Pass --flightplan explicitly."
            )
        flightplan = flightplans[0]

    las_files = sorted([p for p in mission_root.rglob("*.las") if "Point Clouds" in str(p)])
    if not las_files:
        raise SystemExit(f"No .las files found under {mission_root}")

    trajectory_files = sorted(
        [
            p
            for p in mission_root.rglob("*.txt")
            if "trajectory" in p.name.lower() and "Outputs And Reports" in str(p)
        ]
    )
    if not trajectory_files:
        raise SystemExit(f"No trajectory .txt files found under {mission_root}")

    return flightplan, las_files, trajectory_files


def load_las_crs(las_files: list[Path]) -> CRS:
    with laspy.open(las_files[0]) as las:
        crs = las.header.parse_crs()
    if crs is None:
        raise SystemExit(f"No CRS found in {las_files[0]}")
    for path in las_files[1:]:
        with laspy.open(path) as las:
            other = las.header.parse_crs()
        if other is None or other.to_string() != crs.to_string():
            raise SystemExit(f"Mismatched LAS CRS: {path} has {other}, expected {crs}")
    return crs


def load_planned_areas(flightplan_path: Path, target_crs: CRS) -> tuple[list[PlannedArea], dict[str, Any]]:
    with flightplan_path.open() as f:
        doc = json.load(f)
    fp = doc["flightPlan"]
    items = [it for it in fp.get("items", []) if it.get("type") == "ComplexItem" and it.get("complexItemType") == "area"]
    to_projected = Transformer.from_crs(WGS84, target_crs, always_xy=True)
    areas: list[PlannedArea] = []
    for idx, item in enumerate(items, start=1):
        ring_wgs84 = [[pt[1], pt[0]] for pt in item["polygon"]]
        if ring_wgs84[0] != ring_wgs84[-1]:
            ring_wgs84.append(ring_wgs84[0])
        xs, ys = to_projected.transform([pt[0] for pt in ring_wgs84], [pt[1] for pt in ring_wgs84])
        polygon_projected = Polygon(zip(xs, ys))
        centroid = polygon_projected.centroid
        to_wgs84 = Transformer.from_crs(target_crs, WGS84, always_xy=True)
        centroid_lon, centroid_lat = to_wgs84.transform(centroid.x, centroid.y)
        areas.append(
            PlannedArea(
                area_index=idx,
                polygon_wgs84=ring_wgs84,
                polygon_projected=polygon_projected,
                centroid_wgs84=[centroid_lon, centroid_lat],
                area_m2=polygon_projected.area,
                altitude_m=float(item["grid"].get("altitude", 0)),
                spacing_m=float(item["grid"].get("spacing", 0)),
                point_density_planned=item["camera"].get("pointDensity"),
                angle_deg=item["grid"].get("angle"),
            )
        )
    if not areas:
        raise SystemExit(f"No Wingtra area items found in {flightplan_path}")
    return areas, doc


def load_trajectories(trajectory_files: list[Path], target_crs: CRS, decimate: int) -> tuple[list[dict[str, Any]], dict[str, float]]:
    to_projected = Transformer.from_crs(WGS84, target_crs, always_xy=True)
    trajectories: list[dict[str, Any]] = []
    speeds: list[float] = []

    for idx, path in enumerate(trajectory_files, start=1):
        points: list[list[float]] = []
        raw: list[tuple[float, float, float]] = []
        with path.open(newline="") as f:
            reader = csv.DictReader(f, delimiter="\t")
            for row_num, row in enumerate(reader):
                t = float(row["GPSTime"])
                lon = float(row["Longitude"])
                lat = float(row["Latitude"])
                z = float(row["H-Ell"])
                x, y = to_projected.transform(lon, lat)
                raw.append((t, x, y))
                if row_num % max(1, decimate) == 0:
                    points.append([lon, lat, z])

        for (t1, x1, y1), (t2, x2, y2) in zip(raw, raw[1:]):
            dt = t2 - t1
            if dt <= 0:
                continue
            speeds.append(math.hypot(x2 - x1, y2 - y1) / dt)

        trajectories.append(
            {
                "id": idx,
                "name": path.stem,
                "points": points,
            }
        )

    if not speeds:
        return trajectories, {"mean_mps": 0.0, "p50_mps": 0.0, "p90_mps": 0.0}

    speeds_arr = np.sort(np.array(speeds, dtype=np.float64))
    return trajectories, {
        "mean_mps": float(speeds_arr.mean()),
        "p50_mps": float(np.quantile(speeds_arr, 0.5)),
        "p90_mps": float(np.quantile(speeds_arr, 0.9)),
    }


def build_density_grid(
    areas: list[PlannedArea],
    las_files: list[Path],
    cell_size_m: float,
) -> tuple[list[dict[str, float]], list[dict[str, Any]], dict[str, float]]:
    union_polygon = unary_union([area.polygon_projected for area in areas])
    minx, miny, maxx, maxy = union_polygon.bounds
    width = max(1, int(math.ceil((maxx - minx) / cell_size_m)))
    height = max(1, int(math.ceil((maxy - miny) / cell_size_m)))
    grid = np.zeros((height, width), dtype=np.uint32)
    area_point_counts = [0 for _ in areas]

    to_wgs84 = Transformer.from_crs(load_las_crs(las_files), WGS84, always_xy=True)
    polygon_bounds = [area.polygon_projected.bounds for area in areas]

    for las_path in las_files:
        with laspy.open(las_path) as las:
            for chunk in las.chunk_iterator(1_000_000):
                xs = chunk.x
                ys = chunk.y

                bbox_mask = (xs >= minx) & (xs <= maxx) & (ys >= miny) & (ys <= maxy)
                if bbox_mask.any():
                    xs_bbox = xs[bbox_mask]
                    ys_bbox = ys[bbox_mask]
                    cols = np.floor((xs_bbox - minx) / cell_size_m).astype(np.int32)
                    rows = np.floor((ys_bbox - miny) / cell_size_m).astype(np.int32)
                    valid = (cols >= 0) & (cols < width) & (rows >= 0) & (rows < height)
                    if valid.any():
                        np.add.at(grid, (rows[valid], cols[valid]), 1)

                for idx, area in enumerate(areas):
                    bminx, bminy, bmaxx, bmaxy = polygon_bounds[idx]
                    mask = (xs >= bminx) & (xs <= bmaxx) & (ys >= bminy) & (ys <= bmaxy)
                    if not mask.any():
                        continue
                    inside = contains_xy(area.polygon_projected, xs[mask], ys[mask])
                    area_point_counts[idx] += int(np.count_nonzero(inside))

    nonzero_rows, nonzero_cols = np.nonzero(grid)
    if nonzero_rows.size == 0:
        raise SystemExit("No density cells were produced from the LAS files.")

    center_x = minx + (nonzero_cols + 0.5) * cell_size_m
    center_y = miny + (nonzero_rows + 0.5) * cell_size_m
    inside_union = contains_xy(union_polygon, center_x, center_y)
    center_x = center_x[inside_union]
    center_y = center_y[inside_union]
    cell_counts = grid[nonzero_rows[inside_union], nonzero_cols[inside_union]].astype(np.float64)
    density = cell_counts / (cell_size_m * cell_size_m)
    lon, lat = to_wgs84.transform(center_x, center_y)

    cells = [
        {"lon": float(lo), "lat": float(la), "density": float(de)}
        for lo, la, de in zip(lon.tolist(), lat.tolist(), density.tolist())
    ]

    per_area = []
    total_points = 0
    sum_area = 0.0
    for area, point_count in zip(areas, area_point_counts):
        actual_density = point_count / area.area_m2 if area.area_m2 > 0 else 0.0
        per_area.append(
            {
                "areaIndex": area.area_index,
                "areaAcres": area.area_m2 / 4046.8564224,
                "areaM2": area.area_m2,
                "plannedPtsM2": area.point_density_planned,
                "actualPtsM2": actual_density,
                "pointCount": point_count,
                "altitudeM": area.altitude_m,
                "spacingM": area.spacing_m,
            }
        )
        total_points += point_count
        sum_area += area.area_m2

    metrics = {
        "overallActualPtsM2": (total_points / sum_area) if sum_area > 0 else 0.0,
        "densityMin": float(np.min(density)),
        "densityMax": float(np.max(density)),
        "densityMean": float(np.mean(density)),
        "densityP90": float(np.quantile(density, 0.9)),
    }
    return cells, per_area, metrics


def make_output_dir(args: argparse.Namespace, mission_root: Path) -> Path:
    if args.output_dir:
        out = Path(args.output_dir).expanduser().resolve()
    else:
        slug = mission_root.name.lower().replace(" ", "-")
        if not slug:
            slug = "mission"
        out = (Path.cwd() / ".mission_compare" / f"{slug}-cell-{str(args.cell_size).replace('.', '_')}m").resolve()
    out.mkdir(parents=True, exist_ok=True)
    return out


def build_payload(
    mission_root: Path,
    flightplan_path: Path,
    areas: list[PlannedArea],
    trajectories: list[dict[str, Any]],
    trajectory_stats: dict[str, float],
    density_cells: list[dict[str, float]],
    per_area_stats: list[dict[str, Any]],
    metrics: dict[str, float],
    webapp_url: str,
    cell_size_m: float,
    las_files: list[Path],
    flightplan_doc: dict[str, Any],
    mapbox_token: str,
) -> dict[str, Any]:
    union_polygon = unary_union([area.polygon_projected for area in areas])
    bounds_lonlat = []
    to_wgs84 = Transformer.from_crs(load_las_crs(las_files), WGS84, always_xy=True)
    minx, miny, maxx, maxy = union_polygon.bounds
    for x, y in [(minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy)]:
        lon, lat = to_wgs84.transform(x, y)
        bounds_lonlat.append([lon, lat])

    return {
        "missionName": mission_root.name,
        "missionRoot": str(mission_root),
        "flightplanPath": str(flightplan_path),
        "webappUrl": webapp_url,
        "mapboxToken": mapbox_token,
        "cellSizeM": cell_size_m,
        "bounds": {
            "minLon": min(pt[0] for pt in bounds_lonlat),
            "minLat": min(pt[1] for pt in bounds_lonlat),
            "maxLon": max(pt[0] for pt in bounds_lonlat),
            "maxLat": max(pt[1] for pt in bounds_lonlat),
        },
        "plannedAreas": [
            {
                "areaIndex": area.area_index,
                "ring": area.polygon_wgs84,
                "label": f"Area {area.area_index}",
                "centroid": area.centroid_wgs84,
                "plannedPtsM2": area.point_density_planned,
                "altitudeM": area.altitude_m,
                "spacingM": area.spacing_m,
            }
            for area in areas
        ],
        "trajectories": trajectories,
        "trajectoryStats": trajectory_stats,
        "densityCells": density_cells,
        "perAreaStats": per_area_stats,
        "densityMetrics": metrics,
        "flightplanSummary": {
            "payload": flightplan_doc["flightPlan"].get("payload"),
            "payloadKey": flightplan_doc["flightPlan"].get("payloadUniqueString"),
            "cruiseSpeed": flightplan_doc["flightPlan"].get("cruiseSpeed"),
            "totalFlightDistance": flightplan_doc["flightPlan"].get("totalFlightDistance"),
        },
    }


def build_html(payload: dict[str, Any]) -> str:
    payload_json = json.dumps(payload, separators=(",", ":"))
    use_mapbox = bool(payload.get("mapboxToken"))
    map_css_href = (
        "https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css"
        if use_mapbox
        else "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css"
    )
    map_js_src = (
        "https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js"
        if use_mapbox
        else "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"
    )
    terrain_note = (
        "The left pane is rendered over Mapbox satellite imagery with terrain enabled."
        if use_mapbox
        else "The left pane is rendered over a flat basemap because no Mapbox token was provided."
    )
    map_setup_js = """
    const useMapboxTerrain = Boolean(payload.mapboxToken);
    const mapLib = useMapboxTerrain ? mapboxgl : maplibregl;
    if (useMapboxTerrain) {
      mapboxgl.accessToken = payload.mapboxToken;
    }

    const map = new mapLib.Map({
      container: 'actual-map',
      style: useMapboxTerrain
        ? 'mapbox://styles/mapbox/satellite-v9'
        : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center,
      zoom,
      pitch: 58,
      bearing: -18,
      hash: false,
      antialias: true
    });
    map.addControl(new mapLib.NavigationControl({ visualizePitch: true }), 'top-left');

    map.on('load', () => {
      const groundAt = (lon, lat) => {
        if (!useMapboxTerrain || typeof map.queryTerrainElevation !== 'function') return 0;
        return map.queryTerrainElevation([lon, lat], { exaggerated: false }) ?? 0;
      };

      const buildOverlayData = () => {
        const densityCells = payload.densityCells.map((cell) => ({
          ...cell,
          position: [cell.lon, cell.lat, groundAt(cell.lon, cell.lat) + 1.5],
        }));

        const plannedAreas = payload.plannedAreas.map((area) => ({
          ...area,
          ring3d: area.ring.map(([lon, lat]) => [lon, lat, groundAt(lon, lat) + 2]),
          centroid3d: [
            area.centroid[0],
            area.centroid[1],
            groundAt(area.centroid[0], area.centroid[1]) + 6,
          ],
        }));

        const trajectories = payload.trajectories.map((trajectory) => ({
          ...trajectory,
          points3d: trajectory.points.map(([lon, lat, z]) => {
            const ground = groundAt(lon, lat);
            const absoluteZ = Number.isFinite(z) ? z : ground + 12;
            return [lon, lat, Math.max(absoluteZ, ground + 8)];
          }),
        }));

        return { densityCells, plannedAreas, trajectories };
      };

      const addOverlay = () => {
        const overlayData = buildOverlayData();

        const densityLayer = new deck.GridCellLayer({
          id: 'density-grid',
          data: overlayData.densityCells,
          cellSize: payload.cellSizeM,
          pickable: true,
          extruded: false,
          opacity: 0.76,
          getPosition: d => d.position,
          getFillColor: d => densityColor(d.density),
          getTooltip: d => d && `Delivered density: ${d.object.density.toFixed(1)} pts/m²`
        });

        const areaLayer = new deck.PolygonLayer({
          id: 'planned-areas',
          data: overlayData.plannedAreas,
          stroked: true,
          filled: false,
          lineWidthMinPixels: 2,
          getPolygon: d => d.ring3d,
          getLineColor: [17, 24, 39, 210],
        });

        const labelLayer = new deck.TextLayer({
          id: 'area-labels',
          data: overlayData.plannedAreas,
          pickable: false,
          getPosition: d => d.centroid3d,
          getText: d => String(d.areaIndex),
          getColor: [17, 24, 39, 255],
          getSize: 18,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          background: true,
          getBackgroundColor: [255, 255, 255, 220],
        });

        const trajectoryLayer = new deck.PathLayer({
          id: 'trajectories',
          data: overlayData.trajectories,
          pickable: true,
          widthMinPixels: 1,
          rounded: true,
          jointRounded: true,
          getPath: d => d.points3d,
          getColor: d => d.id % 2 === 0 ? [239, 68, 68, 210] : [245, 158, 11, 210],
          getWidth: 2,
        });

        const overlay = new deck.MapboxOverlay({
          interleaved: false,
          layers: [densityLayer, areaLayer, labelLayer, trajectoryLayer]
        });
        map.addControl(overlay);
        map.fitBounds([[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]], { padding: 40, duration: 0, maxZoom: 16 });
      };

      if (useMapboxTerrain) {
        map.addSource('mapbox-dem', {
          type: 'raster-dem',
          url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
          tileSize: 512,
          maxzoom: 14,
        });
        map.setTerrain({ source: 'mapbox-dem', exaggeration: 1 });
        map.setFog({
          range: [-0.5, 2],
          color: 'white',
          'high-color': '#1d2b53',
          'space-color': '#d7e7ff',
          'star-intensity': 0,
        });
        map.once('idle', addOverlay);
      } else {
        addOverlay();
      }
    });
    """
    html = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lidar Mission Compare - __MISSION_NAME__</title>
  <link href="__MAP_CSS_HREF__" rel="stylesheet" />
  <style>
    html, body {{ margin: 0; height: 100%; font-family: ui-sans-serif, system-ui, sans-serif; background: #f4f7fb; color: #152238; }}
    .layout {{ display: grid; grid-template-columns: 1fr 1fr; height: 100vh; gap: 0; }}
    .panel {{ display: grid; grid-template-rows: auto minmax(420px, 1fr) auto; min-width: 0; border-right: 1px solid #d5dde8; background: white; }}
    .panel:last-child {{ border-right: 0; }}
    .header {{ padding: 12px 14px; border-bottom: 1px solid #e3eaf2; background: linear-gradient(135deg, #f9fbff 0%, #eef5ff 100%); }}
    .title {{ font-weight: 700; font-size: 15px; }}
    .meta {{ margin-top: 6px; font-size: 12px; color: #5b6b84; line-height: 1.45; }}
    .map {{ position: relative; min-height: 420px; }}
    #actual-map {{ position: absolute; inset: 0; }}
    .iframe-wrap {{ position: relative; min-height: 420px; background: #e9eef5; }}
    iframe {{ position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: white; }}
    .footer {{ padding: 10px 14px; border-top: 1px solid #e3eaf2; background: #fbfdff; font-size: 12px; color: #44536a; max-height: 34vh; overflow: auto; }}
    .legend {{ position: absolute; right: 14px; bottom: 14px; background: rgba(255,255,255,0.92); border: 1px solid rgba(21,34,56,0.12); border-radius: 10px; padding: 10px 12px; box-shadow: 0 8px 30px rgba(21,34,56,0.12); width: 200px; }}
    .legend h4 {{ margin: 0 0 8px; font-size: 12px; }}
    .gradient {{ height: 10px; border-radius: 999px; background: linear-gradient(90deg, #d73027 0%, #f46d43 18%, #fee08b 44%, #74add1 70%, #313695 100%); }}
    .legend-row {{ display: flex; justify-content: space-between; font-size: 11px; color: #5b6b84; margin-top: 6px; }}
    .stats {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }}
    .stat {{ background: #ffffff; border: 1px solid #e1e8f0; border-radius: 10px; padding: 8px 10px; }}
    .stat .k {{ font-size: 11px; color: #67788f; }}
    .stat .v {{ margin-top: 2px; font-size: 16px; font-weight: 700; color: #132033; }}
    .table {{ width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }}
    .table th, .table td {{ padding: 5px 6px; border-bottom: 1px solid #edf2f7; text-align: right; }}
    .table th:first-child, .table td:first-child {{ text-align: left; }}
    .note {{ font-size: 11px; color: #6b7b93; margin-top: 8px; line-height: 1.4; }}
    @media (max-width: 1100px) {{
      .layout {{ grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }}
      .panel {{ border-right: 0; border-bottom: 1px solid #d5dde8; }}
      .panel:last-child {{ border-bottom: 0; }}
    }}
  </style>
</head>
<body>
  <div class="layout">
    <section class="panel">
      <div class="header">
        <div class="title">Actual Mission Data</div>
        <div class="meta">
          <div><strong>Mission:</strong> __MISSION_NAME__</div>
          <div><strong>Flightplan:</strong> __FLIGHTPLAN_PATH__</div>
          <div><strong>Areas:</strong> __AREA_COUNT__</div>
          <div><strong>Cell size:</strong> __CELL_SIZE__ m</div>
        </div>
        <div class="stats">
          <div class="stat"><div class="k">Overall actual density</div><div class="v" id="overall-actual"></div></div>
          <div class="stat"><div class="k">Trajectory mean speed</div><div class="v" id="mean-speed"></div></div>
          <div class="stat"><div class="k">Flightplan nominal</div><div class="v" id="planned-nominal"></div></div>
        </div>
      </div>
      <div class="map">
        <div id="actual-map"></div>
        <div class="legend">
          <h4>Delivered LAS Density</h4>
          <div class="gradient"></div>
          <div class="legend-row"><span id="legend-min"></span><span id="legend-max"></span></div>
          <div class="note">Red is lower delivered density. Blue is higher delivered density. Orange lines show the actual flown trajectory. The left pane uses the delivered cloud's own stretch, but the hue order matches the app.</div>
        </div>
      </div>
      <div class="footer">
        <table class="table" id="area-table"></table>
        <div class="note">
          The left pane uses actual LAS points inside each planned polygon. The right pane is your running webapp. Import the same flightplan there to compare the predicted raster against the delivered cloud.
        </div>
        <div class="note">__TERRAIN_NOTE__</div>
      </div>
    </section>
    <section class="panel">
      <div class="header">
        <div class="title">Webapp Comparison</div>
        <div class="meta">
          <div><strong>Embedded app:</strong> __WEBAPP_URL__</div>
          <div>Open the same mission in the app and compare the raster pattern, edge falloff, and overall density level.</div>
        </div>
      </div>
      <div class="iframe-wrap">
        <iframe src="__WEBAPP_URL__" title="Lidar webapp"></iframe>
      </div>
      <div class="footer">
        Suggested workflow: import the same flightplan on the right, then compare density magnitude and strip overlap against the actual delivered cloud on the left.
      </div>
    </section>
  </div>

  <script id="payload" type="application/json">__PAYLOAD_JSON__</script>
  <script src="__MAP_JS_SRC__"></script>
  <script src="https://unpkg.com/deck.gl@9.1.14/dist.min.js"></script>
  <script>
    const payload = JSON.parse(document.getElementById('payload').textContent);

    const paletteDensityMin = Math.max(0, payload.densityMetrics.densityMin);
    const paletteDensityMax = Math.max(
      paletteDensityMin + 1,
      payload.densityMetrics.densityP90
    );

    function heatmapColor(t) {{
      t = Math.max(0, Math.min(1, t));
      if (t < 0.25) {{
        const s = t / 0.25;
        return [0, Math.round(255 * s), 255];
      }} else if (t < 0.5) {{
        const s = (t - 0.25) / 0.25;
        return [0, 255, Math.round(255 * (1 - s))];
      }} else if (t < 0.75) {{
        const s = (t - 0.5) / 0.25;
        return [Math.round(255 * s), 255, 0];
      }}
      const s = (t - 0.75) / 0.25;
      return [255, Math.round(255 * (1 - s)), 0];
    }}

    function densityColor(value) {{
      const normalized = Math.max(0, Math.min(1, (value - paletteDensityMin) / (paletteDensityMax - paletteDensityMin)));
      const t = 1 - normalized;
      const [r, g, b] = heatmapColor(t);
      return [r, g, b, 185];
    }}

    const bounds = payload.bounds;
    const center = [(bounds.minLon + bounds.maxLon) / 2, (bounds.minLat + bounds.maxLat) / 2];
    const lonSpan = Math.max(0.001, bounds.maxLon - bounds.minLon);
    const latSpan = Math.max(0.001, bounds.maxLat - bounds.minLat);
    const zoom = Math.max(8, Math.min(16, Math.log2(360 / Math.max(lonSpan, latSpan)) - 1.2));

    document.getElementById('overall-actual').textContent = `${payload.densityMetrics.overallActualPtsM2.toFixed(1)} pts/m²`;
    document.getElementById('mean-speed').textContent = `${payload.trajectoryStats.mean_mps.toFixed(1)} m/s`;
    const plannedNominal = payload.perAreaStats.length > 0 && payload.perAreaStats[0].plannedPtsM2 != null
      ? payload.perAreaStats[0].plannedPtsM2
      : 0;
    document.getElementById('planned-nominal').textContent = `${plannedNominal.toFixed(1)} pts/m²`;
    document.getElementById('legend-min').textContent = `${paletteDensityMin.toFixed(1)} pts/m²`;
    document.getElementById('legend-max').textContent = `${paletteDensityMax.toFixed(1)} pts/m²`;

    const table = document.getElementById('area-table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Area</th>
          <th>Planned</th>
          <th>Actual</th>
          <th>Ratio</th>
        </tr>
      </thead>
      <tbody>
        ${payload.perAreaStats.map((row) => `
          <tr>
            <td>Area ${row.areaIndex}</td>
            <td>${row.plannedPtsM2 != null ? row.plannedPtsM2.toFixed(1) : 'n/a'}</td>
            <td>${row.actualPtsM2.toFixed(1)}</td>
            <td>${row.plannedPtsM2 ? (row.actualPtsM2 / row.plannedPtsM2).toFixed(2) : 'n/a'}</td>
          </tr>
        `).join('')}
      </tbody>
    `;

    __MAP_SETUP_JS__
  </script>
</body>
</html>
"""
    html = html.replace("{{", "{").replace("}}", "}")
    return (
        html.replace("__MISSION_NAME__", str(payload["missionName"]))
        .replace("__FLIGHTPLAN_PATH__", str(payload["flightplanPath"]))
        .replace("__AREA_COUNT__", str(len(payload["plannedAreas"])))
        .replace("__CELL_SIZE__", str(payload["cellSizeM"]))
        .replace("__WEBAPP_URL__", str(payload["webappUrl"]))
        .replace("__MAP_CSS_HREF__", map_css_href)
        .replace("__MAP_JS_SRC__", map_js_src)
        .replace("__MAP_SETUP_JS__", map_setup_js.strip())
        .replace("__TERRAIN_NOTE__", terrain_note)
        .replace("__PAYLOAD_JSON__", payload_json)
    )


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        return


def serve_directory(output_dir: Path, port: int) -> str:
    os.chdir(output_dir)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), QuietHandler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{port}/index.html"


def main() -> None:
    args = parse_args()
    mission_root = Path(args.mission_root).expanduser().resolve()
    if not mission_root.exists():
        raise SystemExit(f"Mission root does not exist: {mission_root}")

    flightplan_path, las_files, trajectory_files = find_files(mission_root, args.flightplan)
    las_crs = load_las_crs(las_files)
    areas, flightplan_doc = load_planned_areas(flightplan_path, las_crs)
    trajectories, trajectory_stats = load_trajectories(trajectory_files, las_crs, args.trajectory_decimate)
    density_cells, per_area_stats, metrics = build_density_grid(areas, las_files, args.cell_size)

    output_dir = make_output_dir(args, mission_root)
    payload = build_payload(
        mission_root=mission_root,
        flightplan_path=flightplan_path,
        areas=areas,
        trajectories=trajectories,
        trajectory_stats=trajectory_stats,
        density_cells=density_cells,
        per_area_stats=per_area_stats,
        metrics=metrics,
        webapp_url=args.webapp_url,
        cell_size_m=args.cell_size,
        las_files=las_files,
        flightplan_doc=flightplan_doc,
        mapbox_token=args.mapbox_token,
    )

    (output_dir / "index.html").write_text(build_html(payload))
    (output_dir / "payload.json").write_text(json.dumps(payload, indent=2))

    print(f"Wrote comparison page to {output_dir / 'index.html'}")
    print(f"Wrote payload JSON to {output_dir / 'payload.json'}")

    if args.generate_only:
        return

    url = serve_directory(output_dir, args.port)
    print(f"Serving {output_dir} at {url}")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
