import { expandMcpResourceTemplate, type McpTemplateExpander } from '@ayayaq/vivi/extensions/mcp'
import { parseTemplate } from 'url-template'

/** Trusted scalar RFC 6570 expansion only: synchronous, deterministic, and no I/O. */
export const expandAgentMcpTemplate: McpTemplateExpander = (uriTemplate, variables) => {
  // The library supports broader syntax. The published core admits only our bounded scalar slice.
  return expandMcpResourceTemplate(uriTemplate, variables, (template, values) =>
    parseTemplate(template).expand(values)
  )
}
