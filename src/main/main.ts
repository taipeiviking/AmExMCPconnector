import { app, dialog, powerMonitor } from "electron";
import { environmentForRuntime, loadConfiguration } from "../config/environment";
import { DesktopController } from "./controller";
import { canControlScreenshotProtection, readBuildChannel } from "./build-channel";
import { packagedSmokeExitDelay, startupFailureDetail } from "./startup-policy";

app.setName("Amex Local Finance Connector");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  void start().catch((error: unknown) => reportStartupFailure(error));
}

async function start(): Promise<void> {
  await app.whenReady();
  const configuration = app.isPackaged
    ? loadConfiguration({ environment: environmentForRuntime(process.env, true) })
    : loadConfiguration({ loadEnvFile: true });
  const controller = new DesktopController(configuration, {
    screenshotControlAvailable: canControlScreenshotProtection({
      environment: configuration.environment,
      packaged: app.isPackaged,
      buildChannel: readBuildChannel()
    })
  });

  app.on("second-instance", () => void controller.showDashboard());
  app.on("activate", () => void controller.showDashboard());
  app.on("window-all-closed", () => {
    // Windows tray process remains active until the explicit Quit command.
  });
  powerMonitor.on("lock-screen", () => void controller.lock());
  powerMonitor.on("suspend", () => void controller.lock());
  app.on("before-quit", (event) => {
    event.preventDefault();
    void controller.quit();
  });

  await controller.start();
  const smokeExitDelay = packagedSmokeExitDelay(process.argv, app.isPackaged);
  if (smokeExitDelay !== undefined) {
    const timer = setTimeout(() => void controller.quit(), smokeExitDelay);
    timer.unref?.();
  }
}

async function reportStartupFailure(error: unknown): Promise<void> {
  if (!app.isPackaged) console.error("Application startup failed", error);
  try {
    if (!app.isReady()) await app.whenReady();
    dialog.showErrorBox("Amex Local Finance Connector could not start", startupFailureDetail(app.isPackaged, error));
  } catch (displayError) {
    if (!app.isPackaged) console.error("The startup failure dialog could not be displayed", displayError);
  } finally {
    app.exit(1);
  }
}
