import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Positive ordinary scope only. Historical adversarial/legacy-input/skills assessments
// remain excluded. Do not replace these file AND test-name selections with a glob.
// Every omission is documented in docs/reference-acceptance.md.
export const selections = [
  {
    file: 'src/shared/playground/engine.test.ts',
    suite: 'isolated playground message simulation',
    names: [
      'runs chat with messageAfterCommand using the configured local AI response',
      'supports local fake context changes and added role IDs without touching saved data',
      'resolves fake roles by raw ID, mention and case-insensitive name',
      'includes the current guild-ID @everyone role in every member gate and role query',
      'does not duplicate an explicit @everyone fixture or retain a previous guild-ID role',
      'interpolates identity, nested functions, arguments and conditions using fake fixtures',
      'matches production exact, case-insensitive phrase, prefix and wildcard rules',
      'requires fake roles/admin and respects whitelist and NSFW gates',
      'toggles roles on the invoker, not the mentioned moderation target',
      'simulates isKick only with permission and exact moderation syntax',
      'simulates isBan only with permission and exact moderation syntax',
      'simulates isVoiceMute only with permission and exact moderation syntax',
      'emits fake replies, DMs and inert embed URLs, with no input mutation',
      'deletes only fake channel messages and preserves fake DMs',
      'simulates reactions and uses production fallback for unknown destinations'
    ]
  },
  {
    file: 'src/shared/playground/execution.test.ts',
    suite: 'playground command execution state',
    names: [
      'persists local botState and cooldown timestamps across successive message and slash requests',
      'retains earlier script commits, replies and effects when a command later fails',
      'keeps a prior matching command committed when a later matching command fails',
      'retains completed interaction effects when a later DM fails',
      'creates a clean reset with empty botState, cooldowns and transcript at clock zero',
      'preserves explicit $set/$get variables across templates and sends separately from botState',
      'keeps untracked JavaScript globals within a command only, shared across its templates',
      'shares tracked interaction variables with embeds, DMs, button labels and later button clicks'
    ]
  },
  {
    file: 'src/shared/playground/execution.test.ts',
    suite: 'playground eval template resolution',
    names: [
      'pre-resolves code expressions while preserving quoted text, comments and static template text',
      'does not interpret template-looking expressions inside eval literals or comments',
      'inserts resolved slash text as a literal value including quotes, backslashes and newlines',
      'allows more than 32 sequential shallow JavaScript template literals before an expression',
      'renders interpolated script diagnostics, rolls back bot state and retains global variables'
    ]
  },
  {
    file: 'src/shared/playground/execution.test.ts',
    suite: 'playground configurable AI mock',
    names: [
      'returns configured inert text for message templates',
      'returns configured inert text for slash templates',
      'returns configured AI failure text after completed message script effects',
      'returns configured AI failure text after completed slash script effects'
    ]
  },
  {
    file: 'src/shared/playground/execution.test.ts',
    suite: 'playground simulated cooldowns',
    names: [
      'uses production-shaped User keys and independently scopes commands, senders and servers',
      'uses production-shaped Server keys and independently scopes commands, senders and servers',
      'uses production-shaped Global keys and independently scopes commands, senders and servers',
      'treats timestamp zero as recorded, rounds remaining seconds up and expires exactly on time',
      'renders custom responses with configured and explicit $cooldownRemaining scopes',
      'honors ignoreErrorMessage=false for the default message cooldown reply',
      'honors ignoreErrorMessage=true for the default message cooldown reply',
      'makes a blocked slash response ephemeral, including custom response ',
      'makes a blocked slash response ephemeral, including custom response Wait $cooldownRemaining seconds',
      'lets buttons execute during their saved slash cooldown without recording another usage',
      'returns AI failure text in cooldown replies without replacing the timestamp'
    ]
  },
  {
    file: 'src/shared/playground/interactions.test.ts',
    suite: 'saved interaction playground',
    names: [
      'accepts editor-supported Unicode and apostrophe option names',
      'resolves duplicate custom IDs by the first saved match as production does',
      'traditional deletion excludes ephemeral replies created by slash simulation',
      'works with only saved interactions and no traditional commands or publication',
      'returns raw user/channel/role IDs and preserves false and zero option values',
      'validates required/unknown options, strict primitive types, finite numbers and fixture IDs',
      'validates typed choice membership, duplicate definitions and choice types',
      'models ephemeral/deferred responses and fake DMs/embeds for the invoker',
      'targets the configured user option for isKick, while roles target invoker',
      'targets the configured user option for isBan, while roles target invoker',
      'targets the configured user option for isVoiceMute, while roles target invoker',
      'requires a typed configured target and retains earlier deletion',
      'applies only fake channel deletion and preserves ephemeral/DM entries',
      'runs nested button actions with click invoker and no inherited slash options',
      'does not perform moderation/delete flags in button actions, matching production',
      'rejects disabled/link/deleted/foreign ephemeral buttons and safely handles obsolete saved buttons',
      'reports unavailable scripts while retaining the prior reply'
    ]
  },
  {
    file: 'src/shared/playground/runtimeV2.test.ts',
    suite: 'shared playground runtime',
    names: [
      'provides every registered production keyword without an unsupported fallback',
      'creates, renames, queries and deletes channels through shared keywords',
      'honors role management permissions and mutates the fake member only',
      'retains startup functions and global bindings across strict steps',
      'requires exact external prompts in strict validation and records request evidence',
      'dispatches message and excludes other command types',
      'dispatches dm and excludes other command types',
      'dispatches memberJoin and excludes other command types',
      'dispatches memberLeave and excludes other command types',
      'dispatches memberBan and excludes other command types',
      'dispatches reaction and excludes other command types',
      'uses the fixture clock and seed during startup and isolates global bindings by case',
      'records a failed send while retaining an earlier successful send and channel mutation',
      'runs channel management, permission resets, role management and presence against the synthetic world',
      'keeps member-event action order distinct from message moderation and cooldowns',
      'does not recreate a deleted active channel in later templates',
      'normalizes presence with the same defaults and reset behavior as production'
    ]
  },
  {
    file: 'src/shared/playground/world.test.ts',
    suite: 'normalized multi-guild world',
    names: [
      'runs one suite with the same user and different memberships without leaking role changes',
      'isolates channel lookups, message deletion, and purge across guilds',
      'rejects mismatched guild/channel contexts and nonmembers, and gives DMs no guild membership',
      'applies everyone, aggregate role allow/deny, then member overwrites; owner/admin bypass',
      'enforces bot overwrites on send and own/other message deletion',
      'enforces hierarchy even for an administrator and respects managed/editable restrictions',
      'round trips large string IDs through fixtures, buttons, reactions and replay reports',
      'preserves maximum snowflakes and rejects cross-channel replies before emitting a message',
      'deletes an owned DM message without allowing deletion of the recipient message',
      'requires explicit contexts in v3 suites'
    ]
  },
  {
    file: 'src/shared/playground/world.test.ts',
    suite: 'normalized role creation',
    names: [
      "preserves role flags and accepts the next event: '$createRole(NewRole,#112233)'",
      "preserves role flags and accepts the next event: '$createRole(NewRole,#112233,true,true)'"
    ]
  },
  {
    file: 'src/shared/playground/cascades.test.ts',
    suite: 'offline gateway cascades',
    names: [
      'replays a multi-command ban/leave cascade with complete causal identity and timing',
      'filters generated bot messages/reactions/DMs and preserves their message identities',
      'does not emit success events for failed moderation, preserving earlier successful effects',
      'retains moderation and earlier handlers when a downstream handler fails',
      'keeps the same user isolated across two guilds and honors handler server whitelists',
      'suppresses duplicate removal/ban notifications from repeated successful effects',
      'records kick removal and ignores bot-member removal, with no fictitious mute/role events',
      'counts the exact downstream candidate and cannot credit unrelated selected commands',
      'supports assertions over the complete causal trace',
      'discards pending notifications on cancellation/disposal and starts reset runs without stale events',
      'cascades slash moderation through explicit selected traditional snapshots'
    ]
  },
  {
    file: 'src/shared/playground/referenceAcceptance.test.ts',
    suite: 'ordinary reference acceptance sequences',
    names: [
      'renders the documented welcome template exactly on memberJoin',
      'increments a counter, preserves it and its cooldown on denial, then increments at expiry',
      'allows the ephemeral role button recipient and leaves all members unchanged for another user',
      "enforces bot permission and hierarchy for the role button: 'lower role permitted'",
      "enforces bot permission and hierarchy for the role button: 'missing ManageRoles denied'",
      "enforces bot permission and hierarchy for the role button: 'equal role denied'",
      "enforces bot permission and hierarchy for the role button: 'higher role denied'",
      "enforces bot permission and hierarchy for the role button: 'equal member denied'",
      "enforces bot permission and hierarchy for the role button: 'higher member denied'",
      "enforces bot permission and hierarchy for the role button: 'administrator hierarchy denied'"
    ]
  },
  {
    file: 'src/main/services/agentReferenceWorkflow.test.ts',
    suite: 'agent command reference workflow',
    names: ['validates, manually approves, atomically saves and reloads the identical new command']
  }
]

