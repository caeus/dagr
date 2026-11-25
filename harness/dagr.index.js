import engineIndexTests, { graph } from '//harness/dagr.tests-engine-index.js'
import { reportOf } from '//harness/recipes//tests/dagr.testing.js'

export default {
  ...graph,
  '/test': {
    deps: {
      manifest: '/engine/file/build/package.json',
      tsconfig: '/engine/file/build/tsconfig.json',
    },
    run: ({ manifest, tsconfig }) => {
      const report = reportOf([engineIndexTests()])
      if (report.failed.length) throw new Error(report.lines.join('\n'))
      return { build: {
        FROM: 'node:22-alpine',
        steps: [
          { WORKDIR: '/checks' },
          { COPY: { from: manifest.image, src: manifest.path, dest: '/checks/package.json' } },
          { COPY: { from: tsconfig.image, src: tsconfig.path, dest: '/checks/tsconfig.json' } },
          { RUN: 'node -e \'const a=require("node:assert/strict"); const p=require("./package.json"); const t=require("./tsconfig.json"); a.equal(p.name,"@caeus/dagr"); a.equal(p.imports["#*"],"./build/*"); a.equal(t.compilerOptions.declaration,false); a.equal(t.compilerOptions.outDir,"build")\'' },
        ],
        IGNORE: ['.git'],
      } }
    },
  },
}
