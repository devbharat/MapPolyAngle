declare module '@mapbox/mapbox-gl-draw' {
  import { Control } from 'mapbox-gl';
  
  interface DrawOptions {
    displayControlsDefault?: boolean;
    controls?: {
      polygon?: boolean;
      trash?: boolean;
      line_string?: boolean;
      point?: boolean;
      combine_features?: boolean;
      uncombine_features?: boolean;
    };
  }

  class MapboxDraw extends Control {
    constructor(options?: DrawOptions);
    getAll(): {
      type: 'FeatureCollection';
      features: Array<{
        id: string;
        type: 'Feature';
        properties: any;
        geometry: {
          type: string;
          coordinates: any;
        };
      }>;
    };
    deleteAll(): void;
    delete(featureId: string): void;
  }

  export = MapboxDraw;
}