import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Explicit ordinary scope. Historical adversarial/legacy-input/skills assessments are excluded.
const files = [
  'src/shared/agentContext.test.ts',
  'src/main/services/agentContextStore.test.ts',
  'src/main/services/agentContextProjection.test.ts',
  'src/main/services/agentConversationRecords.test.ts',
  'src/main/services/agentConversationWorkflow.integration.test.ts',
  'src/main/services/agentExtensions.integration.test.ts',
  'src/main/services/agentMcpConfig.test.ts',
  'src/main/services/agentMcpService.test.ts',
  'src/main/services/agentMcpOAuthCallback.test.ts',
  'src/main/services/agentMcpOAuthNetwork.test.ts',
  'src/main/services/agentMcpOAuthRegistration.test.ts',
  'src/main/services/agentMcpOAuthSession.test.ts',
  'src/main/services/agentMcpOAuthService.test.ts',
  'src/main/services/agentMcpHttp.test.ts',
  'src/main/services/agentMcpTemplates.test.ts',
  'src/main/services/agentMcpPrivacy.test.ts',
  'src/main/services/agentMcpTransport.test.ts',
  'src/main/services/agentMcpWindows.test.ts',
  'src/main/services/agentMcpOutcomes.test.ts',
  'src/main/services/agentMcpWorkflow.integration.test.ts',
  'src/renderer/src/stores/agentMcp.test.ts',
  'src/renderer/src/utils/agentMcpOutcome.test.ts',
  'src/main/handlers/ipcHandlers.test.ts',
  'src/main/handlers/ipcSecurity.test.ts',
  'src/main/index.test.ts',
  'src/preload/index.test.ts',
  'src/main/services/mcpConfigService.test.ts',
  'src/main/services/mcpServerService.test.ts',
  'src/main/services/agentHistory.test.ts',
  'src/main/services/agentSessionPersistence.test.ts',
  'src/main/services/agentProviderAdapter.test.ts',
  'src/main/services/agentToolResult.test.ts',
  'src/main/utils/gracefulShutdown.test.ts',
  'src/main/services/atomicPersistence.test.ts',
  'src/renderer/src/utils/agentProgress.test.ts',
  'src/renderer/src/utils/agentToolLabel.test.ts'
]
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const result = spawnSync(process.execPath, [vitest, 'run', ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
