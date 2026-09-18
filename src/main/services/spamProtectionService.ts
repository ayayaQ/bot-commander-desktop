import { MessageType, PermissionsBitField } from 'discord.js'
import type { Message } from 'discord.js'
import type { AppSettings } from '../types/types'
import { OpenRouterDecisionError } from './aiProviderService'

export const SPAM_THRESHOLD = 0.95
export const SPAM_LIMITS = {
  concurrency: 4,
  queue: 50,
  deadlineMs: 3000,
  historyMs: 30_000,
  historyMessages: 10,
  historyAuthors: 1000,
  historyCharacters: 1000
} as const

export interface SpamContext {
  message: string
  recentMessages: { text: string; ageMs: number; sameChannel: boolean }[]
}

export type SpamResult = 'allow' | 'blocked' | 'cancelled'
type HistoryEntry = { text: string; time: number; channelId: string }
type Job = {
  message: Message
  content: string
  context: SpamContext
  controller: AbortController
  resolve: (result: SpamResult) => void
  timer: ReturnType<typeof setTimeout>
  deadline: number
  active: boolean
  done: boolean
}

interface Dependencies {
  getSettings: () => Pick<AppSettings, 'spamProtectionEnabled' | 'openrouterApiKey'>
  classify: (
    key: string,
    context: SpamContext,
    signal: AbortSignal
  ) => Promise<{
    probability: number
    model: string
  }>
  logger: { info: (message: string) => void; warning: (message: string) => void }
}

/** Session-scoped moderation. No message content is persisted or logged. */
export class SpamProtectionService {
  private connected = false
  private jobs = new Set<Job>()
  private queue: Job[] = []
  private active = 0
  private history = new Map<string, HistoryEntry[]>()
  private pausedUntil = 0
  private failures = 0
  private lastWarning = -Infinity

  constructor(private deps: Dependencies) {}

  start() {
    this.stop()
    this.connected = true
  }

  stop() {
    this.connected = false
    this.reset('cancelled')
  }

  settingsChanged(next: AppSettings, previous: AppSettings) {
    if (
      next.spamProtectionEnabled !== previous.spamProtectionEnabled ||
      next.openrouterApiKey !== previous.openrouterApiKey ||
      this.pausedUntil > Date.now()
    )
      this.reset('allow')
  }

  invalidate(messageId: string) {
    for (const job of this.jobs) {
      if (job.message.id === messageId) this.finish(job, 'cancelled')
    }
  }

  private reset(result: SpamResult) {
    // Clear the queue first so finishing active jobs cannot start queued requests.
    this.queue = []
    for (const job of this.jobs) this.finish(job, result)
    this.history.clear()
    this.pausedUntil = 0
    this.failures = 0
    this.lastWarning = -Infinity
  }

  private warn(message: string) {
    if (Date.now() - this.lastWarning < 30_000) return
    this.lastWarning = Date.now()
    this.deps.logger.warning(`Spam protection: ${message}`)
  }

  private eligible(message: Message): boolean {
    if (
      !message.inGuild() ||
      !message.member ||
      message.author.bot ||
      message.webhookId ||
      !message.content.trim() ||
      (message.type !== MessageType.Default && message.type !== MessageType.Reply)
    )
      return false
    if (message.author.id === message.guild.ownerId) return false
    const permissions = message.channel.permissionsFor(message.member)
    if (!permissions) return false
    if (
      permissions.any([
        PermissionsBitField.Flags.Administrator,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ModerateMembers
      ])
    )
      return false
    const bot = message.guild.members.me
    if (
      !bot ||
      !message.channel.permissionsFor(bot)?.has(PermissionsBitField.Flags.ManageMessages)
    ) {
      this.warn(`missing Manage Messages permission in channel ${message.channelId}.`)
      return false
    }
    return true
  }

