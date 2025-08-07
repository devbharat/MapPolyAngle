/** helper so the worker is in Vite's build graph */
export const planarSegmenterWorkerUrl = new URL('./planar_segmentation_worker.js', import.meta.url).toString();
