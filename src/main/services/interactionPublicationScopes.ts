import fs from 'node:fs/promises'

/** Persist scopes before contacting Discord, including requests with an uncertain outcome. */
export class InteractionPublicationScopes {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, string[]>> {
    try {
      const data: unknown = JSON.parse(await fs.readFile(this.path, 'utf8'))
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        Object.values(data).some(
          (ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)
        )
      )
        throw new Error('Invalid interaction publication scopes')
      return data as Record<string, string[]>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  async get(applicationId: string): Promise<string[]> {
    return (await this.read())[applicationId] || []
  }

  async remember(applicationId: string, guildId: string): Promise<void> {
    const data = await this.read()
    const scopes = data[applicationId] || []
    if (scopes.includes(guildId)) return
    data[applicationId] = [...scopes, guildId]
    await this.write(data)
  }

  async forget(applicationId: string, guildId: string): Promise<void> {
    const data = await this.read()
    data[applicationId] = (data[applicationId] || []).filter((id) => id !== guildId)
    await this.write(data)
  }

  private async write(data: Record<string, string[]>): Promise<void> {
    await fs.writeFile(`${this.path}.tmp`, JSON.stringify(data))
    await fs.rename(`${this.path}.tmp`, this.path)
  }
}
