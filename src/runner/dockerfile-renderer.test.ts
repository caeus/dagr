import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderDockerfile } from './dockerfile-renderer.js'

describe('renderDockerfile', () => {
  it('renders FROM', () => {
    assert.equal(renderDockerfile({ FROM: 'node:22-alpine', steps: [], IGNORE: [] }), 'FROM node:22-alpine\n')
  })

  it('renders steps', () => {
    const result = renderDockerfile({ FROM: 'alpine', steps: [{ RUN: 'echo hello' }], IGNORE: [] })
    assert.equal(result, 'FROM alpine\nRUN echo hello\n')
  })

  it('renders COPY from host', () => {
    const result = renderDockerfile({ FROM: 'alpine', steps: [{ COPY: { src: '.', dest: '/app' } }], IGNORE: [] })
    assert.match(result, /^COPY \. \/app$/m)
  })

  it('renders COPY --from', () => {
    const result = renderDockerfile({ FROM: 'alpine', steps: [{ COPY: { from: 'sha256:abc', src: '/out', dest: '/dest' } }], IGNORE: [] })
    assert.match(result, /^COPY --from=sha256:abc \/out \/dest$/m)
  })

  it('renders WORKDIR', () => {
    const result = renderDockerfile({ FROM: 'alpine', steps: [{ WORKDIR: '/app' }], IGNORE: [] })
    assert.match(result, /WORKDIR \/app/)
  })

  it('renders ENV', () => {
    const result = renderDockerfile({ FROM: 'alpine', steps: [{ ENV: { NODE_ENV: 'production' } }], IGNORE: [] })
    assert.match(result, /ENV NODE_ENV=production/)
  })

  it('renders ENTRYPOINT as JSON', () => {
    const result = renderDockerfile({ FROM: 'alpine', steps: [{ ENTRYPOINT: ['node', 'index.js'] }], IGNORE: [] })
    assert.match(result, /ENTRYPOINT \["node","index\.js"\]/)
  })

  it('ignores EXPORT field', () => {
    const result = renderDockerfile({ FROM: 'alpine', steps: [], IGNORE: [], EXPORT: { '/repo/dist': 'dist' } })
    assert.equal(result, 'FROM alpine\n')
  })
})
