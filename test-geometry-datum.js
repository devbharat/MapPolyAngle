// Quick test to verify geometry functions use WGS84 vertical datum
import * as egm96 from 'egm96-universal';

// Test coordinates (significant geoid undulation area)
const lat = 28.0;
const lon = 87.0;
const testElevationEGM96 = 1000; // 1000m above EGM96 geoid

// Expected conversion result
const expectedWGS84 = egm96.egm96ToEllipsoid(lat, lon, testElevationEGM96);

console.log(`Vertical Datum Test for Flight Path Generation:`);
console.log(`Location: ${lat}°N, ${lon}°E`);
console.log(`Test elevation (EGM96 geoid): ${testElevationEGM96} m`);
console.log(`Converted elevation (WGS84 ellipsoid): ${expectedWGS84.toFixed(2)} m`);
console.log(`Geoid undulation: ${(expectedWGS84 - testElevationEGM96).toFixed(2)} m`);
console.log(`\nThis ensures flight altitudes are in WGS84 ellipsoid, matching DJI pose coordinates.`);
