import { Menu, Tray, nativeImage } from "electron";

export interface TrayControllerOptions {
  showDashboard: () => void;
  lock: () => void;
  quit: () => void;
  statusLabel: () => string;
}

export function createTrayController(options: TrayControllerOptions): Tray {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip("Amex Local Finance Connector");

  const rebuildMenu = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open dashboard", click: options.showDashboard },
        { label: options.statusLabel(), enabled: false },
        { type: "separator" },
        { label: "Lock local data", click: options.lock },
        { type: "separator" },
        { label: "Quit", click: options.quit }
      ])
    );
  };

  tray.on("click", options.showDashboard);
  tray.on("right-click", rebuildMenu);
  rebuildMenu();
  return tray;
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="8" fill="#1d5fd1"/>
      <path d="M8 23 14.2 8h3.6L24 23h-4l-1.1-3H13l-1.1 3H8Zm6.1-6.2h3.8L16 11.6l-1.9 5.2Z" fill="white"/>
    </svg>`;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return nativeImage.createFromDataURL(dataUrl).resize({ width: 16, height: 16 });
}
