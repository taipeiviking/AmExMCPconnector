/**
 * Publishes one asynchronously-created resource at a time and makes release
 * invalidate an in-flight creation before the candidate can become visible.
 */
export class SingleFlightResource<T> {
  private value?: T;
  private pending?: Promise<T | undefined>;
  private releasing?: Promise<void>;
  private generation = 0;

  constructor(
    private readonly create: () => Promise<T>,
    private readonly dispose: (resource: T) => Promise<void>
  ) {}

  get current(): T | undefined {
    return this.value;
  }

  get revision(): number {
    return this.generation;
  }

  acquire(): Promise<T | undefined> {
    if (this.releasing) return this.releasing.then(() => undefined);
    if (this.value) return Promise.resolve(this.value);
    if (this.pending) return this.pending;

    const expectedGeneration = this.generation;
    let tracked: Promise<T | undefined>;
    tracked = this.createAndPublish(expectedGeneration).finally(() => {
      if (this.pending === tracked) this.pending = undefined;
    });
    this.pending = tracked;
    return tracked;
  }

  release(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.generation += 1;
    let tracked: Promise<void>;
    tracked = this.releaseCurrent().finally(() => {
      if (this.releasing === tracked) this.releasing = undefined;
    });
    this.releasing = tracked;
    return tracked;
  }

  private async releaseCurrent(): Promise<void> {
    const pending = this.pending;
    if (pending) await pending.catch(() => undefined);

    const resource = this.value;
    this.value = undefined;
    if (resource) await this.dispose(resource);
  }

  private async createAndPublish(expectedGeneration: number): Promise<T | undefined> {
    const candidate = await this.create();
    if (expectedGeneration !== this.generation) {
      await this.dispose(candidate);
      return undefined;
    }
    this.value = candidate;
    return candidate;
  }
}
