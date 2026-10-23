/** Host limits and unavailable simulation capabilities are never modeled command failures. */
export class IncompleteSimulationError extends Error {}

export function commitsTemplate(result: { errors: unknown[] }): boolean {
  return result.errors.length === 0
}

/** Only wrap delivery here: rendering/transaction failures must still propagate. */
export async function deliverInteractionDM(
  deliver: () => unknown | Promise<unknown>,
  warn: (error: unknown) => void
): Promise<void> {
  try {
    await deliver()
  } catch (error) {
    if (error instanceof IncompleteSimulationError) throw error
    warn(error)
  }
}
