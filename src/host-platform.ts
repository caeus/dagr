import { z } from 'zod'
import type { HostPlatform } from './pkg/schema.js'

// dagr runs inside an Alpine container, so process.platform would describe that container
// rather than the user's machine. cli.sh detects the real values and passes them in, and this
// reads only what it was given — there is no sensible fallback, since guessing would silently
// produce the container's platform.
const HostEnv = z.object({
  HOST_OS: z.string().min(1),
  HOST_ARCH: z.string().min(1),
  HOST_LIBC: z.enum(['glibc', 'musl']).optional(),
})

export function hostPlatform(env: NodeJS.ProcessEnv): HostPlatform {
  const parsed = HostEnv.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid host platform environment: ${parsed.error.message}`)

  const { HOST_OS: os, HOST_ARCH: arch, HOST_LIBC: libc } = parsed.data
  if (os !== 'linux') return { os, arch }
  if (!libc) throw new Error('HOST_LIBC must be glibc or musl when the host is linux')
  return { os, arch, libc }
}
