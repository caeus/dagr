import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const component = resolve(root, 'typescript')
const di = resolve(root, 'di')

export async function loadTypeScript() {
  const cache = new Map()
  const linking = new Map()

  const load = async path => {
    const canonical = await realpath(path)
    if (cache.has(canonical)) {
      await linking.get(canonical)
      return cache.get(canonical)
    }

    if (extname(canonical) === '.yaml') {
      const module = new vm.SyntheticModule(['default'], function () {
        this.setExport('default', { deps: {} })
      }, { identifier: canonical })
      cache.set(canonical, module)
      linking.set(canonical, module.link(() => {}))
      await linking.get(canonical)
      return module
    }

    const module = new vm.SourceTextModule(await readFile(canonical, 'utf8'), {
      identifier: canonical,
    })
    cache.set(canonical, module)
    const linked = module.link(async specifier => {
      if (specifier === 'dagr:yaml') {
        const builtin = new vm.SyntheticModule(['stringify'], function () {
          this.setExport('stringify', value => JSON.stringify(value, null, 2))
        }, { identifier: specifier })
        await builtin.link(() => {})
        return builtin
      }
      if (!specifier.startsWith('//')) {
        throw new Error(`Dagr imports must start with //, got: ${specifier}`)
      }
      if (specifier.startsWith('//di//')) {
        return load(resolve(di, specifier.slice('//di//'.length)))
      }
      return load(resolve(component, specifier.slice(2)))
    })
    linking.set(canonical, linked)
    await linked
    return module
  }

  const module = await load(resolve(component, 'dagr.stack.js'))
  await module.evaluate()
  return module.namespace
}
