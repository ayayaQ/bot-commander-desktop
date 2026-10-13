// Harmless offline stdio fixture: only local catalog metadata, text reads, and request recording.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [mode, recordingPath, uriTemplate] = process.argv.slice(2)
if (!['normal', 'exit-on-read', 'different-uri'].includes(mode) || !recordingPath || !uriTemplate)
  throw new Error('Invalid offline template fixture arguments')

const record = (value) => appendFileSync(recordingPath, JSON.stringify(value) + '\n', 'utf8')
record({ fixture: 'started', environmentKeys: Object.keys(process.env).sort() })
let templateListings = 0
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const request = JSON.parse(line)
  record(request)
  if (!Object.hasOwn(request, 'id')) return

  let result
  if (request.method === 'initialize')
    result = {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {}, resources: { listChanged: true } },
      serverInfo: { name: 'Offline template fixture', version: '1' }
    }
  else if (request.method === 'server/discover')
    result = {
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, resources: { listChanged: true } },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: 'Offline template fixture', version: '1' }
      }
    }
  else if (request.method === 'tools/list') result = { resultType: 'complete', tools: [] }
  else if (request.method === 'resources/list')
    result = {
      resultType: 'complete',
      resources: [{ uri: 'fixture:///already-discovered', name: 'Offline concrete document' }]
    }
  else if (request.method === 'resources/templates/list')
    result = {
      resultType: 'complete',
      resourceTemplates: [
        { uriTemplate, name: `Offline template revision ${++templateListings}` },
        { uriTemplate: 'fixture:///metadata-only/{name*}', name: 'Unsupported modifier metadata' }
      ]
    }
  else if (request.method === 'resources/read') {
    if (mode === 'exit-on-read') {
      // Recording is synchronous: the parent can distinguish an attempted read from no read.
      process.exit(0)
    }
    result = {
      resultType: 'complete',
      contents: [
        {
          uri:
            mode === 'different-uri'
              ? request.params.uri.replace('%2f', '%2F')
              : request.params.uri,
          mimeType: 'text/plain',
          text: 'Offline template document'
        }
      ]
    }
  } else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Unsupported offline fixture method' }
      }) + '\n'
    )
    return
  }
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { ...result, ttlMs: 0, cacheScope: 'private' }
    }) + '\n'
  )
})
