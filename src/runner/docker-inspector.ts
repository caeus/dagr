import type { ProcessRunner } from '#sys/process-runner.js'

export interface DockerImageInspector {
  inspectImageWorkdir(imageTag: string): Promise<string>
}

export async function inspectImageWorkdir(
  imageTag: string,
  processRunner: ProcessRunner,
): Promise<string> {
  const result = await processRunner.run(
    'docker',
    ['image', 'inspect', '--format', '{{json .Config.WorkingDir}}', imageTag],
    `image.inspect ${imageTag}`,
  )
  const output = result.stdoutTail.at(-1)
  if (output === undefined) throw new Error(`Docker returned no WORKDIR for image: ${imageTag}`)

  const workdir: unknown = JSON.parse(output)
  if (typeof workdir !== 'string')
    throw new Error(`Docker returned an invalid WORKDIR for image ${imageTag}: ${output}`)
  return workdir || '/'
}
