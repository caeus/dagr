import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hostPlatform } from './host-platform.js'

describe('hostPlatform', () => {
  it('reads os and arch from the environment', () => {
    assert.deepEqual(hostPlatform({ HOST_OS: 'darwin', HOST_ARCH: 'arm64' }), { os: 'darwin', arch: 'arm64' })
  })

  it('omits libc off linux, even when one is supplied', () => {
    const host = hostPlatform({ HOST_OS: 'darwin', HOST_ARCH: 'arm64', HOST_LIBC: 'glibc' })
    assert.equal('libc' in host, false)
  })

  it('keeps libc on linux', () => {
    assert.deepEqual(hostPlatform({ HOST_OS: 'linux', HOST_ARCH: 'x64', HOST_LIBC: 'musl' }), {
      os: 'linux', arch: 'x64', libc: 'musl',
    })
  })

  it('rejects a blank HOST_LIBC rather than coercing it', () => {
    assert.throws(() => hostPlatform({ HOST_OS: 'linux', HOST_ARCH: 'x64', HOST_LIBC: '' }), /Invalid host platform/)
  })

  it('requires libc on linux', () => {
    assert.throws(() => hostPlatform({ HOST_OS: 'linux', HOST_ARCH: 'x64' }), /HOST_LIBC must be/)
  })

  it('never guesses from the running process', () => {
    assert.throws(() => hostPlatform({}), /Invalid host platform/)
    assert.throws(() => hostPlatform({ HOST_OS: 'darwin' }), /Invalid host platform/)
  })
})
