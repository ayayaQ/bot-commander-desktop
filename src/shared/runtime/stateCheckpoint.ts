/** Evaluated before guest code; restores the original object graph so aliases survive rollback. */
export const STATE_CHECKPOINT_FACTORY = `(function (isProxy) {
      const descriptors = Object.getOwnPropertyDescriptors
      const keys = Reflect.ownKeys
      const define = Object.defineProperty
      const remove = Reflect.deleteProperty
      const getOwn = Object.getOwnPropertyDescriptor
      const getPrototype = Object.getPrototypeOf
      const setPrototype = Object.setPrototypeOf
      const owns = Function.prototype.call.bind(Object.prototype.hasOwnProperty)
      const global = globalThis
      const SetClass = Set
      const setHas = Function.prototype.call.bind(Set.prototype.has)
      const setAdd = Function.prototype.call.bind(Set.prototype.add)
      return function (name) {
        const original = getOwn(global, name)
        if (!original || !owns(original, 'value')) throw new Error('botState must be an own data property')
        const visited = new SetClass()
        const entries = []
        // Numeric setters on guest prototypes must not swallow checkpoint bookkeeping.
        setPrototype(entries, null)
        function capture(value) {
          if (isProxy(value)) throw new Error('botState contains a Proxy')
          if (value === null || typeof value !== 'object' || setHas(visited, value)) return
          setAdd(visited, value)
          const properties = descriptors(value)
          entries[entries.length] = [value, properties, getPrototype(value)]
          const names = keys(properties)
          for (let i = 0; i < names.length; i++) {
            const key = names[i]
            if (owns(properties[key], 'value')) capture(properties[key].value)
          }
        }
        if (original && owns(original, 'value')) capture(original.value)
        return function () {
          for (let i = 0; i < entries.length; i++) {
            const value = entries[i][0]
            const properties = entries[i][1]
            const originalPrototype = entries[i][2]
            const names = keys(value)
            for (let j = 0; j < names.length; j++) {
              const key = names[j]
              if (!owns(properties, key) && !remove(value, key)) {
                throw new Error('Unable to roll back bot state property')
              }
            }
            const originals = keys(properties)
            for (let j = 0; j < originals.length; j++) {
              const key = originals[j]
              define(value, key, properties[key])
            }
            setPrototype(value, originalPrototype)
          }
          if (original) define(global, name, original)
          else if (!remove(global, name)) throw new Error('Unable to roll back bot state')
        }
      }
    })`

export interface StateCheckpoint {
  restore(): void
  dispose(): void
}
