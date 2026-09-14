import { engine } from '//engine/dagr.engine.js'

/** Only the irreducible declaration. The composition lives beside it so a test can import it. */
export default engine({
  location: import.meta.dagr.location,
  version: '0.0.0',
  deps: [
    { npm: '@caeus/wyr', at: 'prod' },
    { npm: '@optique/core', at: 'prod' },
    { npm: '@optique/run', at: 'prod' },
    { npm: 'smol-toml', at: 'prod' },
    { npm: 'yaml', at: 'prod' },
    { npm: 'zod', at: 'prod' },
  ],
})
