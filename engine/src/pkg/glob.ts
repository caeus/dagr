export type GlobPredicate = (path: string) => boolean

/** Compiles one Dagr glob pattern into a reusable predicate. */
export function of(pattern: string): GlobPredicate {
  if (typeof pattern !== 'string')
    throw new TypeError('dagr:glob of expects a string pattern')
  if (pattern === '')
    throw new Error('Invalid Dagr glob pattern "": pattern must not be empty')

  const patternSegments = pattern.split('/')
  for (const segment of patternSegments) {
    if (segment === '')
      throw new Error(`Invalid Dagr glob pattern ${JSON.stringify(pattern)}: segments must not be empty`)
    if (segment.includes('*') && segment !== '*' && segment !== '**')
      throw new Error(`Invalid Dagr glob pattern ${JSON.stringify(pattern)}: wildcards must occupy an entire segment`)
  }

  const predicate = (path: string): boolean => {
    if (typeof path !== 'string')
      throw new TypeError('dagr:glob predicate expects a string path')

    const pathSegments = path === '' ? [] : path.split('/')
    const memo = new Map<string, boolean>()

    const matches = (patternIndex: number, pathIndex: number): boolean => {
      const key = `${patternIndex}:${pathIndex}`
      const cached = memo.get(key)
      if (cached !== undefined) return cached

      let result: boolean
      if (patternIndex === patternSegments.length) {
        result = pathIndex === pathSegments.length
      } else {
        const segment = patternSegments[patternIndex]!
        const pathSegment = pathSegments[pathIndex]
        if (segment === '**') {
          result = matches(patternIndex + 1, pathIndex)
            || (
              pathIndex < pathSegments.length
              && pathSegment !== ''
              && matches(patternIndex, pathIndex + 1)
            )
        } else {
          result = pathIndex < pathSegments.length
            && pathSegment !== ''
            && (segment === '*' || segment === pathSegment)
            && matches(patternIndex + 1, pathIndex + 1)
        }
      }

      memo.set(key, result)
      return result
    }

    return matches(0, 0)
  }

  return Object.freeze(predicate)
}
