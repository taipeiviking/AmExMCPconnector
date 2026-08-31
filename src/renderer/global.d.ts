import type { DesktopBridge } from "../shared/ipc";

declare global {
  interface Window {
    amexConnector: DesktopBridge;
  }
}

export {};
