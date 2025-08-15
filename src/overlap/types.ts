export type CameraModel = {
  f_m: number;      // focal length (meters)
  sx_m: number;     // pixel pitch x (meters)
  sy_m: number;     // pixel pitch y (meters)
  w_px: number;
  h_px: number;
  cx_px?: number;   // default: w/2
  cy_px?: number;   // default: h/2
};

export type PoseMeters = {
  id?: string;
  x: number;        // EPSG:3857 meters
  y: number;        // EPSG:3857 meters
  z: number;        // meters ASL (if AGL handled beforehand)
  omega_deg: number;
  phi_deg: number;
  kappa_deg: number;
};

export type TileRGBA = {
  z: number; x: number; y: number;
  size: number;             // 256 or 512
  data: Uint8ClampedArray;  // RGBA (Terrain-RGB)
};

export type TileResult = {
  z: number; x: number; y: number; size: number;
  maxOverlap: number;
  minGsd: number;   // finite min over tile or +Inf if none
  overlap: Uint16Array;
  gsdMin: Float32Array;
};

export type PolygonLngLat = { ring: [number, number][] }; // single-ring polygon

export type WorkerIn = {
  tile: TileRGBA;
  polygons: PolygonLngLat[];  // mask to these polygons
  poses: PoseMeters[];        // pre-converted to EPSG:3857 meters
  camera: CameraModel;
  options?: {
    gsdMaxForPalette?: number; // meters per pixel for visualization clamp
  };
};

export type WorkerOut = TileResult;
