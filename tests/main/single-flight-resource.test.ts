import { describe, expect, it, vi } from "vitest";
import { SingleFlightResource } from "../../src/main/single-flight-resource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SingleFlightResource", () => {
  it("coalesces concurrent unlocks and publishes only one resource", async () => {
    const candidate = deferred<{ id: string }>();
    const create = vi.fn(() => candidate.promise);
    const dispose = vi.fn(async () => undefined);
    const resource = new SingleFlightResource(create, dispose);

    const first = resource.acquire();
    const second = resource.acquire();
    candidate.resolve({ id: "one" });

    await expect(first).resolves.toEqual({ id: "one" });
    await expect(second).resolves.toEqual({ id: "one" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(resource.current).toEqual({ id: "one" });
    expect(dispose).not.toHaveBeenCalled();
  });

  it("cancels and disposes an unlock that finishes after lock", async () => {
    const candidate = deferred<{ id: string }>();
    const dispose = vi.fn(async () => undefined);
    const resource = new SingleFlightResource(() => candidate.promise, dispose);

    const unlocking = resource.acquire();
    const locking = resource.release();
    candidate.resolve({ id: "late" });

    await expect(unlocking).resolves.toBeUndefined();
    await locking;
    expect(resource.current).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith({ id: "late" });
  });

  it("disposes a published resource only once across concurrent locks", async () => {
    const dispose = vi.fn(async () => undefined);
    const resource = new SingleFlightResource(async () => ({ id: "active" }), dispose);
    await resource.acquire();

    await Promise.all([resource.release(), resource.release()]);

    expect(resource.current).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not reacquire while lock is disposing the published resource", async () => {
    const disposal = deferred<void>();
    const create = vi.fn(async () => ({ id: "active" }));
    const resource = new SingleFlightResource(create, () => disposal.promise);
    await resource.acquire();

    const locking = resource.release();
    const racedAcquire = resource.acquire();
    expect(create).toHaveBeenCalledTimes(1);
    disposal.resolve();

    await locking;
    await expect(racedAcquire).resolves.toBeUndefined();
    expect(resource.current).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
