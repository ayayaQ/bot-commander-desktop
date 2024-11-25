import { AppSettings } from "../types/types"

let settings: AppSettings = { theme: 'light', showToken: false } // Default settings

export function getSettings() {
  return settings
}

export function setSettings(newSettings: AppSettings) {
  settings = newSettings
}

