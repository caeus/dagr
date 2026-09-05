import vm from 'node:vm'
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { createSandboxContext } from '#pkg/sandbox.js'
import {
  Volumes,
  type MountImplementation,
  type MountRequest,
  type VolumeId,
} from '#pkg/schema.js'
import { canonicalMountPath } from '#pkg/mount-request.js'
import { deepFreeze } from '#pkg/value.js'

const CONFIG_FILE = '.dagr/config.js'
const VOLUMES_FILE = '.dagr/volumes.yaml'

export interface IdentifiedVolume {
  readonly id: VolumeId
  readonly implementation: MountImplementation
}

type RuntimeIdentifyVolume = (request: MountRequest) => unknown

export class RootVolumeRegistry {
  private readonly canonicalRoot: Promise<string>
  private identifyVolume?: Promise<RuntimeIdentifyVolume>
  private volumes?: Promise<Volumes>

  constructor(root: string) {
    this.canonicalRoot = realpath(root)
  }

  async resolve(request: MountRequest, logicalPath: string): Promise<IdentifiedVolume> {
    const mountPath = canonicalMountPath(logicalPath)
    const identifyVolume = await this.loadIdentifyVolume().catch(error => {
      throw new Error(`Cannot identify volume requested through mount ${mountPath}`, { cause: error })
    })

    let id: unknown
    try {
      id = identifyVolume(request)
    } catch (error) {
      throw new Error(
        `Root identifyVolume failed for mount ${mountPath}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (typeof id !== 'string')
      throw new Error(
        `Root identifyVolume must return a string for mount ${mountPath}; received ${valueKind(id)}`,
      )

    const volumes = await this.loadVolumes().catch(error => {
      throw new Error(
        `Cannot load implementation for volume ${JSON.stringify(id)} requested through mount ${mountPath}`,
        { cause: error },
      )
    })
    const implementation = Object.hasOwn(volumes, id) ? volumes[id] : undefined
    if (!implementation)
      throw new Error(
        `Undefined volume ${JSON.stringify(id)} requested through mount ${mountPath}`,
      )
    return { id, implementation }
  }

  private loadIdentifyVolume(): Promise<RuntimeIdentifyVolume> {
    if (!this.identifyVolume) {
      this.identifyVolume = this.canonicalRoot.then(root => this.readIdentifyVolume(root))
    }
    return this.identifyVolume
  }

  private async readIdentifyVolume(root: string): Promise<RuntimeIdentifyVolume> {
    const path = resolve(root, CONFIG_FILE)
    let code: string
    try {
      code = await readFile(path, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        throw new Error(`Root ${CONFIG_FILE} is missing`, { cause: error })
      throw new Error(`Cannot read root ${CONFIG_FILE}`, { cause: error })
    }

    const context = createSandboxContext()
    let mod: vm.SourceTextModule
    try {
      mod = new vm.SourceTextModule(code, { context, identifier: path })
      await mod.link(specifier => {
        throw new Error(`Root ${CONFIG_FILE} cannot import ${specifier}`)
      })
      await mod.evaluate()
    } catch (error) {
      throw new Error(
        `Cannot evaluate root ${CONFIG_FILE}: ${errorMessage(error)}`,
        { cause: error },
      )
    }

    const identifyVolume = (mod.namespace as Record<string, unknown>)['identifyVolume']
    if (typeof identifyVolume !== 'function')
      throw new Error(`Root ${CONFIG_FILE} must export an identifyVolume function`)
    return identifyVolume as RuntimeIdentifyVolume
  }

  private loadVolumes(): Promise<Volumes> {
    if (!this.volumes) this.volumes = this.canonicalRoot.then(root => this.readVolumes(root))
    return this.volumes
  }

  private async readVolumes(root: string): Promise<Volumes> {
    const path = resolve(root, VOLUMES_FILE)
    let source: string
    try {
      source = await readFile(path, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return deepFreeze(Volumes.parse({}))
      throw new Error(`Cannot read root ${VOLUMES_FILE}`, { cause: error })
    }

    let parsed: unknown
    try {
      parsed = parseYaml(source) ?? {}
    } catch (error) {
      throw new Error(`Cannot parse root ${VOLUMES_FILE}`, { cause: error })
    }
    let result: ReturnType<typeof Volumes.safeParse>
    try {
      result = Volumes.safeParse(parsed)
    } catch (error) {
      throw new Error(`Invalid root ${VOLUMES_FILE}: expected volume image recipes`, {
        cause: error,
      })
    }
    if (!result.success)
      throw new Error(`Invalid root ${VOLUMES_FILE}: ${result.error.message}`)
    return deepFreeze(result.data)
  }
}

function valueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function errorMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) return error.message
  return String(error)
}
