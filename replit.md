# Terrain Flight Director

## Overview

This is a React-based web application for analyzing terrain aspects to determine optimal flight paths. The application allows users to draw polygons on an interactive map and calculates the dominant terrain aspect within the polygon, providing flight direction recommendations based on topographical analysis.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite for fast development and optimized builds
- **UI Library**: shadcn/ui components with Radix UI primitives
- **Styling**: Tailwind CSS with CSS variables for theming
- **State Management**: React Query (TanStack Query) for server state
- **Routing**: Wouter for lightweight client-side routing
- **Map Integration**: Mapbox GL JS with drawing capabilities

### Backend Architecture
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript with ES modules
- **Database**: PostgreSQL with Drizzle ORM
- **Database Provider**: Neon Database (serverless PostgreSQL)
- **Session Management**: PostgreSQL session store with connect-pg-simple

### Build & Development
- **Development**: Hot reload with Vite dev server
- **Production**: ESBuild for server bundling, Vite for client bundling
- **Type Checking**: Strict TypeScript configuration across client, server, and shared code

## Key Components

### Map Component (`MapFlightDirection.tsx`)
- Interactive Mapbox GL map with polygon drawing capabilities
- Terrain analysis using Mapbox terrain-RGB tiles
- Real-time calculation of dominant aspect and flight direction
- Configurable terrain zoom levels and sampling parameters

### Terrain Analysis (`terrainAspect.ts`)
- Calculates representative aspect (mean or median) for polygonal areas
- Processes terrain elevation data from Mapbox terrain tiles
- Returns optimal flight direction perpendicular to dominant aspect
- Supports both terrain-RGB and DEM data formats

### UI Components
- Comprehensive set of accessible UI components from shadcn/ui
- Responsive design with mobile-first approach
- Dark/light theme support via CSS variables
- Form components with React Hook Form integration

### Data Layer
- Drizzle ORM for type-safe database operations
- User management schema with authentication support
- In-memory storage fallback for development
- PostgreSQL session management for production

## Data Flow

1. **User Interaction**: User draws polygon on map using Mapbox Draw tools
2. **Terrain Fetching**: Application fetches terrain tiles covering the polygon area
3. **Analysis Processing**: Terrain aspect calculation processes elevation data within polygon
4. **Result Display**: Optimal flight direction is calculated and displayed on map
5. **State Management**: React Query manages analysis results and caching

## External Dependencies

### Core Services
- **Mapbox**: Map tiles, terrain data, and drawing tools
- **Neon Database**: Serverless PostgreSQL hosting

### Key Libraries
- **@mapbox/mapbox-gl-draw**: Interactive polygon drawing
- **@tanstack/react-query**: Server state management
- **drizzle-orm**: Type-safe database operations
- **@radix-ui/***: Accessible UI component primitives
- **tailwindcss**: Utility-first CSS framework

### Development Tools
- **Vite**: Fast build tool and dev server
- **ESBuild**: Fast JavaScript bundler for production
- **TypeScript**: Static type checking
- **Replit Integration**: Development environment optimization

## Deployment Strategy

### Development
- Vite dev server with hot reload
- In-memory storage for rapid prototyping
- Replit-specific optimizations and error handling

### Production Build
- Client: Vite builds React app to `dist/public`
- Server: ESBuild bundles Express server to `dist/index.js`
- Static file serving through Express in production

### Environment Configuration
- Database URL required for PostgreSQL connection
- Mapbox access token required for map functionality
- Session secret for secure session management
- Environment-specific configurations for development vs production

### Scaling Considerations
- Serverless PostgreSQL for automatic scaling
- Static asset optimization through Vite
- Efficient terrain tile caching strategies
- Mobile-responsive design for cross-device usage

## Recent Changes

### 2025-01-30
- **UI Layout Optimization**: Moved all control panels to right side to prevent overlap with Mapbox drawing tools
- **Drawing Tools Integration**: Successfully integrated MapboxDraw with polygon drawing and terrain analysis
- **Mapbox Authentication**: Configured VITE_MAPBOX_ACCESS_TOKEN for terrain data access
- **Terrain Analysis**: Verified working end-to-end flow from polygon drawing to flight direction calculation
- **Compact Design**: Made panels thinner and more space-efficient for better user experience
- **3D Terrain Visualization**: Added 3D elevation with 45° pitch and enhanced navigation controls
- **Error Handling**: Implemented comprehensive AbortError handling for smooth map interactions