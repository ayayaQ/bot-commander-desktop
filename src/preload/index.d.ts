import { ExposedElectronAPI } from '../renderer/src/env'

declare global {
  interface Window {
    electron: ExposedElectronAPI
    api: unknown
  }
}
