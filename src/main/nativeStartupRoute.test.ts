import path from 'node:path'
import { expect, it } from 'vitest'
import { nativeStartupRoute } from './nativeStartupRoute'

it('leaves ordinary launch arguments on the default startup path', () => {
  expect(nativeStartupRoute([])).toEqual({ kind: 'normal' })
  expect(nativeStartupRoute(['app', '--ordinary-flag'])).toEqual({ kind: 'normal' })
})

it('selects the explicit absolute synthetic control file', () => {
  const control = path.resolve('synthetic/control.json')
  expect(nativeStartupRoute([`--bcfd-native-probe=${control}`])).toEqual({ kind: 'probe', control })
})

it.each([
  ['--bcfd-native-probe'],
  ['--bcfd-native-probe=relative/control.json'],
  ['--bcfd-native-probe-typo'],
  ['--bcfd-native-probe=/one/control.json', '--bcfd-native-probe=/two/control.json']
])('fails incomplete or ambiguous probe invocation closed: %j', (...argv) => {
  expect(nativeStartupRoute(argv).kind).toBe('invalid')
})
