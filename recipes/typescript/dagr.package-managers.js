import rdk from '//rdk//dagr.rdk.js'
import { command, factsFor, file } from '//dagr.contributions.js'
import { DEVELOPMENT_INTENTS } from '//dagr.model.js'
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
  '/command/pack/package': command({
    pack: rdk.one('/package-manager/pack'),
    slug: rdk.one('/package/slug'),
  }, {
    for: ['pack', 'publish'],
    run: ({ pack, slug }) => ({ shell: pack(slug) }),
  }),
  '/file/package-manager': file({}, {
    for: DEVELOPMENT_INTENTS,
    render: () => [],
  }),
})

export const pnpm = () => rdk.graph({
  '/package-manager/install-manifest': rdk.value(fileTarballs),
  '/package-manager/exec': rdk.value(invocation => `pnpm exec ${invocation}`),
  '/package-manager/script': rdk.value(invocation => invocation),
  '/package-manager/install': rdk.value(host => `pnpm install --prod=false${host ? ` --os ${host.os} --cpu ${host.arch}` : ''}`),
  '/package-manager/pack': rdk.value(packDestination('pnpm pack')),
  '/command/pack/package': command({
    pack: rdk.one('/package-manager/pack'),
    slug: rdk.one('/package/slug'),
  }, {
    for: ['pack', 'publish'],
    run: ({ pack, slug }) => ({ shell: pack(slug) }),
  }),
  '/file/package-manager': file({
    builds: rdk.many('/requirement/build-scripts/**'),
  }, {
    for: DEVELOPMENT_INTENTS,
    render(context, { builds }) {
      const allowBuilds = factsFor(builds, context.intent)
      return allowBuilds.length === 0
        ? []
        : writeYaml('/repo/pnpm-workspace.yaml', {
            allowBuilds: Object.fromEntries(allowBuilds.map(pkg => [pkg, true])),
          })
    },
  }),
})

export const yarn = () => rdk.graph({
  '/package-manager/install-manifest': rdk.derive(
    { builds: rdk.many('/requirement/build-scripts/**') },
    ({ builds }) => (manifest, localPackages, context) => {
      const allowBuilds = factsFor(builds, context.intent)
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
  '/command/pack/package': command({
    pack: rdk.one('/package-manager/pack'),
    slug: rdk.one('/package/slug'),
  }, {
    for: ['pack', 'publish'],
    run: ({ pack, slug }) => ({ shell: pack(slug) }),
  }),
  '/file/package-manager': file({}, {
    for: DEVELOPMENT_INTENTS,
    render: context => writeYaml('/repo/.yarnrc.yml', {
      enableScripts: false,
      nodeLinker: 'node-modules',
      ...(context.host
        ? { supportedArchitectures: { os: [context.host.os], cpu: [context.host.arch] } }
        : {}),
    }),
  }),
})
