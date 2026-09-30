import type { BCFDCommand } from '../types/types'

type SaveCommandsResponse = {
  success: boolean
  revision?: string
}

type InvokeSave = (payload: {
  bcfdCommands: BCFDCommand[]
  expectedRevision: string
}) => Promise<SaveCommandsResponse>

export async function saveCommandSnapshot(
  commands: BCFDCommand[],
  expectedRevision: string,
  invokeSave: InvokeSave
): Promise<{ commands: BCFDCommand[]; revision: string }> {
  const snapshot = structuredClone(commands)
  const result = await invokeSave({ bcfdCommands: snapshot, expectedRevision })
  if (!result?.success) throw new Error('The command changes were not saved')
  return {
    commands: snapshot,
    revision: result.revision || expectedRevision
  }
}