  check(message: Message): Promise<SpamResult> {
    const settings = this.deps.getSettings()
    if (!this.connected) return Promise.resolve('cancelled')
    if (!settings.spamProtectionEnabled || !settings.openrouterApiKey?.trim()) {
      return Promise.resolve('allow')
    }
    if (!this.eligible(message)) return Promise.resolve('allow')
    const now = Date.now()
    // Prune on arrival; the bounded map is also cleared when protection stops.
    for (const [key, entries] of this.history) {
      const fresh = entries.filter((entry) => now - entry.time < SPAM_LIMITS.historyMs)
      if (fresh.length) this.history.set(key, fresh)
      else this.history.delete(key)
    }
    const key = `${message.guildId}:${message.author.id}`
    const previous = this.history.get(key) || []
    const context: SpamContext = {
      message: message.content,
      recentMessages: previous.map((entry) => ({
        text: entry.text,
        ageMs: now - entry.time,
        sameChannel: entry.channelId === message.channelId
      }))
    }
    this.history.delete(key)
    this.history.set(
      key,
      [
        ...previous,
        {
          text: message.content.slice(0, SPAM_LIMITS.historyCharacters),
          time: now,
          channelId: message.channelId
        }
      ].slice(-SPAM_LIMITS.historyMessages)
    )
    if (this.history.size > SPAM_LIMITS.historyAuthors) {
      this.history.delete(this.history.keys().next().value!)
    }
    if (this.pausedUntil > now) return Promise.resolve('allow')
    if (this.active >= SPAM_LIMITS.concurrency && this.queue.length >= SPAM_LIMITS.queue) {
      this.warn('request queue is full; messages are temporarily being skipped.')
      return Promise.resolve('allow')
    }
    return new Promise((resolve) => {
      const job: Job = {
        message,
        content: message.content,
        context,
        controller: new AbortController(),
        resolve,
        timer: setTimeout(() => {
          if (job.active) this.failure(new Error('timeout'))
          this.warn('check timed out; message was left unchanged.')
          this.finish(job, 'allow')
        }, SPAM_LIMITS.deadlineMs),
        deadline: now + SPAM_LIMITS.deadlineMs,
        active: false,
        done: false
      }
      this.jobs.add(job)
      this.queue.push(job)
      this.drain()
    })
  }

  private finish(job: Job, result: SpamResult) {
    if (job.done) return
    job.done = true
    clearTimeout(job.timer)
    job.controller.abort()
    this.jobs.delete(job)
    this.queue = this.queue.filter((queued) => queued !== job)
    if (job.active) this.active--
    job.resolve(result)
    this.drain()
  }

  private drain() {
    while (this.active < SPAM_LIMITS.concurrency && this.queue.length) {
      const job = this.queue.shift()!
      if (this.pausedUntil > Date.now() || Date.now() >= job.deadline) {
        this.finish(job, 'allow')
        continue
      }
      job.active = true
      this.active++
      void this.run(job)
    }
  }

  private failure(error: unknown) {
    const status = error instanceof OpenRouterDecisionError ? error.status : 0
    if ([401, 402, 403].includes(status)) {
      this.pausedUntil = Infinity
      this.warn(
        'OpenRouter access or credits unavailable. Update Settings or toggle protection to retry.'
      )
    } else if (status === 429) {
      this.pausedUntil = Date.now() + (error as OpenRouterDecisionError).retryAfterMs
      this.warn('OpenRouter rate limit reached; checks paused temporarily.')
    } else if (++this.failures >= 3) {
      this.pausedUntil = Date.now() + 30_000
      this.warn('OpenRouter checks failed repeatedly; checks paused for 30 seconds.')
    } else {
      this.warn('OpenRouter check failed; message was left unchanged.')
    }
  }

  private async run(job: Job) {
    try {
      const verdict = await this.deps.classify(
        this.deps.getSettings().openrouterApiKey!,
        job.context,
        job.controller.signal
      )
      if (job.done) return
      if (Date.now() >= job.deadline) {
        this.finish(job, 'allow')
        return
      }
      this.failures = 0
      if (!this.connected || job.message.content !== job.content) {
        this.finish(job, 'cancelled')
        return
      }
      if (!this.deps.getSettings().spamProtectionEnabled || !this.eligible(job.message)) {
        this.finish(job, 'allow')
        return
      }
      if (verdict.probability < SPAM_THRESHOLD) {
        this.finish(job, 'allow')
        return
      }
      // Suppress commands even if Discord rejects deletion. Once dispatched, a Discord
      // deletion cannot be recalled; cancellation prevents any not-yet-dispatched action.
      const deletion = job.message.delete()
      this.finish(job, 'blocked')
      try {
        await deletion
        this.deps.logger.info(
          `Spam protection: deleted message ${job.message.id} in channel ${job.message.channelId}, ` +
            `server ${job.message.guildId}; probability ${verdict.probability.toFixed(3)}, model ${verdict.model}.`
        )
      } catch (error) {
        if ((error as { code?: number })?.code !== 10008) {
          this.warn(
            `could not delete message ${job.message.id} in channel ${job.message.channelId}. Check Discord permissions.`
          )
        }
      }
    } catch (error) {
      if (job.done) return
      this.failure(error)
      this.finish(job, 'allow')
    }
  }
}
