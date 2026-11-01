import { isAbsolute } from 'node:path'

export type NativeStartupRoute =
  { kind: 'normal' } | { kind: 'probe'; control: string } | { kind: 'invalid'; error: string }

/** No environment toggle, implicit probe mode, profile lookup or privileged import. */
export function nativeStartupRoute(argv: string[]): NativeStartupRoute {
  const flags = argv.filter((value) => value.startsWith('--bcfd-native-probe'))
  if (!flags.length) return { kind: 'normal' }
  const prefix = '--bcfd-native-probe='
  if (flags.length !== 1 || !flags[0].startsWith(prefix))
    return { kind: 'invalid', error: 'Supply one --bcfd-native-probe=<absolute control.json>' }
  const control = flags[0].slice(prefix.length)
  if (!isAbsolute(control)) return { kind: 'invalid', error: 'Probe control path must be absolute' }
  return { kind: 'probe', control }
}
