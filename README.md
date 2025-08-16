# ✈️ Flight Plan Analyser

> **Terrain-aware flight planning & GSD analysis**

A sophisticated web application for drone flight planning that analyzes terrain topography to determine optimal flight directions and provides comprehensive Ground Sample Distance (GSD) analysis with visual overlap heatmaps.

🚀 **[Try the Live Demo](https://map-poly-angle.vercel.app)** 🚀

![Flight Plan Analyser](https://img.shields.io/badge/version-1.0.0-blue.svg)
![React](https://img.shields.io/badge/React-18.3.1-61dafb.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6.3-3178c6.svg)
![Mapbox](https://img.shields.io/badge/Mapbox-GL_JS-000000.svg)
![Live Demo](https://img.shields.io/badge/Live_Demo-Vercel-000000.svg)

## 🌟 Features

### 📐 **Terrain Analysis**
- **3D Plane Fitting**: Advanced hybrid terrain analysis using robust statistical methods
- **Quality Metrics**: R², RMSE, and fit quality indicators (excellent/good/fair/poor)
- **Multiple Polygons**: Support for analyzing multiple flight areas simultaneously
- **Dynamic Zoom**: Automatic terrain resolution selection based on polygon size

### 🛩️ **Flight Planning**
- **Optimal Direction**: Calculates terrain-contour-aligned flight paths for consistent altitude
- **Per-Polygon Parameters**: Individual altitude, front overlap, and side overlap settings
- **3D Flight Paths**: Real-time 3D visualization of flight routes over terrain
- **Camera Positioning**: Precise camera pose calculation with 6DOF (position + orientation)

### 📊 **GSD & Overlap Analysis**
- **Visual Heatmaps**: Real-time overlay showing image overlap and GSD distribution
- **Per-Polygon Statistics**: Individual statistics for each flight area
- **Interactive Histograms**: GSD distribution charts with click-to-highlight functionality
- **Comprehensive Metrics**: Min/max/mean GSD, image counts, and area coverage

### 🗺️ **Interactive Mapping**
- **Mapbox Integration**: High-performance vector and satellite imagery
- **Drawing Tools**: Intuitive polygon drawing and editing
- **KML Import/Export**: Support for KML file import with automatic bounds fitting
- **Multi-Area Support**: Manage multiple flight areas in a single session

### 🎯 **User Experience**
- **Click-to-Highlight**: Click analysis cards to highlight corresponding polygons on map
- **User-Friendly Names**: "Polygon 1", "Polygon 2" instead of cryptic IDs
- **Responsive Design**: Mobile-friendly interface with adaptive layouts
- **Real-time Updates**: Live analysis updates as you modify flight parameters

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18.x or higher
- **npm** or **yarn** package manager
- **Mapbox Access Token** (required for map functionality)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/devbharat/MapPolyAngle.git
   cd MapPolyAngle
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   # Create .env file
   echo "VITE_MAPBOX_TOKEN=your_mapbox_token_here" > .env
   ```
   
   > 🔑 Get your free Mapbox token at [mapbox.com/account/access-tokens](https://account.mapbox.com/access-tokens/)

4. **Start development server**
   ```bash
   npm run dev
   ```

5. **Open in browser**
   ```
   http://localhost:5173
   ```

### Production Build

```bash
npm run build
npm run preview
```

## 🎮 Usage Guide

### Basic Workflow

1. **Draw Polygons**: Click on the map to draw flight area boundaries
2. **Set Parameters**: Configure altitude, overlap settings for each polygon
3. **Analyze Terrain**: Automatic terrain analysis provides optimal flight direction
4. **Review GSD**: Examine Ground Sample Distance distribution and overlap
5. **Export/Import**: Save and load KML files for reuse

### Advanced Features

#### Multi-Polygon Analysis
- Draw multiple polygons for complex flight missions
- Each polygon maintains independent parameters and analysis
- Compare terrain characteristics across different areas

#### Parameter Optimization
- **Altitude AGL**: Set height above ground level (affects GSD and coverage)
- **Front Overlap**: Control image overlap in flight direction (60-95%)
- **Side Overlap**: Control overlap between flight lines (60-95%)

#### Quality Assessment
- **Fit Quality**: Indicates terrain analysis reliability
  - 🟢 **Excellent**: R² > 0.9, RMSE < 5m
  - 🔵 **Good**: R² > 0.7, RMSE < 10m
  - 🟠 **Fair**: R² > 0.5, RMSE < 20m
  - 🔴 **Poor**: R² < 0.5 or RMSE > 20m

## 🏗️ Architecture

### Tech Stack

**Frontend**
- **React 18** - Modern UI library with hooks
- **TypeScript** - Type-safe JavaScript
- **Vite** - Fast build tool and dev server
- **Tailwind CSS** - Utility-first styling
- **shadcn/ui** - High-quality component library

**Mapping & Visualization**
- **Mapbox GL JS** - Interactive maps
- **Deck.gl** - 3D data visualization
- **Mapbox Draw** - Drawing tools
- **Recharts** - Statistical charts

**Terrain Analysis**
- **Web Workers** - Non-blocking computation
- **Custom Algorithms** - Hybrid plane fitting
- **Mapbox Terrain RGB** - High-resolution elevation data

### Project Structure

```
src/
├── components/           # React components
│   ├── MapFlightDirection/  # Main map component
│   ├── ui/                 # Reusable UI components
│   └── OverlapGSDPanel.tsx # GSD analysis panel
├── domain/              # Shared types and models
├── services/            # Business logic services
├── overlap/             # GSD computation engine
├── utils/               # Utility functions
└── pages/               # Application pages
```

### Key Components

- **MapFlightDirection**: Core map orchestration and polygon management
- **OverlapGSDPanel**: GSD analysis and visualization
- **TerrainService**: Unified terrain data fetching and caching
- **Projection**: Geographic coordinate transformations
- **Camera Models**: Flight camera specifications (Sony RX1R II default)

## 🔧 Configuration

### Camera Models

The application supports custom camera configurations:

```typescript
import { SONY_RX1R2 } from '@/domain/camera';

// Default: Sony RX1R II (42.4MP full frame)
const camera = {
  f_m: 0.035,      // 35mm lens
  sx_m: 4.88e-6,   // 4.88 µm pixel pitch
  sy_m: 4.88e-6,
  w_px: 7952,      // 7952 x 5304 pixels
  h_px: 5304,
};
```

### Environment Variables

```bash
# Required
VITE_MAPBOX_TOKEN=pk.your_mapbox_token

# Optional
VITE_MAPBOX_ACCESS_TOKEN=pk.fallback_token  # Alternative token name
```

## 📚 API Reference

### MapFlightDirection API

```typescript
interface MapFlightDirectionAPI {
  // Core operations
  clearAllDrawings(): void;
  clearPolygon(polygonId: string): void;
  startPolygonDrawing(): void;
  
  // Data access
  getPolygons(): [number, number][][];
  getFlightLines(): Map<string, FlightLines>;
  getPolygonTiles(): Map<string, TerrainTile[]>;
  
  // Flight planning
  applyPolygonParams(polygonId: string, params: FlightParams): void;
  
  // KML support
  openKmlFilePicker(): void;
  importKmlFromText(kml: string): Promise<{added: number, total: number}>;
}
```

### Domain Types

```typescript
interface FlightParams {
  altitudeAGL: number;  // meters above ground
  frontOverlap: number; // percentage (0-95)
  sideOverlap: number;  // percentage (0-95)
}

interface PolygonAnalysisResult {
  polygonId: string;
  result: {
    contourDirDeg: number;    // optimal flight direction
    aspectDeg: number;        // terrain aspect
    samples: number;          // analysis points
    maxElevation?: number;    // highest terrain point
    rSquared?: number;        // fit quality (0-1)
    rmse?: number;           // root mean square error
    fitQuality?: 'excellent' | 'good' | 'fair' | 'poor';
  };
}
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Add tests if applicable
5. Commit changes: `git commit -m 'Add amazing feature'`
6. Push to branch: `git push origin feature/amazing-feature`
7. Open a Pull Request

### Code Standards

- **TypeScript**: Strict type checking enabled
- **ESLint**: Code linting with React hooks rules
- **Prettier**: Code formatting (integrated with ESLint)
- **Component Structure**: Functional components with hooks
- **Testing**: Component and utility function tests

## 📋 Requirements

### System Requirements
- **Node.js**: 18.x or higher
- **Memory**: 4GB RAM minimum, 8GB recommended
- **Storage**: 500MB for dependencies
- **Network**: Internet connection for map tiles and terrain data

### Browser Support
- **Chrome**: 90+
- **Firefox**: 88+
- **Safari**: 14+
- **Edge**: 90+

> ⚠️ **Note**: WebGL 2.0 support required for 3D visualization

## 🐛 Troubleshooting

### Common Issues

**Map not loading**
- Verify Mapbox token is set correctly
- Check network connectivity
- Ensure token has appropriate scopes

**Terrain analysis fails**
- Verify polygon is properly closed
- Check if area is too large (>50km²)
- Ensure terrain data is available for the region

**Performance issues**
- Reduce polygon complexity
- Lower terrain resolution (zoom level)
- Clear browser cache

**Build failures**
- Update Node.js to latest LTS
- Clear `node_modules` and reinstall
- Check for TypeScript errors

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Mapbox** - Mapping platform and terrain data
- **React Team** - UI framework
- **shadcn** - Component library design
- **Deck.gl** - WebGL-powered visualizations
- **Contributors** - All the amazing people who helped build this

## 🔗 Links

- **Live Demo**: [map-poly-angle.vercel.app](https://map-poly-angle.vercel.app)
- **Documentation**: [docs.example.com](https://docs.example.com)
- **Issues**: [GitHub Issues](https://github.com/devbharat/MapPolyAngle/issues)
- **Discussions**: [GitHub Discussions](https://github.com/devbharat/MapPolyAngle/discussions)

---

**Built with ❤️ for the drone mapping community**

> 🎯 *Making precision flight planning accessible to everyone*
