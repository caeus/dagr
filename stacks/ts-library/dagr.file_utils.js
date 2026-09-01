import * as YAML from 'dagr:yaml'

export function writeText(path, content) {
  return { RUN: `echo "${Buffer.from(content).toString('base64')}" | base64 -d > ${path}` }
}

export function writeJson(path, value) {
  return writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function writeYaml(path, value) {
  return writeText(path, YAML.stringify(value))
}