const root = fileURLToPath(new URL('../', import.meta.url))
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function selectedFiles() {
  return [...new Set(selections.map(({ file }) => file))].map((file) => ({
    file,
    names: selections
      .filter((selection) => selection.file === file)
      .flatMap(({ suite, names }) => names.map((name) => `${suite} ${name}`))
  }))
}

export function vitestArgs({ file, names }, reportPath) {
  return [
    vitest,
    'run',
    file,
    '--testNamePattern',
    `^(?:${names.map(escapeRegex).join('|')})$`,
    '--reporter=default',
    '--reporter=json',
    '--outputFile',
    reportPath
  ]
}

export function runOrdinaryPlayground({ spawn = spawnSync, log = console.log, summary } = {}) {
  const results = []
  const directory = mkdtempSync(join(tmpdir(), 'ordinary-playground-'))
  try {
    for (const selection of selectedFiles()) {
      log(`Ordinary Playground: ${selection.file} (${selection.names.length} selected tests)`)
      let result,
        passedTests = null
      try {
        const reportPath = join(directory, `${results.length}.json`)
        result = spawn(process.execPath, vitestArgs(selection, reportPath), {
          cwd: root,
          stdio: 'inherit'
        })
        if (!result.error && !result.signal) {
          const report = JSON.parse(readFileSync(reportPath, 'utf8'))
          const executed = report.testResults
            .flatMap((file) => file.assertionResults)
            .filter((test) => !['pending', 'skipped', 'todo', 'disabled'].includes(test.status))
          passedTests = executed.filter((test) => test.status === 'passed').length
          const expected = new Set(selection.names)
          if (
            executed.length !== expected.size ||
            passedTests !== expected.size ||
            new Set(executed.map((test) => test.fullName)).size !== expected.size ||
            executed.some((test) => !expected.has(test.fullName))
          ) {
            throw new Error(
              'Executed test names/counts differ from the explicit ordinary selection'
            )
          }
        }
      } catch (error) {
        result = { error }
      }
      const passed = !result.error && !result.signal && result.status === 0
      results.push({ file: selection.file, passed, passedTests, selected: selection.names.length })
      if (!passed)
        log(`Failed: ${selection.file}: ${result.error?.message ?? result.signal ?? result.status}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const failed = results.filter((result) => !result.passed).length
  const report = [
    '### Ordinary offline Playground',
    '',
    ...results.map(({ file, passed, passedTests, selected }) => {
      const count =
        passedTests === null
          ? `results unavailable; ${selected} selected`
          : `${passedTests}/${selected} tests`
      return `- ${passed ? 'PASS' : 'FAIL'}: \`${file}\` (${count})`
    }),
    '',
    `${results.length - failed}/${results.length} selected files passed.`,
    'Explicit file and test-name allowlist; omissions: docs/reference-acceptance.md.',
    'No rendered, native, live Discord or provider validation is claimed.',
    ''
  ].join('\n')
  log(report)
  summary?.(report)
  return failed ? 1 : 0
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--list') {
    console.log(JSON.stringify(selectedFiles(), null, 2))
    return 0
  }
  if (args.length) {
    console.error(
      'Usage: node scripts/test-playground.mjs [--list]; test overrides are not accepted'
    )
    return 1
  }
  return runOrdinaryPlayground({
    summary: process.env.GITHUB_STEP_SUMMARY
      ? (report) => appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
      : undefined
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
