interface ShutdownDependencies {
  pauseResources(): void
  pauseRuntime(): void
  pauseAgents?(): void
  checkpointAndStopRuntime(): Promise<void>
  drainResources(): Promise<void>
  drainAgents?(): Promise<void>
  saveStats(): Promise<void>
  stopServer(): Promise<unknown>
  closeAndDrainWrites(): Promise<void>
  resumeResources(): void
  resumeRuntime(): void
  resumeAgents?(): void
  reopenWrites(): void
}

function start(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return action()
  } catch (error) {
    return Promise.reject(error)
  }
}

/** Block new mutations, finish accepted work, then seal and drain all direct persistence. */
export async function finishPersistenceBeforeQuit(
  dependencies: ShutdownDependencies
): Promise<void> {
  dependencies.pauseResources()
  dependencies.pauseRuntime()
  dependencies.pauseAgents?.()
  // Previously admitted resource jobs may still enter the runtime queue; finish them first.
  const results = await Promise.allSettled([
    start(dependencies.drainResources),
    start(dependencies.stopServer)
  ])
  results.push(...(await Promise.allSettled([start(dependencies.checkpointAndStopRuntime)])))
  if (dependencies.drainAgents)
    results.push(...(await Promise.allSettled([start(dependencies.drainAgents)])))
  results.push(...(await Promise.allSettled([start(dependencies.saveStats)])))
  results.push(...(await Promise.allSettled([start(dependencies.closeAndDrainWrites)])))
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length) {
    dependencies.reopenWrites()
    dependencies.resumeRuntime()
    dependencies.resumeResources()
    dependencies.resumeAgents?.()
    throw new AggregateError(errors, 'Could not finish persistence before quitting')
  }
}
