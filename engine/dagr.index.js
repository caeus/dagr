import { engine } from '//engine/dagr.engine.js'
import bootstrap from '//engine/dagr.bootstrap.json'

export default engine({
  location: import.meta.dagr.location,
  version: bootstrap.version,
  deps: Object.keys(bootstrap.dependencies).map(npm => ({ npm, at: 'prod' })),
})
