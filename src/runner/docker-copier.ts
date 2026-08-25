import type { ProcessRunner } from '#sys/process-runner.js'

export interface ImageCopy {
  readonly src: string
  readonly dest: string
}

export async function copyFromImage(
  imageTag: string,
  copies: readonly ImageCopy[],
  processRunner: ProcessRunner,
): Promise<void> {
  if (copies.length === 0) return
  const created = await processRunner.run(
    'docker',
    ['create', imageTag],
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
