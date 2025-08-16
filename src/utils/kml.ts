// FILE: src/utils/kml.ts
export type ParsedKmlPolygon = {
  name?: string;
  ring: [number, number][]; // [lng, lat]
};

export type BoundingBox = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

/** Calculate bounding box for a set of KML polygons */
export function calculateKmlBounds(polygons: ParsedKmlPolygon[]): BoundingBox | null {
  if (polygons.length === 0) return null;

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const poly of polygons) {
    for (const [lng, lat] of poly.ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  return { minLng, minLat, maxLng, maxLat };
}

/** Parse the first outer LinearRing of every Polygon in a KML string. */
export function parseKmlPolygons(kmlText: string): ParsedKmlPolygon[] {
  const out: ParsedKmlPolygon[] = [];

  const doc = new DOMParser().parseFromString(kmlText, "application/xml");
  // Handle parser errors
  const parseErr = doc.getElementsByTagName("parsererror");
  if (parseErr && parseErr.length > 0) {
    throw new Error("Invalid KML: XML parsing failed.");
  }

  // Helper: parse a <coordinates> block into a ring
  const parseCoords = (coordText: string): [number, number][] => {
    const coords: [number, number][] = [];
    // KML coordinates can be newline/space separated with lon,lat[,alt]
    coordText
      .trim()
      .split(/\s+/)
      .forEach((token) => {
        const parts = token.split(",");
        if (parts.length >= 2) {
          const lng = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          if (Number.isFinite(lng) && Number.isFinite(lat)) {
            coords.push([lng, lat]);
          }
        }
      });

    // Ensure at least 3 points
    if (coords.length < 3) return [];

    // Ensure ring is closed
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coords.push([first[0], first[1]]);
    }
    return coords;
  };

  // Iterate through all Placemarks; support both Polygon and MultiGeometry
  const placemarks = Array.from(doc.getElementsByTagName("Placemark"));
  for (const pm of placemarks) {
    const nameEl = pm.getElementsByTagName("name")[0];
    const name = nameEl?.textContent?.trim() || undefined;

    // Handle Polygon(s) directly under Placemark
    const polygons = Array.from(pm.getElementsByTagName("Polygon"));
    for (const poly of polygons) {
      const outer = poly.getElementsByTagName("outerBoundaryIs")[0] ||
                    poly.getElementsByTagName("outerboundaryis")[0]; // robustness
      if (!outer) continue;
      const lr = outer.getElementsByTagName("LinearRing")[0];
      if (!lr) continue;
      const coordsEl = lr.getElementsByTagName("coordinates")[0];
      if (!coordsEl || !coordsEl.textContent) continue;

      const ring = parseCoords(coordsEl.textContent);
      if (ring.length >= 4) out.push({ name, ring });
    }

    // Also handle Polygon inside MultiGeometry (already covered by query above)
    // The above query finds nested Polygons too, so no extra handling needed here.
  }

  // Fallback: some KML authors wrap Polygons differently; catch any remaining.
  if (out.length === 0) {
    const polys = Array.from(doc.getElementsByTagName("Polygon"));
    for (const poly of polys) {
      const lr = poly.getElementsByTagName("LinearRing")[0];
      const coordsEl = lr?.getElementsByTagName("coordinates")[0];
      if (!coordsEl?.textContent) continue;
      const ring = parseCoords(coordsEl.textContent);
      if (ring.length >= 4) out.push({ ring });
    }
  }

  return out;
}
