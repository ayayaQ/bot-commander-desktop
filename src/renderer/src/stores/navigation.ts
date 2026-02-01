import { writable } from 'svelte/store'

function createBottomNavStore() {
  const { subscribe, set } = writable<boolean>(true)

  return {
    subscribe,
    show: () => set(true),
    hide: () => set(false)
  }
}

export const bottomNavVisible = createBottomNavStore()
