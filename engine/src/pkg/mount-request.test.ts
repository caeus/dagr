import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MountRequestLoader } from '#pkg/mount-request.js'

async function withMount(source: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dagr-mount-request-'))
  await mkdir(join(root, 'vendor/foo'), { recursive: true })
  await writeFile(join(root, 'vendor/foo/dagr.mount.yaml'), source)
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true })
  }
}

describe('MountRequestLoader', () => {
  it('reports malformed YAML with the mount path', async () => {
    await withMount('repo: [\n', async root => {
      await assert.rejects(
        new MountRequestLoader().load(join(root, 'vendor/foo'), 'vendor/foo'),
        error => {
          assert.match(messages(error), /Cannot parse mount request at \/\/vendor\/foo/)
          assert.match(messages(error), /end with a \]/)
          return true
        },
      )
    })
  })

  it('rejects YAML values that are not JSON-compatible', async () => {
    await withMount('repo: example\npriority: .nan\n', async root => {
      await assert.rejects(
        new MountRequestLoader().load(join(root, 'vendor/foo'), 'vendor/foo'),
        error => {
          assert.match(messages(error), /Invalid mount request at \/\/vendor\/foo/)
          assert.match(messages(error), /JSON-compatible YAML/)
          return true
        },
      )
    })
  })

  it('reports cyclic YAML aliases as a non-JSON request', async () => {
    await withMount('&request\nself: *request\n', async root => {
      await assert.rejects(
        new MountRequestLoader().load(join(root, 'vendor/foo'), 'vendor/foo'),
        error => {
          assert.match(messages(error), /Invalid mount request at \/\/vendor\/foo/)
          assert.match(messages(error), /JSON-compatible YAML/)
          return true
        },
      )
    })
  })

  it('returns undefined when a directory has no mount request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-no-mount-request-'))
    try {
      assert.equal(await new MountRequestLoader().load(root, 'ordinary'), undefined)
    } finally {
      await rm(root, { recursive: true })
    }
  })
})

function messages(error: unknown): string {
  const result: string[] = []
  for (let current = error; current instanceof Error; current = current.cause)
    result.push(current.message)
  return result.join('\n')
}
