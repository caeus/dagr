import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { FQT } from '#runner/index.js'
import { runTarget } from '#runner/target-runner.js'
import { renderDockerfile } from '#runner/dockerfile-renderer.js'
import { NodeDef, Result } from '#pkg/schema.js'

it('generates exact UTF-8 content in scratch and returns an image and path', async () => {
  const content = 'line one\n\u03bb\u0000no final newline'
  const target = NodeDef.parse({
    deps: { manifest: '/manifest' },
    run: ({ manifest }: Record<string, unknown>) => ({
      build: {
        FROM: 'scratch',
        steps: [{ WRITE: { path: '/file with spaces.json', content: manifest } }],
        IGNORE: [],
        path: '/file with spaces.json',
      },
    }),
  })
  let directory = ''
  const result = await runTarget(
    FQT.parse('//:/file'),
    target,
    [{ fqt: FQT.parse('//:/manifest'), value: content }],
    '.',
    {
      renderDockerfile,
      async buildDockerImage(dockerfile, tag, _context, _ignore, contexts) {
        directory = contexts?.['dagr_generated'] ?? ''
        assert.ok(directory)
        assert.equal(await readFile(join(directory, '0'), 'utf8'), content)
        assert.equal(dockerfile, 'FROM scratch\nCOPY --from=dagr_generated ["0","/file with spaces.json"]\n')
        return { tag, digest: 'sha256:test' }
      },
      reporter: {
        targetStarted() {}, targetCompleted() {}, targetFailed() {},
        processLine() {}, failure() {},
      },
    },
    { os: 'linux', arch: 'x64' },
    async () => { throw new Error('Unexpected mounted COPY') },
  )
  assert.deepEqual({ ...(result.value as object) }, {
    image: result.build?.imageTag,
    path: '/file with spaces.json',
  })
  await assert.rejects(access(directory))
})

it('rejects nonabsolute and traversing output paths', () => {
  for (const path of ['file.json', '/a/../file.json', '/']) {
    assert.equal(Result.safeParse({
      build: { FROM: 'scratch', steps: [], IGNORE: [], path },
    }).success, false)
  }
})
