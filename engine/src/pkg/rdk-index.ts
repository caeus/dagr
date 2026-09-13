/**
 * Immutable lookup data derived from a graph's semantic paths. Literal path segments provide a
 * cheap candidate set even when a selector starts with `**`; the glob remains the final authority.
 */
export class SemanticPathIndex<T extends string = string> {
  readonly #keys: readonly T[]
  readonly #positions: ReadonlyMap<T, number>
  readonly #bySegment: ReadonlyMap<string, readonly T[]>

  constructor(keys: Iterable<T>) {
    this.#keys = Object.freeze([...keys])
    this.#positions = new Map(this.#keys.map((key, position) => [key, position]))

    const bySegment = new Map<string, T[]>()
    for (const key of this.#keys) {
      for (const segment of new Set(key.slice(1).split('/'))) {
        const indexed = bySegment.get(segment) ?? []
        indexed.push(key)
        bySegment.set(segment, indexed)
      }
    }
    this.#bySegment = new Map(
      [...bySegment].map(([segment, indexed]) => [segment, Object.freeze(indexed)]),
    )
    Object.freeze(this)
  }

  /** Returns the selector union in original graph-key order. */
  matching(
    selectors: readonly string[],
    matches: (selector: string, path: T) => boolean,
  ): T[] {
    const found = new Set<T>()

    for (const selector of selectors) {
      if (!selector.includes('*')) {
        if (this.#positions.has(selector as T)) found.add(selector as T)
        continue
      }

      let candidates = this.#keys
      for (const segment of selector.slice(1).split('/')) {
        if (segment === '*' || segment === '**') continue
        const indexed = this.#bySegment.get(segment) ?? []
        if (indexed.length < candidates.length) candidates = indexed
      }

      for (const candidate of candidates) {
        if (matches(selector, candidate)) found.add(candidate)
      }
    }

    return [...found].sort((left, right) => (
      this.#positions.get(left)! - this.#positions.get(right)!
    ))
  }
}
