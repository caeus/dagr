import rdk from 'dagr:rdk'
import { file } from '//dagr.contributions.js'
import { DEVELOPMENT_INTENTS, adapter, buildsFor } from '//dagr.model.js'
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

export const npm = () => rdk.graph({
  '/package-manager/install-manifest': rdk.value(fileTarballs),
  '/package-manager/exec': rdk.value(invocation => `npm exec -- ${invocation}`),
  '/package-manager/script': rdk.value(invocation => invocation),
  '/package-manager/install': rdk.value(host => `npm install --include=dev${host ? ` --os=${host.os} --cpu=${host.arch}` : ''}`),
  '/package-manager/pack': rdk.value(packDestination('npm pack')),
  '/package-manager/config': file({}, {
    for: DEVELOPMENT_INTENTS,
    render: () => [],
  }),
  '/package-manager/config/hoisted': adapter('/package-manager/config'),
})

export const pnpm = () => rdk.graph({
  '/package-manager/install-manifest': rdk.value(fileTarballs),
  '/package-manager/exec': rdk.value(invocation => `pnpm exec ${invocation}`),
  '/package-manager/script': rdk.value(invocation => invocation),
  '/package-manager/install': rdk.value(host => `pnpm install --prod=false${host ? ` --os ${host.os} --cpu ${host.arch}` : ''}`),
  '/package-manager/pack': rdk.value(packDestination('pnpm pack')),
  '/package-manager/config': file({
    tooling: rdk.many('/**/tooling/for/package-manager'),
  }, {
    for: DEVELOPMENT_INTENTS,
    render(context, { tooling }) {
      const allowBuilds = buildsFor(tooling, context.intent)
      return allowBuilds.length === 0
        ? []
        : writeYaml('/repo/pnpm-workspace.yaml', {
            allowBuilds: Object.fromEntries(allowBuilds.map(pkg => [pkg, true])),
          })
    },
  }),
  '/package-manager/config/hoisted': adapter('/package-manager/config'),
})

export const yarn = () => rdk.graph({
  '/package-manager/install-manifest': rdk.derive(
    { tooling: rdk.many('/**/tooling/for/package-manager') },
    ({ tooling }) => (manifest, localPackages, context) => {
      const allowBuilds = buildsFor(tooling, context.intent)
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
  '/package-manager/exec': rdk.value(invocation => `yarn exec ${invocation}`),
  '/package-manager/script': rdk.value(invocation => invocation),
  '/package-manager/install': rdk.value(() => 'yarn install --no-immutable'),
  '/package-manager/pack': rdk.value(slug => `mkdir -p /out && yarn pack --out /out/${slug}.tgz`),
  '/package-manager/config': file({}, {
    for: DEVELOPMENT_INTENTS,
    render: context => writeYaml('/repo/.yarnrc.yml', {
      enableScripts: false,
      nodeLinker: 'node-modules',
      ...(context.host
        ? { supportedArchitectures: { os: [context.host.os], cpu: [context.host.arch] } }
        : {}),
    }),
  }),
  '/package-manager/config/hoisted': adapter('/package-manager/config'),
})
