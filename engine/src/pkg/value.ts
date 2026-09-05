export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  if (seen.has(value as object)) return value
  seen.add(value as object)
  Object.freeze(value)
  for (const child of Object.values(value as object)) deepFreeze(child, seen)
  return value
}
