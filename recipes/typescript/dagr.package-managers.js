import rdk from '//rdk//dagr.rdk.js'
import { command, file } from '//dagr.contributions.js'
import { DEVELOPMENT_INTENTS, REQUIREMENTS, requirementsOf } from '//dagr.model.js'
import { writeYaml } from '//dagr.file-utils.js'

export const fileTarballs = (manifest, localPackages) => localPackages.reduce(
  (result, { name, tarball, at }) => {
    const field = at === 'dev' ? 'devDependencies' : 'dependencies'
    return { ...result, [field]: { ...(result[field] ?? {}), [name]: `file:./${tarball}` } }
  },
  manifest,
)

const packDestination = command => slug =>
  `mkdir -p /tmp/pack /out && ${command} --pack-destination /tmp/pack && mv /tmp/pack/*.tgz /out/${slug}.tgz`

export const npm = () => rdk.graph({
  installManifest: rdk.value(fileTarballs),
  exec: rdk.value(invocation => `npm exec -- ${invocation}`),
  script: rdk.value(invocation => invocation),
  install: rdk.value(host => `npm install --include=dev${host ? ` --os=${host.os} --cpu=${host.arch}` : ''}`),
  pack: rdk.value(packDestination('npm pack')),
  packCommand: command(['pack', 'slug'], {
    for: ['pack', 'publish'],
    run: (pack, slug) => ({ shell: pack(slug) }),
  }),
  packageManagerFile: file([], {
    for: DEVELOPMENT_INTENTS,
    render: () => [],
  }),
})

export const pnpm = () => rdk.graph({
  installManifest: rdk.value(fileTarballs),
  exec: rdk.value(invocation => `pnpm exec ${invocation}`),
  script: rdk.value(invocation => invocation),
  install: rdk.value(host => `pnpm install --prod=false${host ? ` --os ${host.os} --cpu ${host.arch}` : ''}`),
  pack: rdk.value(packDestination('pnpm pack')),
  packCommand: command(['pack', 'slug'], {
    for: ['pack', 'publish'],
    run: (pack, slug) => ({ shell: pack(slug) }),
  }),
  packageManagerFile: file([{ tag: REQUIREMENTS }, 'configuredVersions'], {
    for: DEVELOPMENT_INTENTS,
    render(context, requirements, versions) {
      const { allowBuilds } = requirementsOf(requirements, context, versions)
      return allowBuilds.length === 0
        ? []
        : writeYaml('/repo/pnpm-workspace.yaml', {
            allowBuilds: Object.fromEntries(allowBuilds.map(pkg => [pkg, true])),
          })
    },
  }),
})

export const yarn = () => rdk.graph({
  installManifest: rdk.value((manifest, localPackages, requirements) => ({
    ...fileTarballs(manifest, localPackages),
    ...(requirements.allowBuilds.length === 0
      ? {}
      : {
          dependenciesMeta: {
            ...manifest.dependenciesMeta,
            ...Object.fromEntries(requirements.allowBuilds.map(pkg => [pkg, { built: true }])),
          },
        }),
  })),
  exec: rdk.value(invocation => `yarn exec ${invocation}`),
  script: rdk.value(invocation => invocation),
  install: rdk.value(() => 'yarn install --no-immutable'),
  pack: rdk.value(slug => `mkdir -p /out && yarn pack --out /out/${slug}.tgz`),
  packCommand: command(['pack', 'slug'], {
    for: ['pack', 'publish'],
    run: (pack, slug) => ({ shell: pack(slug) }),
  }),
  packageManagerFile: file([], {
    for: DEVELOPMENT_INTENTS,
    render: context => writeYaml('/repo/.yarnrc.yml', {
      nodeLinker: 'node-modules',
      ...(context.host
        ? { supportedArchitectures: { os: [context.host.os], cpu: [context.host.arch] } }
        : {}),
    }),
  }),
})
