import { mkdir } from 'node:fs/promises'
import type { ProcessRunner } from '#sys/process-runner.js'

export async function copyFromImage(
  imageTag: string,
  src: string,
  dest: string,
  processRunner: ProcessRunner,
): Promise<void> {
  await mkdir(dest, { recursive: true })
  const created = await processRunner.run(
    'docker',
    ['create', imageTag],
    `container.create ${imageTag}`,
  )
  const containerId = created.stdoutTail.at(-1)?.trim()
  if (!containerId) throw new Error(`Docker returned no container ID for image: ${imageTag}`)

  try {
    const source = `${src.replace(/\/+$/, '')}/.`
    await processRunner.run(
      'docker',
      ['cp', `${containerId}:${source}`, dest],
      `container.copy ${imageTag}`,
    )
  } finally {
    await processRunner.run(
      'docker',
      ['rm', containerId],
      `container.remove ${imageTag}`,
    )
  }
}
