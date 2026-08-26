import vm from 'node:vm'
import { stringify as stringifyToml } from 'smol-toml'
import { stringify as stringifyYaml } from 'yaml'
import { createSandboxStringifier } from '#pkg/sandbox.js'

export const BUILTIN_PREFIX = 'dagr:'

export function createBuiltinModules(context: vm.Context): ReadonlyMap<string, vm.Module> {
  return new Map([
    builtin('dagr:yaml', value => stringifyYaml(structuredClone(value))),
    builtin('dagr:toml', value => stringifyToml(
      structuredClone(value) as Record<string, unknown>,
    )),
  ])

  function builtin(
    specifier: string,
    implementation: (value: unknown) => string,
  ): readonly [string, vm.Module] {
    const stringify = createSandboxStringifier(context, implementation)
    return [
      specifier,
      new vm.SyntheticModule(
        ['stringify'],
        function () { this.setExport('stringify', stringify) },
        { context, identifier: specifier },
      ),
    ]
  }
}
