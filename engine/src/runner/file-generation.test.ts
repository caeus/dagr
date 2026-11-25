import assert from 'node:assert/strict'
import { it } from 'node:test'
import { FQT } from '#runner/index.js'
import { runTarget } from '#runner/target-runner.js'
import { renderDockerfile } from '#runner/dockerfile-renderer.js'
import { NodeDef, Result } from '#pkg/schema.js'

it('returns the image and file path from a build using ordinary RUN', async () => {
  const target = NodeDef.parse({
    deps: { manifest: '/manifest' },
    run: ({ manifest }: Record<string, unknown>) => ({
      build: {
        FROM: 'alpine:3.22',
        steps: [{ RUN: `echo "${Buffer.from(String(manifest)).toString('base64')}" | base64 -d > /package.json` }],
        IGNORE: [],
        path: '/package.json',
      },
    }),
  })
  const result = await runTarget(
    FQT.parse('//:/file'), target,
    [{ fqt: FQT.parse('//:/manifest'), value: '{}' }], '.',
    {
      renderDockerfile,
      async buildDockerImage(dockerfile, tag) {
        assert.equal(dockerfile, 'FROM alpine:3.22\nRUN echo "e30=" | base64 -d > /package.json\n')
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
    image: result.build?.imageTag, path: '/package.json',
  })
})

it('rejects nonabsolute and traversing output paths', () => {
  for (const path of ['file.json', '/a/../file.json', '/']) {
    assert.equal(Result.safeParse({
      build: { FROM: 'alpine:3.22', steps: [], IGNORE: [], path },
    }).success, false)
  }
})
