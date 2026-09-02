import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Module, toValue } from '@caeus/wyr'
import type { Cmd, CommandRunner } from '#commands/index.js'
import { wire, workingPackageName, type ModuleFactory } from '#wire.js'

describe('workingPackageName', () => {
  it('names the repository root as the root package', () => {
    assert.equal(workingPackageName({ WORKING_DIR: '/repo' }, '/repo'), '//')
    assert.equal(workingPackageName({}, '/repo'), '//')
  })

  it('names a nested working directory as a canonical package', () => {
    assert.equal(
      workingPackageName({ WORKING_DIR: '/repo/engine/examples' }, '/repo'),
      '//engine/examples',
    )
  })
})

describe('wire', () => {
  it('parses arguments before building and compiling the injected module', async () => {
    const env = { MARKER: 'test' }
    let receivedEnv: NodeJS.ProcessEnv | undefined
    let receivedArgs: Cmd | undefined
    let executedArgs: Cmd | undefined
    let disposed = false

    const module: ModuleFactory = (actualEnv, parsedArgs, stack) => {
      receivedEnv = actualEnv
      receivedArgs = parsedArgs
      stack.defer(async () => { disposed = true })

      return Module({
        commandRunner: toValue<CommandRunner>({
          execute: async (cmd) => { executedArgs = cmd }
        })
      })
    }

    await wire(env, ['list'], module)

    assert.equal(receivedEnv, env)
    assert.deepEqual(receivedArgs, { command: 'list' })
    assert.deepEqual(executedArgs, receivedArgs)
    assert.equal(disposed, true)
  })

  it('disposes resources when command execution fails', async () => {
    let disposed = false
    const failure = new Error('failed')
    const module: ModuleFactory = (_env, _parsedArgs, stack) => {
      stack.defer(async () => { disposed = true })

      return Module({
        commandRunner: toValue<CommandRunner>({
          execute: async () => { throw failure }
        })
      })
    }

    await assert.rejects(wire({}, ['list'], module), failure)
    assert.equal(disposed, true)
  })
})
