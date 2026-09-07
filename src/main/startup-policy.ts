const PACKAGED_STARTUP_DETAIL =
  "The application could not start safely, so its local services were not left running. Close this message, review the Windows setup, and restart the app. If the problem continues, report the app version and the action you took without including credentials or financial data.";

const SMOKE_EXIT_ARGUMENT = "--amex-packaged-smoke-exit-after-ms=";

/** Returns a user-visible startup failure without reflecting paths, environment
 * values, provider responses, or other exception detail in packaged builds. */
export function startupFailureDetail(packaged: boolean, error: unknown): string {
  if (packaged) return PACKAGED_STARTUP_DETAIL;
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown startup error.";
  return `${PACKAGED_STARTUP_DETAIL}\n\nDevelopment detail: ${detail}`;
}

/** Test-only graceful-exit hook used by the packaged executable smoke test.
 * It is unavailable in development and accepts only a narrow bounded delay. */
export function packagedSmokeExitDelay(argv: readonly string[], packaged: boolean): number | undefined {
  if (!packaged) return undefined;
  const argument = argv.find((value) => value.startsWith(SMOKE_EXIT_ARGUMENT));
  if (!argument) return undefined;
  const rawDelay = argument.slice(SMOKE_EXIT_ARGUMENT.length);
  if (!/^\d{1,5}$/u.test(rawDelay)) return undefined;
  const delay = Number(rawDelay);
  return Number.isSafeInteger(delay) && delay >= 5_000 && delay <= 60_000 ? delay : undefined;
}
