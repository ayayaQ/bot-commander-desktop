import fs from 'fs/promises'

export class Stats {
  private userCount: number = 0
  private messagesSent: number = 0
  private messagesReceived: number = 0
  private joinEventsReceived: number = 0
  private leaveEventsReceived: number = 0
  private banEventsReceived: number = 0
  private privateMessagesReceived: number = 0
  private serverCount: number = 0
  private commandCount: number = 0
  private webhooksSent: number = 0
  private timeSpentInApp: number = 0
  private lastUpdateTime: number = Date.now()

  constructor() {
    this.updateTimeSpentInApp()
  }

  private updateTimeSpentInApp(): void {
    const currentTime = Date.now()
    this.timeSpentInApp += (currentTime - this.lastUpdateTime) / 1000 // Convert to seconds
    this.lastUpdateTime = currentTime
  }

  updateUserCount(count: number): void {
    this.userCount = count
  }

  incrementMessagesSent(): void {
    this.messagesSent++
  }

  incrementMessagesReceived(): void {
    this.messagesReceived++
  }

  incrementJoinEventsReceived(): void {
    this.joinEventsReceived++
  }

  incrementLeaveEventsReceived(): void {
    this.leaveEventsReceived++
  }

  incrementBanEventsReceived(): void {
    this.banEventsReceived++
  }

  incrementPrivateMessagesReceived(): void {
    this.privateMessagesReceived++
  }

  updateServerCount(count: number): void {
    this.serverCount = count
  }

  updateCommandCount(count: number): void {
    this.commandCount = count
  }

  incrementWebhooksSent(): void {
    this.webhooksSent++
  }

  async saveToFile(filePath: string): Promise<void> {
    this.updateTimeSpentInApp()
    const data = JSON.stringify(this, null, 2)
    await fs.writeFile(filePath, data, 'utf-8')
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      const data = await fs.readFile(filePath, 'utf-8')
      const parsedData = JSON.parse(data)
      Object.assign(this, parsedData)
      this.lastUpdateTime = Date.now() // Reset the last update time
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('Stats file not found. Starting with default values.')
      } else {
        throw error
      }
    }
  }

  getStats(): Record<string, number> {
    this.updateTimeSpentInApp()
    return {
      userCount: this.userCount,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      joinEventsReceived: this.joinEventsReceived,
      leaveEventsReceived: this.leaveEventsReceived,
      banEventsReceived: this.banEventsReceived,
      privateMessagesReceived: this.privateMessagesReceived,
      serverCount: this.serverCount,
      commandCount: this.commandCount,
      webhooksSent: this.webhooksSent,
      timeSpentInApp: Math.round(this.timeSpentInApp)
    }
  }
}

