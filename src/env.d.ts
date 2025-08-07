/// <reference types="vite/client" />

// WebGPU types for the worker
interface GPUAdapter { 
  requestDevice(): Promise<GPUDevice>; 
}
interface GPU { 
  requestAdapter(): Promise<GPUAdapter|null>; 
}
declare const navigator: Navigator & { gpu?: GPU };
