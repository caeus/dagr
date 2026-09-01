export class AsyncDisposeStack {
  private readonly finalizers: Array<() => Promise<void>> = []

  defer(fn: () => Promise<void>): void {
    this.finalizers.push(fn)
  }

  async dispose(): Promise<void> {
    for (const fn of this.finalizers.splice(0).reverse()) await fn()
  }
}
