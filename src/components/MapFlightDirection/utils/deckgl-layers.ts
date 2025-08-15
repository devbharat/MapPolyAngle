/***********************************************************************
 * utils/deckgl-layers.ts
 *
 * Functions for creating and managing Deck.gl layers for 3D visualization.
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, SolidPolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { destination as geoDestination, calculateBearing as geoBearing } from '@/utils/terrainAspectHybrid';

export function update3DPathLayer(
  overlay: MapboxOverlay,
  polygonId: string,
  path3d: [number, number, number][][],
  setLayers: React.Dispatch<React.SetStateAction<any[]>>
) {
  const layers: any[] = [];

  // Create a simple 3D path layer for each flight line segment
  path3d.forEach((segment, index) => {
    const pathLayer = new PathLayer({
      id: `drone-path-${polygonId}-${index}`,
      data: [segment],
      getPath: (d: any) => d,
      getColor: [30, 144, 255, 200], // Semi-transparent blue
      getWidth: 8, // 8 meter width
      widthUnits: 'meters',
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      billboard: false, // Keep it oriented in 3D space
      parameters: {
        depthTest: true,
        depthWrite: true,
      },
    });
    
    layers.push(pathLayer);
  });

  // Optional: Add a thinner centerline for better visibility
  const centerlineLayer = new PathLayer({
    id: `drone-centerline-${polygonId}`,
    data: path3d,
    getPath: (d: any) => d,
    getColor: [100, 200, 255, 255], // Bright blue centerline
    getWidth: 2,
    widthUnits: 'meters',
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    billboard: false,
    parameters: {
      depthTest: true,
      depthWrite: false, // Draw on top
    },
  });

  layers.push(centerlineLayer);

  setLayers((currentLayers) => {
    const filteredLayers = currentLayers.filter(
      (l) => !l.id.includes(`drone-`) || !l.id.includes(polygonId)
    );
    const newLayers = [...filteredLayers, ...layers];
    overlay.setProps({ layers: newLayers });
    return newLayers;
  });
}

export function remove3DPathLayer(
  overlay: MapboxOverlay,
  polygonId: string,
  setLayers: React.Dispatch<React.SetStateAction<any[]>>
) {
  setLayers((currentLayers) => {
    const filteredLayers = currentLayers.filter(
      (l) => !l.id.includes(`drone-path-${polygonId}`) && !l.id.includes(`drone-centerline-${polygonId}`)
    );
    overlay.setProps({ layers: filteredLayers });
    return filteredLayers;
  });
}

export function update3DCameraPointsLayer(
  overlay: MapboxOverlay,
  polygonId: string,
  cameraPositions: [number, number, number][],
  setLayers: React.Dispatch<React.SetStateAction<any[]>>
) {
  const cameraLayer = new ScatterplotLayer({
    id: `camera-points-${polygonId}`,
    data: cameraPositions.map((pos, index) => ({
      position: pos,
      index: index + 1,
      altitude: pos[2]
    })),
    getPosition: (d: any) => d.position,
    getRadius: 8,
    getFillColor: [255, 71, 87, 255], // Red color #ff4757
    getLineColor: [255, 255, 255, 255], // White outline
    lineWidthMinPixels: 2,
    radiusUnits: 'meters',
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    parameters: {
      depthTest: true,
      depthWrite: true,
    },
  });

  setLayers((currentLayers) => {
    // Remove existing camera points for this polygon
    const filteredLayers = currentLayers.filter(
      (l) => !l.id.includes(`camera-points-${polygonId}`)
    );
    const newLayers = [...filteredLayers, cameraLayer];
    overlay.setProps({ layers: newLayers });
    return newLayers;
  });
}

export function remove3DCameraPointsLayer(
  overlay: MapboxOverlay,
  polygonId: string,
  setLayers: React.Dispatch<React.SetStateAction<any[]>>
) {
  setLayers((currentLayers) => {
    const filteredLayers = currentLayers.filter(
      (l) => !l.id.includes(`camera-points-${polygonId}`)
    );
    overlay.setProps({ layers: filteredLayers });
    return filteredLayers;
  });
}
