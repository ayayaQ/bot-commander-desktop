import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'
import { createAgentExtensionRegistry } from './agentExtensions'

afterEach(() => vi.restoreAllMocks())

describe('desktop agent extension snapshot', () => {
  it('registers the same pure calculator with frozen provider definitions', async () => {
    const registry = createAgentExtensionRegistry(['edit_command', 'search_documentation'])
    expect(registry.tools.map((tool) => tool.name)).toEqual(['calculate'])
    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(registry.tools)).toBe(true)
    expect(Object.isFrozen(registry.tools[0])).toBe(true)
    expect(Object.isFrozen(registry.tools[0].parameters)).toBe(true)
    expect(Object.isFrozen(registry.tools[0].parameters.properties)).toBe(true)
    expect(registry.has('edit_command')).toBe(false)
    expect(
      await registry.executeTool(
        { id: 'calc_1', name: 'calculate', arguments: { expression: '2 * (3 + 4)' } },
        { signal: new AbortController().signal }
      )
    ).toEqual({ content: '{"result":14}' })
  })

  it('rejects reserved names rather than replacing a host tool', () => {
    expect(() => createAgentExtensionRegistry(['calculate'])).toThrow('Tool name collision')
  })

  it('rejects unknown names without executing the registered calculator', async () => {
    const execute = vi.spyOn(calculatorExtension.tools[0], 'execute')
    const registry = createAgentExtensionRegistry([])
    expect(registry.has('calculate_unknown')).toBe(false)
    const result = await registry.executeTool(
      { id: 'calc_unknown', name: 'calculate_unknown', arguments: { expression: '1' } },
      { signal: new AbortController().signal }
    )
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({
      success: false,
      error: { code: 'unavailable_tool' }
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('captures schemas and validator/executor references rather than live extension state', async () => {
    const registry = createAgentExtensionRegistry([])
    const tool = calculatorExtension.tools[0]
    const description = tool.definition.description
    try {
      tool.definition.description = 'Changed after advertisement'
      const validate = vi.spyOn(tool, 'validateArguments').mockImplementation(() => {
        throw new Error('Replacement validator')
      })
      const execute = vi.spyOn(tool, 'execute').mockReturnValue({ content: '{"result":99}' })
      expect(registry.tools[0].description).toBe(description)
      expect(
        await registry.executeTool(
          { id: 'calc_snapshot', name: 'calculate', arguments: { expression: '1 + 1' } },
          { signal: new AbortController().signal }
        )
      ).toEqual({ content: '{"result":2}' })
      expect(validate).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    } finally {
      tool.definition.description = description
    }
  })

  it('rejects malformed arguments before execution and propagates cancellation', async () => {
    const execute = vi.spyOn(calculatorExtension.tools[0], 'execute')
    const registry = createAgentExtensionRegistry([])
    const controller = new AbortController()
    const call = {
      id: 'calc_invalid',
      name: 'calculate',
      arguments: { expression: 'process.exit()' }
    }
    const result = await registry.executeTool(call, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({
      success: false,
      error: { code: 'invalid_arguments' }
    })
    expect(execute).not.toHaveBeenCalled()
    controller.abort(new Error('Cancelled test'))
    await expect(registry.executeTool(call, { signal: controller.signal })).rejects.toThrow(
      'Cancelled test'
    )
  })
})
