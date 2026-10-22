/** Process-neutral capability views consumed by the language runtime. */
export interface RuntimeCollection<T> {
  size: number
  get(id: string): T | undefined
  has(id: string): boolean
  values(): IterableIterator<T>
  find(predicate: (value: T) => boolean): T | undefined
  filter(predicate: (value: T) => boolean): RuntimeCollection<T>
  map<R>(fn: (value: T) => R): R[]
}
export interface RuntimeUser {
  id: string
  displayName: string
  globalName: string | null
  tag: string
  discriminator: string
  bot: boolean
  createdTimestamp: number
  defaultAvatarURL: string
  avatarURL(options?: object): string | null
}
export interface RuntimeRole {
  id: string
  name: string
  color: number
  rawPosition: number
  managed: boolean
  editable: boolean
  delete(): Promise<unknown>
}
export interface RuntimeMember {
  id: string
  user: RuntimeUser
  displayName: string
  displayHexColor: string
  displayAvatarURL(options?: object): string
  nickname: string | null
  joinedTimestamp: number | null
  premiumSinceTimestamp: number | null
  manageable: boolean
  guild: { ownerId: string }
  roles: {
    cache: RuntimeCollection<RuntimeRole>
    add(ids: string[]): Promise<unknown>
    remove(ids: string[]): Promise<unknown>
  }
}
export interface RuntimeChannel {
  id: string
  name?: string
  type: number
  createdTimestamp: number
  topic?: string | null
  nsfw?: boolean
  parentId?: string | null
  rawPosition?: number
  rateLimitPerUser?: number | null
  setName?(name: string): Promise<unknown>
  setTopic?(topic: string): Promise<unknown>
  setNSFW?(enabled: boolean): Promise<unknown>
  setRateLimitPerUser?(seconds: number): Promise<unknown>
  setPosition?(position: number): Promise<unknown>
  setParent?(id: string | null): Promise<unknown>
  clone?(): Promise<RuntimeChannel>
  permissionOverwrites?: {
    edit(
      id: string,
      values: { SendMessages?: boolean | null; ViewChannel?: boolean | null }
    ): Promise<unknown>
  }
  messages?: { delete(id: string): Promise<unknown> }
}
export interface RuntimeGuild {
  id: string
  name: string
  ownerId: string
  memberCount: number
  createdTimestamp: number
  description: string | null
  premiumTier: number
  premiumSubscriptionCount: number | null
  vanityURLCode: string | null
  iconURL(options?: object): string | null
  bannerURL(options?: object): string | null
  splashURL(options?: object): string | null
  fetchOwner(): Promise<RuntimeMember>
  channels: {
    cache: RuntimeCollection<RuntimeChannel>
    fetch(id: string): Promise<RuntimeChannel | null>
    create(data: {
      name: string
      type: number
      parent?: string
      permissionOverwrites?: { id: string; allow?: bigint[]; deny?: bigint[] }[]
    }): Promise<RuntimeChannel>
    delete(id: string, reason?: string): Promise<unknown>
  }
  roles: {
    cache: RuntimeCollection<RuntimeRole>
    everyone: { id: string }
    create(data: {
      name: string
      color: number
      hoist: boolean
      mentionable: boolean
    }): Promise<RuntimeRole>
  }
  members: {
    me: { permissions: { has(permission: bigint): boolean } } | null
    fetch(id: string): Promise<RuntimeMember>
  }
}
export interface RuntimeClient {
  user: RuntimeUser | null
  ws: { ping: number }
  guilds: { cache: RuntimeCollection<RuntimeGuild> }
  channels: { cache: RuntimeCollection<RuntimeChannel> }
  users: { cache: RuntimeCollection<RuntimeUser> }
  generateInvite(options: { scopes: string[]; permissions: bigint[] }): string
}
export interface RuntimeScript {
  setVariable(name: string, value: unknown): void
  getVariable(name: string): unknown
  deleteVariable(name: string): void
  evaluate(code: string, options?: { wrapReturn?: boolean; timeoutMs?: number }): unknown
}
