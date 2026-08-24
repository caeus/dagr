import type { Run } from '../pkg/schema.js'

export function renderDockerfile({ FROM, steps }: Run): string {
  return [
    `FROM ${FROM}`,
    ...steps.flatMap(step => {
      if ('RUN' in step) return [`RUN ${step.RUN}`]
      if ('COPY' in step) {
        const { from, src, dest } = step.COPY
        return [from ? `COPY --from=${from} ${src} ${dest}` : `COPY ${src} ${dest}`]
      }
      if ('WORKDIR' in step) return [`WORKDIR ${step.WORKDIR}`]
      if ('ENV' in step) return Object.entries(step.ENV).map(([k, v]) => `ENV ${k}=${v}`)
      if ('ENTRYPOINT' in step) return [`ENTRYPOINT ${JSON.stringify(step.ENTRYPOINT)}`]
      if ('CMD' in step) return [`CMD ${JSON.stringify(step.CMD)}`]
      return []
    })
  ].join('\n') + '\n'
}
