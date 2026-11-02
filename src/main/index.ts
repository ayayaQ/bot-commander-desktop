import { app } from 'electron'
import { nativeStartupRoute } from './nativeStartupRoute'

// Keep profile-dependent imports behind this dispatch. Normal startup lives in a
// same-directory entry so its existing __dirname and asset paths are unchanged.
const route = nativeStartupRoute(process.argv.slice(1))
async function dispatchStartup(): Promise<void> {
  if (route.kind === 'normal') {
    await import('./normalStartup')
    return
  }
  if (route.kind === 'invalid') {
    process.stderr.write(
      JSON.stringify({ stage: 'native-probe', status: 'failed', error: route.error }) + '\n'
    )
    app.exit(2)
    return
  }
  await import('./nativePackageProbe')
    .then(({ runNativePackageProbe }) => runNativePackageProbe(route.control))
    .catch((error: unknown) => {
      process.stderr.write(
        JSON.stringify({
          stage: 'native-probe',
          status: 'failed',
          error: error instanceof Error ? error.message : 'Probe failed'
        }) + '\n'
      )
      app.exit(1)
    })
}

// Tests await the same selected default entry before checking its asynchronous readiness.
export const startupDispatch = dispatchStartup()
