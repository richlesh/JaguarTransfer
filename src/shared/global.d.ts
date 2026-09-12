// Ambient declaration so the renderer sees the typed window.jaguar bridge.
import type { JaguarApi } from "./ipc";

declare global {
  interface Window {
    jaguar: JaguarApi;
  }
}

export {};
