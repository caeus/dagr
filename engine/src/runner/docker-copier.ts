import type { ProcessRunner } from '#sys/process-runner.js'

export interface ImageCopy {
  readonly src: string
  readonly dest: string
}

export interface DockerImageCopier {
  copyFromImage(imageTag: string, copies: readonly ImageCopy[]): Promise<void>
}

export async function copyFromImage(
  imageTag: string,
  copies: readonly ImageCopy[],
  processRunner: ProcessRunner,
): Promise<void> {
  if (copies.length === 0) return
  const created = await processRunner.run(
    'docker',
    // Extraction only needs a container filesystem. Supplying a command lets Docker create one
    // from commandless images such as FROM scratch; the container is never started.
    ['create', imageTag, 'true'],
    `container.create ${imageTag}`,
  )
  const containerId = created.stdoutTail.at(-1)?.trim()
  if (!containerId) throw new Error(`Docker returned no container ID for image: ${imageTag}`)

  try {
    for (const { src, dest } of copies) {
      await processRunner.run(
        'docker',
        ['cp', `${containerId}:${src}`, dest],
        `container.copy ${imageTag}`,
      )
    }
  } finally {
    await processRunner.run(
      'docker',
      ['rm', containerId],
      `container.remove ${imageTag}`,
    )
  }
}
