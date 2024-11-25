import { writable } from "svelte/store";
import type { AppSettings } from "../types/types";

export const settingsStore = writable<AppSettings>({ 
    theme: 'light',
    showToken: false
});

export async function loadSettings() {
    const settings = await (window as any).electron.ipcRenderer.invoke('get-settings');
    settingsStore.set(settings);
}

export async function saveSettings(newSettings: AppSettings) {
    await (window as any).electron.ipcRenderer.invoke('save-settings', newSettings);
    settingsStore.set(newSettings);
}
