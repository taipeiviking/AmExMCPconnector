import { app } from "electron";
import { environmentForRuntime, loadConfiguration } from "../config/environment";
import { DesktopController } from "./controller";

app.setName("Amex Local Finance Connector");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  void start();
}

async function start(): Promise<void> {
  await app.whenReady();
  const configuration = app.isPackaged
    ? loadConfiguration({ environment: environmentForRuntime(process.env, true) })
    : loadConfiguration({ loadEnvFile: true });
  const controller = new DesktopController(configuration);

  app.on("second-instance", () => void controller.showDashboard());
  app.on("activate", () => void controller.showDashboard());
  app.on("window-all-closed", () => {
    // Windows tray process remains active until the explicit Quit command.
  });
  app.on("before-quit", (event) => {
    event.preventDefault();
    void controller.quit();
  });

  await controller.start();
}
