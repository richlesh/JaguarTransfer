// Ambient declaration so the renderer sees the typed window.transferJaguar bridge.
import type { TransferJaguarApi } from "./ipc";

declare global {
  interface Window {
    transferJaguar: TransferJaguarApi;
  }
}

export {};
