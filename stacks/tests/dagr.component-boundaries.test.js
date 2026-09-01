import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function filesBelow(path) {
  const entries = await readdir(path, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => {
    const child = resolve(path, entry.name)
    return entry.isDirectory() ? filesBelow(child) : [child]
  }))).flat()
}

describe('mountable component boundaries', () => {
  it('do not expose repository test harnesses', async () => {
    const files = (await Promise.all(
      ['di', 'ts-library', 'typescript'].map(component => filesBelow(resolve(root, component))),
    )).flat()
    const leaked = files
      .map(file => file.slice(root.length + 1))
      .filter(file => file.endsWith('.test.js') || file.endsWith('/package.json'))

    assert.deepEqual(leaked, [])
  })
})
