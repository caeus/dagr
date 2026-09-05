import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { JsonValue, type MountRequest } from '#pkg/schema.js'
import { deepFreeze } from '#pkg/value.js'

const MOUNT_FILE = 'dagr.mount.yaml'

export class MountRequestLoader {
  private readonly cache = new Map<string, Promise<MountRequest | undefined>>()

  load(dir: string, logicalPath: string): Promise<MountRequest | undefined> {
    const file = resolve(dir, MOUNT_FILE)
    const key = `${file}\0${logicalPath}`
    let request = this.cache.get(key)
    if (!request) {
      request = this.read(file, logicalPath)
      this.cache.set(key, request)
    }
    return request
  }

  private async read(file: string, logicalPath: string): Promise<MountRequest | undefined> {
    let source: string
    try {
      source = await readFile(file, 'utf-8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new Error(`Cannot read mount request at ${canonicalMountPath(logicalPath)}`, {
        cause: error,
      })
    }

    let parsed: unknown
    try {
      parsed = parseYaml(source)
    } catch (error) {
      throw new Error(`Cannot parse mount request at ${canonicalMountPath(logicalPath)}`, {
        cause: error,
      })
    }

    let result: ReturnType<typeof JsonValue.safeParse>
    try {
      result = JsonValue.safeParse(parsed)
    } catch (error) {
      throw new Error(
        `Invalid mount request at ${canonicalMountPath(logicalPath)}: expected JSON-compatible YAML`,
        { cause: error },
      )
    }
    if (!result.success)
      throw new Error(
        `Invalid mount request at ${canonicalMountPath(logicalPath)}: expected JSON-compatible YAML; ${result.error.message}`,
      )
    return deepFreeze(result.data)
  }
}

export function canonicalMountPath(logicalPath: string): string {
  return logicalPath === '.' ? '//' : `//${logicalPath}`
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
