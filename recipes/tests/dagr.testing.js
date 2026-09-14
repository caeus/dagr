/**
 * A test runner that runs inside a Dagr index.
 *
 * The point is fidelity. A test loaded by the engine gets the real `dagr:rdk`, the real `dagr:yaml`,
 * and the real module resolution, so it exercises what ships instead of a stand-in. The price is that
 * the sandbox has no `node:test` and no `node:assert`, so both are hand-woven here — a few dozen lines
 * of collector and comparison, in exchange for deleting every simulation of the engine.
 */

const isPlainObject = value => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

/** Structural comparison. Prototypes are ignored on purpose: values cross a realm boundary. */
const same = (actual, expected) => {
  if (actual === expected) return true
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((item, at) => same(actual[at], item))
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false
    const expectedKeys = Object.keys(expected)
    const actualKeys = Object.keys(actual)
    return expectedKeys.length === actualKeys.length
      && expectedKeys.every(key => same(actual[key], expected[key]))
  }
  return false
}

const show = value => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function suite(name) {
  const results = []

  const record = (label, body) => {
    try {
      body()
      results.push({ name: label, ok: true })
    } catch (error) {
      results.push({ name: label, ok: false, because: error?.message ?? String(error) })
    }
  }

  const assertions = {
    equal(actual, expected, note) {
      if (actual !== expected) {
        throw new Error(`${note ?? 'equal'}: expected ${show(expected)}, got ${show(actual)}`)
      }
    },
    deepEqual(actual, expected, note) {
      if (!same(actual, expected)) {
        throw new Error(`${note ?? 'deepEqual'}: expected ${show(expected)}, got ${show(actual)}`)
      }
    },
    ok(value, note) {
      if (!value) throw new Error(`${note ?? 'ok'}: expected a truthy value, got ${show(value)}`)
    },
    match(actual, pattern, note) {
      if (typeof actual !== 'string' || !new RegExp(pattern).test(actual)) {
        throw new Error(`${note ?? 'match'}: ${show(actual)} does not match ${pattern}`)
      }
    },
    doesNotMatch(actual, pattern, note) {
      if (typeof actual === 'string' && new RegExp(pattern).test(actual)) {
        throw new Error(`${note ?? 'doesNotMatch'}: ${show(actual)} matches ${pattern}`)
      }
    },
    throws(body, pattern, note) {
      let thrown
      try {
        body()
      } catch (error) {
        thrown = error?.message ?? String(error)
      }
      if (thrown === undefined) throw new Error(`${note ?? 'throws'}: nothing was thrown`)
      if (pattern !== undefined && !new RegExp(pattern).test(thrown)) {
        throw new Error(`${note ?? 'throws'}: ${show(thrown)} does not match ${pattern}`)
      }
    },
  }

  return Object.freeze({
    test: (label, body) => record(label, () => body(assertions)),
    results: () => Object.freeze([...results.map(entry => Object.freeze({ ...entry, suite: name }))]),
  })
}

/** Turns collected results into a target that reports them and fails when any test failed. */
export function reportOf(suites) {
  const results = suites.flatMap(each => each.results())
  const failed = results.filter(entry => !entry.ok)
  const lines = [
    ...results.map(entry => `${entry.ok ? 'ok' : 'not ok'} ${entry.suite}: ${entry.name}`
      + (entry.ok ? '' : `\n  ${entry.because}`)),
    `# tests ${results.length}`,
    `# pass ${results.length - failed.length}`,
    `# fail ${failed.length}`,
  ]
  return Object.freeze({ results, failed, lines: Object.freeze(lines) })
}
