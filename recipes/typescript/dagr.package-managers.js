import { value, derive, select, scope } from '//dagr.nodes.js'
import { file } from '//dagr.contributions.js'
import { DEVELOPMENT_INTENTS, buildsFor } from '//dagr.model.js'
import { writeYaml } from '//dagr.file-utils.js'

export const fileTarballs = (manifest, localPackages, _context) => localPackages.reduce(
  (result, { name, tarball, at }) => {
    const field = at === 'dev' ? 'devDependencies' : 'dependencies'
    return { ...result, [field]: { ...(result[field] ?? {}), [name]: `file:./${tarball}` } }
  },
  manifest,
)

const packDestination = command => slug =>
  `mkdir -p /tmp/pack /out && ${command} --pack-destination /tmp/pack && mv /tmp/pack/*.tgz /out/${slug}.tgz`

export const npm = name => scope(name, {
  '/package-manager/install-manifest': value(fileTarballs),
  '/package-manager/exec': value(invocation => `npm exec -- ${invocation}`),
  '/package-manager/script': value(invocation => invocation),
  '/package-manager/install': value(host => `npm install --include=dev${host ? ` --os=${host.os} --cpu=${host.arch}` : ''}`),
  '/package-manager/pack': value(packDestination('npm pack')),

})

export const pnpm = name => scope(name, {
  '/package-manager/install-manifest': value(fileTarballs),
  '/package-manager/exec': value(invocation => `pnpm exec ${invocation}`),
  '/package-manager/script': value(invocation => invocation),
  '/package-manager/install': value(host => `pnpm install --prod=false${host ? ` --os ${host.os} --cpu ${host.arch}` : ''}`),
  '/package-manager/pack': value(packDestination('pnpm pack')),
  ...file('/repo/pnpm-workspace.yaml', {
    builds: select('/**/package-manager/builds'),
  }, {
    for: DEVELOPMENT_INTENTS,
    key: 'package-manager/pnpm-workspace.yaml',
    render(context, { builds }) {
      const allowBuilds = buildsFor(builds, context.intent)
      return writeYaml('/repo/pnpm-workspace.yaml', {
        allowBuilds: Object.fromEntries(allowBuilds.map(pkg => [pkg, true])),
      })
    },
  }),
})

export const yarn = name => scope(name, {
  '/package-manager/install-manifest': derive(
    { builds: select('/**/package-manager/builds') },
    ({ builds }) => (manifest, localPackages, context) => {
      const allowBuilds = buildsFor(builds, context.intent)
      return {
        ...fileTarballs(manifest, localPackages),
        ...(allowBuilds.length === 0
          ? {}
          : {
              dependenciesMeta: {
                ...manifest.dependenciesMeta,
                ...Object.fromEntries(allowBuilds.map(pkg => [pkg, { built: true }])),
              },
            }),
      }
    },
  ),
  '/package-manager/exec': value(invocation => `yarn exec ${invocation}`),
  '/package-manager/script': value(invocation => invocation),
  '/package-manager/install': value(() => 'yarn install --no-immutable'),
  '/package-manager/pack': value(slug => `mkdir -p /out && yarn pack --out /out/${slug}.tgz`),
  ...file('/repo/.yarnrc.yml', {}, {
    for: DEVELOPMENT_INTENTS,
    key: 'package-manager/yarnrc.yml',
    render: context => writeYaml('/repo/.yarnrc.yml', {
      enableScripts: false,
      nodeLinker: 'node-modules',
      ...(context.host
        ? { supportedArchitectures: { os: [context.host.os], cpu: [context.host.arch] } }
        : {}),
    }),
  }),
})
