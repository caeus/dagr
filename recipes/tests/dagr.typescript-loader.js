import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, matchesGlob, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const recipe = resolve(root, 'typescript')
const rdk = resolve(root, 'rdk')

// Test double for the engine-provided module. Production RDK always imports `dagr:glob`.
const globOf = pattern => Object.freeze(path => matchesGlob(path, pattern))

const synthetic = async (specifier, exports) => {
  const names = Object.keys(exports)
  const module = new vm.SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, exports[name])
  }, { identifier: specifier })
  await module.link(() => {})
  return module
}

const createLoader = () => {
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
    let resolveLinked
    let rejectLinked
    const linked = new Promise((resolve, reject) => {
      resolveLinked = resolve
      rejectLinked = reject
    })
    linking.set(canonical, linked)
    module.link(async specifier => {
      if (specifier === 'dagr:yaml') {
        return synthetic(specifier, { stringify: value => JSON.stringify(value, null, 2) })
      }
      if (specifier === 'dagr:glob') {
        return synthetic(specifier, { default: Object.freeze({ of: globOf }), of: globOf })
      }
      if (!specifier.startsWith('//')) {
        throw new Error(`Dagr imports must start with //, got: ${specifier}`)
      }
      if (specifier.startsWith('//rdk//')) {
        return load(resolve(rdk, specifier.slice('//rdk//'.length)))
      }
      return load(resolve(recipe, specifier.slice(2)))
    }).then(resolveLinked, rejectLinked)
    await linked
    return module
  }

  return load
}

const evaluate = async path => {
  const module = await createLoader()(path)
  await module.evaluate()
  return module.namespace
}

export const loadTypeScript = () => evaluate(resolve(recipe, 'dagr.recipe.js'))

export const loadRdk = () => evaluate(resolve(rdk, 'dagr.rdk.js'))
