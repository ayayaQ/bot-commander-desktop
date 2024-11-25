import { BotStatus } from "../types/types";

let botStatus: BotStatus = {
    status: 'Online',
    activity: 'Playing',
    activityDetails: 'with BCFD',
    streamUrl: ''
  } // Default bot status

export function getBotStatus() {
  return botStatus
}

export function setBotStatus(newBotStatus: BotStatus) {
  botStatus = newBotStatus
}

