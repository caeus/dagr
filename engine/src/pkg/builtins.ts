import vm from 'node:vm'
import { stringify as stringifyToml } from 'smol-toml'
import { stringify as stringifyYaml } from 'yaml'
import { createSandboxStringifier } from '#pkg/sandbox.js'

export const BUILTIN_PREFIX = 'dagr:'

type GlobPredicate = (path: string) => boolean
type GlobFactory = (pattern: string) => GlobPredicate

function createGlobFactory(context: vm.Context): GlobFactory {
  const of = vm.compileFunction(`
    if (typeof pattern !== 'string')
      throw new TypeError('dagr:glob of expects a string pattern')
    if (pattern === '')
      throw new Error('Invalid Dagr glob pattern "": pattern must not be empty')

    const patternSegments = pattern.split('/')
    for (const segment of patternSegments) {
      if (segment === '')
        throw new Error('Invalid Dagr glob pattern ' + JSON.stringify(pattern) + ': segments must not be empty')
      if (segment.includes('*') && segment !== '*' && segment !== '**')
        throw new Error('Invalid Dagr glob pattern ' + JSON.stringify(pattern) + ': wildcards must occupy an entire segment')
    }

    const predicate = path => {
      if (typeof path !== 'string')
        throw new TypeError('dagr:glob predicate expects a string path')

      const pathSegments = path === '' ? [] : path.split('/')
      const memo = new Map()

      const matches = (patternIndex, pathIndex) => {
        const key = patternIndex + ':' + pathIndex
        const cached = memo.get(key)
        if (cached !== undefined) return cached

        let result
        if (patternIndex === patternSegments.length) {
          result = pathIndex === pathSegments.length
        } else {
          const segment = patternSegments[patternIndex]
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
  `, ['pattern'], { parsingContext: context }) as GlobFactory

  return Object.freeze(of)
}

export function createBuiltinModules(context: vm.Context): ReadonlyMap<string, vm.Module> {
  return new Map([
    builtin(
      'dagr:yaml',
      'stringify',
      createSandboxStringifier(
        context,
        value => stringifyYaml(structuredClone(value)),
      ),
    ),
    builtin(
      'dagr:toml',
      'stringify',
      createSandboxStringifier(
        context,
        value => stringifyToml(
          structuredClone(value) as Record<string, unknown>,
        ),
      ),
    ),
    builtin('dagr:glob', 'of', createGlobFactory(context)),
  ])

  function builtin<T extends (...args: never[]) => unknown>(
    specifier: string,
    exportName: string,
    fn: T,
  ): readonly [string, vm.Module] {
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
