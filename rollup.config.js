import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import { builtinModules } from 'node:module'

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
])

export default {
  input: 'build/index.js',
  external: (id) => builtins.has(id),
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs()],
  onLog(level, log, handler) {
    if (log.code === 'CIRCULAR_DEPENDENCY') return
    if (level === 'warn') handler('error', log)
    else handler(level, log)
  },
  output: {
    file: 'dist/dagr.js',
    format: 'esm'
  }
}
