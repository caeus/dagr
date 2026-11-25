import vm from 'node:vm'
import { stringify as stringifyToml } from 'smol-toml'
import { stringify as stringifyYaml } from 'yaml'
import { of as nativeGlobOf } from '#pkg/glob.js'
import {
  createSandboxFunction,
  createSandboxStringifier,
  freezeInSandbox,
} from '#pkg/sandbox.js'

export const BUILTIN_PREFIX = 'dagr:'

type GlobPredicate = (path: string) => boolean
type GlobFactory = (pattern: string) => GlobPredicate
function createGlobFactory(context: vm.Context): GlobFactory {
  return createSandboxFunction(context, (pattern: string) => {
    const native = nativeGlobOf(pattern)
    return createSandboxFunction(context, (path: string) => native(path))
  })
}

export function createBuiltinModules(context: vm.Context): ReadonlyMap<string, vm.Module> {
  const freeze = <T extends object>(value: T): T => freezeInSandbox(context, value)
  const globOf = createGlobFactory(context)
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
    builtin('dagr:glob', 'of', globOf),
  ])

  function builtin<Args extends unknown[], Result>(
    specifier: string,
    exportName: string,
    fn: (...args: Args) => Result,
  ): readonly [string, vm.Module] {
    const namespace = freeze({ [exportName]: fn })
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
