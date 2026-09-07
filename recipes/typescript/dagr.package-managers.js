const manager = definition => Object.freeze(definition)

const packCommand = command => slug =>
  `mkdir -p /tmp/pack /out && ${command} --pack-destination /tmp/pack && mv /tmp/pack/*.tgz /out/${slug}.tgz`

const npm = manager({
  name: 'npm',
  install: ({ host } = {}) => `npm install --include=dev${host ? ` --os=${host.os} --cpu=${host.arch}` : ''}`,
  exec: command => `npm exec -- ${command}`,
  pack: packCommand('npm pack'),
  configFiles: () => [],
})

const pnpm = manager({
  name: 'pnpm',
  install: ({ host } = {}) => `pnpm install --prod=false${host ? ` --os ${host.os} --cpu ${host.arch}` : ''}`,
  exec: command => `pnpm exec ${command}`,
  pack: packCommand('pnpm pack'),
  configFiles: ({ allowBuilds }) => allowBuilds.length === 0
    ? []
    : [{
        path: 'pnpm-workspace.yaml',
        format: 'yaml',
        value: { allowBuilds: Object.fromEntries(allowBuilds.map(pkg => [pkg, true])) },
      }],
})

export const packageManagers = Object.freeze({ npm, pnpm })

export function resolvePackageManager(name) {
  const value = packageManagers[name]
  if (value === undefined) {
    throw new Error(`Unknown TypeScript package manager ${JSON.stringify(name)}; expected npm or pnpm`)
  }
  return value
}
