export const pnpmfile = (scope) => `const localScope = '@${scope}/'

function readPackage(pkg) {
  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[depField]
    if (!deps) continue
    for (const name of Object.keys(deps)) {
      if (name.startsWith(localScope)) {
        const tarball = name.slice(localScope.length).replace(/\\//g, '-')
        deps[name] = \`file:./\${tarball}.tgz\`
      }
    }
  }
  return pkg
}

module.exports = { hooks: { readPackage } }
`
