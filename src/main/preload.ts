import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopRequest } from "../shared/ipc";

// Sandboxed Electron preloads cannot require arbitrary local modules. Keep the
// runtime constants self-contained; the type-only import is erased by TypeScript.
const IPC = {
  getSnapshot: "app:get-snapshot",
  performAction: "app:perform-action"
} as const;

const bridge: DesktopBridge = Object.freeze({
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  performAction: (request: DesktopRequest) => ipcRenderer.invoke(IPC.performAction, request)
});

contextBridge.exposeInMainWorld("amexConnector", bridge);
