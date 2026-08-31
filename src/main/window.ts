import { BrowserWindow } from "electron";
import { resolve } from "node:path";
import { isRendererWindowOpenAllowed } from "./navigation-policy";

export interface DashboardWindowOptions {
  screenshotProtection: boolean;
  devTools: boolean;
  onRequestClose: () => void;
}

export function createDashboardWindow(options: DashboardWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#17191c",
    autoHideMenuBar: true,
    title: "Amex Local Finance Connector",
    webPreferences: {
      preload: resolve(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: options.devTools
    }
  });

  window.setContentProtection(options.screenshotProtection);
  window.webContents.setWindowOpenHandler(({ url }) => ({
    action: isRendererWindowOpenAllowed(url) ? "allow" : "deny"
  }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.on("close", (event) => {
    event.preventDefault();
    options.onRequestClose();
  });

  void window.loadFile(resolve(__dirname, "../renderer/index.html"));
  return window;
}
