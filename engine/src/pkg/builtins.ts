import vm from 'node:vm'
import { stringify as stringifyToml } from 'smol-toml'
import { stringify as stringifyYaml } from 'yaml'
import { createSandboxFunction } from '#pkg/sandbox.js'

export const BUILTIN_PREFIX = 'dagr:'

export function matchGlob(pattern: string, value: string): boolean {
  if (typeof pattern !== 'string' || typeof value !== 'string')
    throw new TypeError('dagr:glob match expects string pattern and value')

  if (pattern === '')
    throw new Error('Invalid Dagr glob pattern "": pattern must not be empty')

  const patternSegments = pattern.split('/')
  for (const segment of patternSegments) {
    if (segment === '')
      throw new Error(`Invalid Dagr glob pattern ${JSON.stringify(pattern)}: segments must not be empty`)
    if (segment.includes('*') && segment !== '*' && segment !== '**')
      throw new Error(`Invalid Dagr glob pattern ${JSON.stringify(pattern)}: wildcards must occupy an entire segment`)
  }

  const valueSegments = value === '' ? [] : value.split('/')
  const memo = new Map<string, boolean>()

  return matches(0, 0)

  function matches(patternIndex: number, valueIndex: number): boolean {
    const key = `${patternIndex}:${valueIndex}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached

    let result: boolean
    if (patternIndex === patternSegments.length) {
      result = valueIndex === valueSegments.length
    } else {
      const segment = patternSegments[patternIndex]
      const valueSegment = valueSegments[valueIndex]
      if (segment === '**') {
        result = matches(patternIndex + 1, valueIndex)
          || (
            valueIndex < valueSegments.length
            && valueSegment !== ''
            && matches(patternIndex, valueIndex + 1)
          )
      } else {
        result = valueIndex < valueSegments.length
          && valueSegment !== ''
          && (segment === '*' || segment === valueSegment)
          && matches(patternIndex + 1, valueIndex + 1)
      }
    }

    memo.set(key, result)
    return result
  }
}

export function createBuiltinModules(context: vm.Context): ReadonlyMap<string, vm.Module> {
  return new Map([
    builtin(
      'dagr:yaml',
      'stringify',
      ['value'],
      (value: unknown) => stringifyYaml(structuredClone(value)),
    ),
    builtin(
      'dagr:toml',
      'stringify',
      ['value'],
      (value: unknown) => stringifyToml(
        structuredClone(value) as Record<string, unknown>,
      ),
    ),
    builtin('dagr:glob', 'match', ['pattern', 'value'], matchGlob),
  ])

  function builtin<T extends (...args: never[]) => unknown>(
    specifier: string,
    exportName: string,
    parameters: readonly string[],
    implementation: T,
  ): readonly [string, vm.Module] {
    const fn = createSandboxFunction(context, parameters, implementation)
    const namespace = vm.compileFunction(
      `return Object.freeze({ ${exportName}: fn })`,
      [],
      {
        parsingContext: context,
        contextExtensions: [{ fn }],
      },
    )()
    return [
      specifier,
      new vm.SyntheticModule(
        ['default', exportName],
        function () {
          this.setExport('default', namespace)
          this.setExport(exportName, fn)
        },
        { context, identifier: specifier },
      ),
    ]
  }
}
