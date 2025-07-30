import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  // No need to set root since index.html is in project root
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  define: {
    // Make sure Mapbox token is available
    'process.env.VITE_MAPBOX_ACCESS_TOKEN': JSON.stringify(process.env.VITE_MAPBOX_ACCESS_TOKEN)
  }
});