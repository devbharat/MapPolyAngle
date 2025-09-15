/**
 * Flat-ground GSD test (no GUI)
 *
 * Scenario:
 * - Single square area of 1 km x 1 km (1,000,000 m^2), perfectly flat
 * - Flight at 100 m AGL
 * - 70% front overlap, 70% side overlap
 * - Direction does not matter for flat terrain
 *
 * This script computes per‑camera flight spacing and theoretical GSD, and emits
 * a simple GSDStats object (no assertions yet). It does not fetch terrain or use workers.
 *
 * Run (one option):
 *   npx ts-node src/tests/flat_gsd.test.ts
 * or configure your preferred TS runner.
 */

import {
  SONY_RX1R2,
  DJI_ZENMUSE_P1_24MM,
  ILX_LR1_INSPECT_85MM,
  MAP61_17MM,
  RGB61_24MM,
  calculateGSD,
  forwardSpacing,
  lineSpacing,
} from "../domain/camera.ts";

import type { CameraModel } from "../domain/types.ts";

type GSDStats = {
  min: number;
  max: number;
  mean: number;
  count: number;
  totalAreaM2?: number;
  histogram: { bin: number; count: number; areaM2?: number }[];
};

const AREA_SIDE_M = 1000; // 1 km
const AREA_M2 = AREA_SIDE_M * AREA_SIDE_M; // 1,000,000 m^2

const FRONT_OVERLAP = 70; // %
const SIDE_OVERLAP = 70; // %

function gsdStatsForFlat(camera: CameraModel, altitudeAGL: number, areaM2: number): GSDStats {
  const gsd = calculateGSD(camera, altitudeAGL);
  // Flat, nadir assumption -> GSD is uniform. Single-bin histogram over whole area.
  return {
    min: gsd,
    max: gsd,
    mean: gsd,
    count: 1, // not meaningful here; using 1 to indicate a single uniform value
    totalAreaM2: areaM2,
    histogram: [{ bin: gsd, count: 1, areaM2: areaM2 }],
  };
}

// Build simple axis-aligned flight lines across a W x H rectangle in meters.
// Lines run along X from (0,y) to (W,y), spaced by `lineSpacing` along Y.
function buildFlightLinesRect(widthM: number, heightM: number, lineSpacingM: number): Array<[[number,number],[number,number]]> {
  const lines: Array<[[number,number],[number,number]]> = [];
  if (lineSpacingM <= 0) return lines;
  const rows = Math.max(1, Math.ceil(heightM / lineSpacingM));
  for (let i = 0; i < rows; i++) {
    const y = Math.min(heightM, i * lineSpacingM);
    lines.push([[0, y], [widthM, y]]);
  }
  return lines;
}

// Sample photo trigger points along each line at `forwardSpacingM`.
function samplePhotosOnLines(lines: Array<[[number,number],[number,number]]>, forwardSpacingM: number): Array<[number,number]> {
  const points: Array<[number,number]> = [];
  if (forwardSpacingM <= 0) return points;
  for (const [[x0, y0], [x1, y1]] of lines) {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.floor(length / forwardSpacingM));
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(1, (s * forwardSpacingM) / length);
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      points.push([x, y]);
    }
  }
  return points;
}

function describeCamera(cam: CameraModel): string {
  // Prefer first friendly name if available
  // @ts-ignore optional names in CameraModel
  const names: string[] | undefined = cam.names;
  return names?.[0] || `f=${cam.f_m}m, ${cam.w_px}x${cam.h_px}`;
}

function runForAltitude(ALT_AGL: number) {
  const cameras: Record<string, CameraModel> = {
    SONY_RX1R2,
    DJI_ZENMUSE_P1_24MM,
    ILX_LR1_INSPECT_85MM,
    MAP61_17MM,
    RGB61_24MM,
  };

  console.log("=== Flat-ground GSD test ===");
  console.log(`Area: ${AREA_SIDE_M}m x ${AREA_SIDE_M}m (${(AREA_M2/1_000_000).toFixed(2)} km²)`);
  console.log(`Altitude AGL: ${ALT_AGL} m`);
  console.log(`Overlap: front=${FRONT_OVERLAP}%, side=${SIDE_OVERLAP}%`);
  console.log("");

  for (const [key, cam] of Object.entries(cameras)) {
    const gsd = calculateGSD(cam, ALT_AGL);
    const spacingForward = forwardSpacing(cam, ALT_AGL, FRONT_OVERLAP);
    const spacingLine = lineSpacing(cam, ALT_AGL, SIDE_OVERLAP);
    const stats = gsdStatsForFlat(cam, ALT_AGL, AREA_M2);

    const lines = buildFlightLinesRect(AREA_SIDE_M, AREA_SIDE_M, spacingLine);
    const photos = samplePhotosOnLines(lines, spacingForward);

    console.log(`Camera: ${key} (${describeCamera(cam)})`);
    console.log(`  GSD @ ${ALT_AGL}m: ${(gsd * 100).toFixed(2)} cm/px`);
    console.log(`  Forward spacing (70%): ${spacingForward.toFixed(2)} m`);
    console.log(`  Line spacing (70%):    ${spacingLine.toFixed(2)} m`);
    console.log(`  Flight lines: ${lines.length}, photos: ${photos.length}`);
    console.log(`  GSD stats: min=${(stats.min*100).toFixed(2)} cm, mean=${(stats.mean*100).toFixed(2)} cm, max=${(stats.max*100).toFixed(2)} cm`);
    console.log(`  Histogram bins: ${stats.histogram.length} (single bin @ ${(stats.histogram[0].bin*100).toFixed(2)} cm, area=${(stats.histogram[0].areaM2||0).toFixed(0)} m²)`);
    console.log("");
  }
}

function run() {
  const altitudes = [70, 100, 120];
  for (const alt of altitudes) {
    runForAltitude(alt);
  }
}

// Execute when run directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("flat_gsd.test.ts")) {
  run();
}

export { run };
