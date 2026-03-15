<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte'
  import { highlightBCFD, highlightJavaScript } from '../utils/highlight'

  interface Props {
    value?: string
    placeholder?: string
    minHeight?: string
    mode?: 'bcfd' | 'js' // 'bcfd' for template language, 'js' for pure JavaScript
    readonly?: boolean
  }

  let {
    value = $bindable(''),
    placeholder = '',
    minHeight = '200px',
    mode = 'bcfd',
    readonly = false
  }: Props = $props()

  const dispatch = createEventDispatcher<{ change: string }>()

  let textareaElement: HTMLTextAreaElement = $state()
  let highlightElement: HTMLDivElement = $state()
  let lineNumbersElement: HTMLDivElement = $state()
  let containerElement: HTMLDivElement = $state()
  let autocompleteVisible = $state(false)
  let autocompleteItems: AutocompleteItem[] = $state([])
  let autocompleteIndex = $state(0)
  let autocompletePosition = $state({ top: 0, left: 0 })
  let currentWord = ''
  let wordStartIndex = 0
  let isJsAutocomplete = $state(false) // Track if we're showing JS keywords (no $ prefix)

  interface AutocompleteItem {
    name: string
    syntax: 'variable' | 'function-paren' | 'function-brace' | 'keyword'
    description: string
    insertText?: string
  }

  // BCFD Language definitions for autocomplete
  const bcfdItems: AutocompleteItem[] = [
    // Keywords
    {
      name: 'eval',
      syntax: 'keyword',
      description: 'Start JavaScript eval block',
      insertText: 'eval\n\n$halt'
    },
    { name: 'halt', syntax: 'keyword', description: 'End JavaScript eval block' },
    {
      name: 'if',
      syntax: 'keyword',
      description: 'Conditional block',
      insertText: 'if()\n\n$endif'
    },
    {
      name: 'elseif',
      syntax: 'keyword',
      description: 'Else-if branch',
      insertText: 'elseif()'
    },
    { name: 'else', syntax: 'keyword', description: 'Else branch' },
    { name: 'endif', syntax: 'keyword', description: 'End if block' },

    // User Context
    { name: 'name', syntax: 'variable', description: 'User mention (e.g. @User)' },
    { name: 'namePlain', syntax: 'variable', description: 'User display name (plain text)' },
    { name: 'avatar', syntax: 'variable', description: 'User avatar URL' },
    { name: 'discriminator', syntax: 'variable', description: 'User discriminator' },
    { name: 'tag', syntax: 'variable', description: 'User tag (e.g. User#1234)' },
    { name: 'id', syntax: 'variable', description: 'User ID' },
    { name: 'timeCreated', syntax: 'variable', description: 'User account creation time' },
    { name: 'defaultavatar', syntax: 'variable', description: 'User default avatar URL' },

    // Member Context
    { name: 'memberIsOwner', syntax: 'variable', description: 'Is member the server owner' },
    { name: 'memberEffectiveName', syntax: 'variable', description: 'Member display name' },
    { name: 'memberNickname', syntax: 'variable', description: 'Member nickname' },
    { name: 'memberID', syntax: 'variable', description: 'Member ID' },
    { name: 'memberHasTimeJoined', syntax: 'variable', description: 'Has member join time' },
    { name: 'memberTimeJoined', syntax: 'variable', description: 'Member join time' },
    { name: 'memberEffectiveAvatar', syntax: 'variable', description: 'Member effective avatar' },
    { name: 'memberEffectiveTag', syntax: 'variable', description: 'Member effective tag' },
    { name: 'memberEffectiveID', syntax: 'variable', description: 'Member effective ID' },
    {
      name: 'memberEffectiveTimeCreated',
      syntax: 'variable',
      description: 'Member account creation time'
    },
    {
      name: 'memberEffectiveDefaultAvatar',
      syntax: 'variable',
      description: 'Member default avatar'
    },
    { name: 'memberTimeBoosted', syntax: 'variable', description: 'When member started boosting' },
    { name: 'memberHasBoosted', syntax: 'variable', description: 'Is member boosting' },

    // Bot Context
    { name: 'ping', syntax: 'variable', description: 'Bot WebSocket ping (ms)' },
    { name: 'inviteURL', syntax: 'variable', description: 'Bot invite URL' },
    { name: 'serverCount', syntax: 'variable', description: 'Number of servers bot is in' },
    { name: 'allMemberCount', syntax: 'variable', description: 'Total cached member count' },
    { name: 'botAvatar', syntax: 'variable', description: 'Bot avatar URL' },
    { name: 'botName', syntax: 'variable', description: 'Bot mention' },
    { name: 'botNamePlain', syntax: 'variable', description: 'Bot display name' },
    { name: 'botID', syntax: 'variable', description: 'Bot user ID' },
    { name: 'botTimeCreated', syntax: 'variable', description: 'Bot account creation time' },
    { name: 'botDefaultAvatar', syntax: 'variable', description: 'Bot default avatar URL' },
    { name: 'botDiscriminator', syntax: 'variable', description: 'Bot discriminator' },
    { name: 'botTag', syntax: 'variable', description: 'Bot tag' },

    // Guild Context
    { name: 'server', syntax: 'variable', description: 'Server name' },
    { name: 'serverIcon', syntax: 'variable', description: 'Server icon URL' },
    { name: 'serverBanner', syntax: 'variable', description: 'Server banner URL' },
    { name: 'serverDescription', syntax: 'variable', description: 'Server description' },
    { name: 'serverSplash', syntax: 'variable', description: 'Server splash URL' },
    { name: 'serverCreateTime', syntax: 'variable', description: 'Server creation time' },
    { name: 'memberCount', syntax: 'variable', description: 'Server member count' },

    // Channel Context
    { name: 'channel', syntax: 'variable', description: 'Channel name' },
    { name: 'channelID', syntax: 'variable', description: 'Channel ID' },
    { name: 'channelCreateDate', syntax: 'variable', description: 'Channel creation date' },
    {
      name: 'channelAsMention',
      syntax: 'variable',
      description: 'Channel mention (e.g. #general)'
    },
    { name: 'channelTopic', syntax: 'variable', description: 'Channel topic' },
    { name: 'channelIsNSFW', syntax: 'variable', description: 'Is channel NSFW (true/false)' },
    { name: 'channelCount', syntax: 'variable', description: 'Total channel count in server' },

    // Channel Management
    {
      name: 'createChannel',
      syntax: 'function-paren',
      description: 'Create a new channel',
      insertText: 'createChannel(name, type)'
    },
    {
      name: 'createChannelIn',
      syntax: 'function-paren',
      description: 'Create channel in category',
      insertText: 'createChannelIn(name, type, categoryID)'
    },
    {
      name: 'cloneChannel',
      syntax: 'function-paren',
      description: 'Clone an existing channel',
      insertText: 'cloneChannel(channelID)'
    },
    {
      name: 'deleteChannel',
      syntax: 'function-paren',
      description: 'Delete a channel',
      insertText: 'deleteChannel(channelID, reason)'
    },
    {
      name: 'setChannelName',
      syntax: 'function-paren',
      description: 'Rename a channel',
      insertText: 'setChannelName(channelID, name)'
    },
    {
      name: 'setChannelTopic',
      syntax: 'function-paren',
      description: 'Set channel topic',
      insertText: 'setChannelTopic(channelID, topic)'
    },
    {
      name: 'setChannelNSFW',
      syntax: 'function-paren',
      description: 'Set channel NSFW flag',
      insertText: 'setChannelNSFW(channelID, true)'
    },
    {
      name: 'setChannelSlowmode',
      syntax: 'function-paren',
      description: 'Set slowmode delay (0-21600s)',
      insertText: 'setChannelSlowmode(channelID, seconds)'
    },
    {
      name: 'setChannelPosition',
      syntax: 'function-paren',
      description: 'Set channel position',
      insertText: 'setChannelPosition(channelID, position)'
    },
    {
      name: 'setChannelParent',
      syntax: 'function-paren',
      description: 'Move channel to category',
      insertText: 'setChannelParent(channelID, categoryID)'
    },
    {
      name: 'findChannel',
      syntax: 'function-paren',
      description: 'Find channel by name',
      insertText: 'findChannel(name)'
    },
    {
      name: 'getChannelName',
      syntax: 'function-paren',
      description: 'Get channel name by ID',
      insertText: 'getChannelName(channelID)'
    },
    {
      name: 'getChannelType',
      syntax: 'function-paren',
      description: 'Get channel type',
      insertText: 'getChannelType(channelID)'
    },
    {
      name: 'getChannelParent',
      syntax: 'function-paren',
      description: 'Get parent category ID',
      insertText: 'getChannelParent(channelID)'
    },
    {
      name: 'listChannels',
      syntax: 'function-paren',
      description: 'List channel names by type',
      insertText: 'listChannels(type)'
    },
    {
      name: 'listChannelIDs',
      syntax: 'function-paren',
      description: 'List channel IDs by type',
      insertText: 'listChannelIDs(type)'
    },
    {
      name: 'lockChannel',
      syntax: 'function-paren',
      description: 'Lock channel for a role',
      insertText: 'lockChannel(channelID, roleID)'
    },
    {
      name: 'unlockChannel',
      syntax: 'function-paren',
      description: 'Unlock channel for a role',
      insertText: 'unlockChannel(channelID, roleID)'
    },
    {
      name: 'channelMention',
      syntax: 'function-paren',
      description: 'Format channel ID as mention',
      insertText: 'channelMention(channelID)'
    },

    // Mentioned User Context
    { name: 'mentionedName', syntax: 'variable', description: 'Mentioned user mention' },
    { name: 'mentionedID', syntax: 'variable', description: 'Mentioned user ID' },
    { name: 'mentionedTag', syntax: 'variable', description: 'Mentioned user tag' },
    {
      name: 'mentionedDiscriminator',
      syntax: 'variable',
      description: 'Mentioned user discriminator'
    },
    { name: 'mentionedAvatar', syntax: 'variable', description: 'Mentioned user avatar' },
    {
      name: 'mentionedTimeCreated',
      syntax: 'variable',
      description: 'Mentioned user creation time'
    },
    { name: 'mentionedNamePlain', syntax: 'variable', description: 'Mentioned user display name' },
    {
      name: 'mentionedDefaultAvatar',
      syntax: 'variable',
      description: 'Mentioned user default avatar'
    },
    { name: 'mentionedIsBot', syntax: 'variable', description: 'Is mentioned user a bot' },

    // Utility Variables
    { name: 'randomInt', syntax: 'variable', description: 'Random integer 0-99' },
    { name: 'randomFloat', syntax: 'variable', description: 'Random float 0-1' },
    { name: 'randomBoolean', syntax: 'variable', description: 'Random true/false' },
    { name: 'commandCount', syntax: 'variable', description: 'Number of BCFD commands' },
    { name: 'date', syntax: 'variable', description: 'Current date/time' },
    { name: 'hours', syntax: 'variable', description: 'Current hour (00-23)' },
    { name: 'minutes', syntax: 'variable', description: 'Current minute (00-59)' },
    { name: 'seconds', syntax: 'variable', description: 'Current second (00-59)' },
    { name: 'message', syntax: 'variable', description: 'Full message content' },
    { name: 'messageAfterCommand', syntax: 'variable', description: 'Message after command' },
    { name: 'argsCount', syntax: 'variable', description: 'Number of arguments' },

    // Functions with arguments
    {
      name: 'random',
      syntax: 'function-brace',
      description: 'Pick random option',
      insertText: 'random{|}'
    },
    {
      name: 'rollnum',
      syntax: 'function-paren',
      description: 'Random number in range',
      insertText: 'rollnum(min, max)'
    },
    {
      name: 'sum',
      syntax: 'function-paren',
      description: 'Sum of numbers',
      insertText: 'sum(n1, n2)'
    },
    {
      name: 'sub',
      syntax: 'function-paren',
      description: 'Subtract two numbers',
      insertText: 'sub(a, b)'
    },
    {
      name: 'mul',
      syntax: 'function-paren',
      description: 'Multiply numbers',
      insertText: 'mul(n1, n2)'
    },
    {
      name: 'div',
      syntax: 'function-paren',
      description: 'Divide two numbers',
      insertText: 'div(a, b)'
    },
    {
      name: 'mod',
      syntax: 'function-paren',
      description: 'Modulo of two numbers',
      insertText: 'mod(a, b)'
    },
    {
      name: 'round',
      syntax: 'function-paren',
      description: 'Round to nearest integer or N decimals',
      insertText: 'round(n, decimals)'
    },
    { name: 'floor', syntax: 'function-paren', description: 'Round down', insertText: 'floor(n)' },
    { name: 'ceil', syntax: 'function-paren', description: 'Round up', insertText: 'ceil(n)' },
    {
      name: 'abs',
      syntax: 'function-paren',
      description: 'Absolute value',
      insertText: 'abs(n)'
    },
    {
      name: 'toFixed',
      syntax: 'function-paren',
      description: 'Format to fixed decimal places',
      insertText: 'toFixed(n, decimals)'
    },
    {
      name: 'min',
      syntax: 'function-paren',
      description: 'Minimum of numbers',
      insertText: 'min(n1, n2)'
    },
    {
      name: 'max',
      syntax: 'function-paren',
      description: 'Maximum of numbers',
      insertText: 'max(n1, n2)'
    },
    {
      name: 'clamp',
      syntax: 'function-paren',
      description: 'Clamp value between min and max',
      insertText: 'clamp(n, min, max)'
    },
    {
      name: 'pow',
      syntax: 'function-paren',
      description: 'Exponentiation',
      insertText: 'pow(base, exp)'
    },
    {
      name: 'sqrt',
      syntax: 'function-paren',
      description: 'Square root',
      insertText: 'sqrt(n)'
    },
    {
      name: 'log',
      syntax: 'function-paren',
      description: 'Natural logarithm',
      insertText: 'log(n)'
    },
    { name: 'pi', syntax: 'variable', description: 'Pi constant (3.14159...)' },
    {
      name: 'isNumber',
      syntax: 'function-paren',
      description: 'Check if text is a valid number',
      insertText: 'isNumber(text)'
    },
    {
      name: 'args',
      syntax: 'function-paren',
      description: 'Get argument at index',
      insertText: 'args(0)'
    },
    {
      name: 'set',
      syntax: 'function-paren',
      description: 'Store a variable',
      insertText: 'set(name, value)'
    },
    {
      name: 'get',
      syntax: 'function-paren',
      description: 'Retrieve a variable',
      insertText: 'get(name)'
    },
    {
      name: 'chat',
      syntax: 'function-paren',
      description: 'AI chat response',
      insertText: 'chat(prompt)'
    },
    {
      name: 'option',
      syntax: 'function-paren',
      description: 'Get option value (interaction commands)',
      insertText: 'option(name)'
    },
    {
      name: 'contains',
      syntax: 'function-paren',
      description: 'Check if text contains search string',
      insertText: 'contains(text, search)'
    },
    {
      name: 'startsWith',
      syntax: 'function-paren',
      description: 'Check if text starts with prefix',
      insertText: 'startsWith(text, prefix)'
    },
    {
      name: 'endsWith',
      syntax: 'function-paren',
      description: 'Check if text ends with suffix',
      insertText: 'endsWith(text, suffix)'
    }
  ]

  // JavaScript keywords for autocomplete inside $eval blocks
  const jsKeywords: AutocompleteItem[] = [
    { name: 'let', syntax: 'keyword', description: 'Declare block-scoped variable' },
    { name: 'const', syntax: 'keyword', description: 'Declare block-scoped constant' },
    { name: 'var', syntax: 'keyword', description: 'Declare function-scoped variable' },
    {
      name: 'if',
      syntax: 'keyword',
      description: 'Conditional statement',
      insertText: 'if () {\n  \n}'
    },
    { name: 'else', syntax: 'keyword', description: 'Alternative branch' },
    {
      name: 'for',
      syntax: 'keyword',
      description: 'For loop',
      insertText: 'for (let i = 0; i < ; i++) {\n  \n}'
    },
    {
      name: 'while',
      syntax: 'keyword',
      description: 'While loop',
      insertText: 'while () {\n  \n}'
    },
    {
      name: 'function',
      syntax: 'keyword',
      description: 'Function declaration',
      insertText: 'function name() {\n  \n}'
    },
    { name: 'return', syntax: 'keyword', description: 'Return value from function' },
    { name: 'true', syntax: 'keyword', description: 'Boolean true' },
    { name: 'false', syntax: 'keyword', description: 'Boolean false' },
    { name: 'null', syntax: 'keyword', description: 'Null value' },
    { name: 'undefined', syntax: 'keyword', description: 'Undefined value' },
    { name: 'typeof', syntax: 'keyword', description: 'Get type of value' },
    { name: 'new', syntax: 'keyword', description: 'Create new instance' },
    { name: 'this', syntax: 'keyword', description: 'Current context' },
    {
      name: 'try',
      syntax: 'keyword',
      description: 'Try block',
      insertText: 'try {\n  \n} catch (e) {\n  \n}'
    },
    { name: 'catch', syntax: 'keyword', description: 'Catch exception' },
    { name: 'throw', syntax: 'keyword', description: 'Throw exception' },
    {
      name: 'switch',
      syntax: 'keyword',
      description: 'Switch statement',
      insertText: 'switch () {\n  case :\n    break;\n  default:\n}'
    },
    { name: 'case', syntax: 'keyword', description: 'Switch case' },
    { name: 'break', syntax: 'keyword', description: 'Break out of loop/switch' },
    { name: 'continue', syntax: 'keyword', description: 'Continue to next iteration' },
    { name: 'botState', syntax: 'variable', description: 'Shared bot state object' },
    { name: 'Math', syntax: 'variable', description: 'Math object' },
    { name: 'JSON', syntax: 'variable', description: 'JSON object' },
    { name: 'Array', syntax: 'variable', description: 'Array constructor' },
    { name: 'Object', syntax: 'variable', description: 'Object constructor' },
    { name: 'String', syntax: 'variable', description: 'String constructor' },
    { name: 'Number', syntax: 'variable', description: 'Number constructor' },
    { name: 'Date', syntax: 'variable', description: 'Date constructor' },
    {
      name: 'debug',
      syntax: 'function-paren',
      description:
        'Log debug message to console. Can take a second argument for log level ("info", "error", "warning", "success")',
      insertText: 'debug(message)'
    }
  ]

  // Check if cursor is inside an eval block
  function isInsideEvalBlock(text: string, cursorPos: number): boolean {
    const textBefore = text.substring(0, cursorPos)
    const lastEval = textBefore.lastIndexOf('$eval')
    const lastHalt = textBefore.lastIndexOf('$halt')
    return lastEval !== -1 && lastEval > lastHalt
  }

  function handleInput() {
    dispatch('change', value)
    updateHighlighting()
    updateLineNumbers()
    checkAutocomplete()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (autocompleteVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        autocompleteIndex = (autocompleteIndex + 1) % autocompleteItems.length
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        autocompleteIndex =
          (autocompleteIndex - 1 + autocompleteItems.length) % autocompleteItems.length
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertAutocomplete(autocompleteItems[autocompleteIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        autocompleteVisible = false
      }
    } else {
      // Handle Tab for indentation
      if (e.key === 'Tab') {
        e.preventDefault()
        const start = textareaElement.selectionStart
        const end = textareaElement.selectionEnd
        value = value.substring(0, start) + '  ' + value.substring(end)
        tick().then(() => {
          textareaElement.selectionStart = textareaElement.selectionEnd = start + 2
        })
        handleInput()
      }
    }
  }

  function checkAutocomplete() {
    if (readonly) {
      autocompleteVisible = false
      return
    }
    const cursorPos = textareaElement.selectionStart
    const textBeforeCursor = value.substring(0, cursorPos)
    const insideEval = mode === 'js' || isInsideEvalBlock(value, cursorPos)

    // In BCFD mode, check for $ prefix (BCFD variables/functions)
    if (mode === 'bcfd') {
      const lastDollarIndex = textBeforeCursor.lastIndexOf('$')
      const dollarValid =
        lastDollarIndex !== -1 &&
        !/[\s\n\r({|})]/.test(textBeforeCursor.substring(lastDollarIndex + 1))

      if (dollarValid) {
        const textAfterDollar = textBeforeCursor.substring(lastDollarIndex + 1)
        currentWord = textAfterDollar.toLowerCase()
        wordStartIndex = lastDollarIndex + 1
        isJsAutocomplete = false

        // Filter BCFD items
        autocompleteItems = bcfdItems
          .filter((item) => item.name.toLowerCase().startsWith(currentWord))
          .slice(0, 10)

        if (autocompleteItems.length > 0) {
          autocompleteVisible = true
          autocompleteIndex = 0
          updateAutocompletePosition()
          return
        }
      }
    }

    // Check for JS keywords inside eval blocks or in JS mode (no $ prefix needed)
    if (insideEval) {
      // Find the current word being typed
      const wordMatch = textBeforeCursor.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/)
      if (wordMatch) {
        currentWord = wordMatch[1].toLowerCase()
        wordStartIndex = cursorPos - wordMatch[1].length
        isJsAutocomplete = true

        // Filter JS keywords
        autocompleteItems = jsKeywords
          .filter(
            (item) =>
              item.name.toLowerCase().startsWith(currentWord) &&
              item.name.toLowerCase() !== currentWord
          )
          .slice(0, 10)

        if (autocompleteItems.length > 0 && currentWord.length >= 2) {
          autocompleteVisible = true
          autocompleteIndex = 0
          updateAutocompletePosition()
          return
        }
      }
    }

    autocompleteVisible = false
  }

  function updateAutocompletePosition() {
    if (!textareaElement || !containerElement) return

    // Get cursor position relative to textarea
    const cursorPos = textareaElement.selectionStart
    const textBeforeCursor = value.substring(0, cursorPos)
    const lines = textBeforeCursor.split('\n')
    const currentLineIndex = lines.length - 1
    const currentLineText = lines[currentLineIndex]

    // Approximate position (character-based)
    const lineHeight = 24 // Approximate line height
    const charWidth = 9.6 // Approximate character width for monospace

    autocompletePosition = {
      top: (currentLineIndex + 1) * lineHeight + 4,
      left: Math.min(currentLineText.length * charWidth + 48, containerElement.clientWidth - 280) // 48 for line numbers, clamp to container
    }
  }

  function insertAutocomplete(item: AutocompleteItem) {
    const insertText = item.insertText || item.name
    const before = value.substring(0, wordStartIndex)
    const after = value.substring(textareaElement.selectionStart)

    value = before + insertText + after
    autocompleteVisible = false

    tick().then(() => {
      const newPos = wordStartIndex + insertText.length
      textareaElement.selectionStart = textareaElement.selectionEnd = newPos
      textareaElement.focus()
      // Update highlighting and line numbers without triggering autocomplete
      dispatch('change', value)
      updateHighlighting()
      updateLineNumbers()
    })
  }

  function updateHighlighting() {
    if (!highlightElement) return
    if (mode === 'js') {
      // Pure JavaScript mode - use JS highlighting with line breaks
      let html = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      html = highlightJavaScript(html)
      html = html.replace(/\n/g, '<br>')
      if (html.endsWith('<br>')) {
        html += '&nbsp;'
      }
      highlightElement.innerHTML = html
    } else {
      highlightElement.innerHTML = highlightBCFD(value)
    }
  }

  function updateLineNumbers() {
    if (!lineNumbersElement) return
    const lines = value.split('\n').length
    let html = ''
    for (let i = 1; i <= lines; i++) {
      html += `<div class="line-number">${i}</div>`
    }
    lineNumbersElement.innerHTML = html
  }

  function handleClick() {
    checkAutocomplete()
  }

  let scrollAreaElement: HTMLDivElement = $state()

  function syncScroll() {
    if (lineNumbersElement && scrollAreaElement) {
      lineNumbersElement.scrollTop = scrollAreaElement.scrollTop
    }
  }

  onMount(() => {
    updateHighlighting()
    updateLineNumbers()
  })

  // React to external value changes
  $effect(() => {
    if (textareaElement && value !== undefined) {
      tick().then(() => {
        updateHighlighting()
        updateLineNumbers()
      })
    }
  })

  // Calculate dynamic height based on content
  let lineCount = $derived(value.split('\n').length)
  let computedHeight = $derived(Math.max(parseInt(minHeight), lineCount * 24 + 16)) // 24px per line + padding
</script>

<div
  bind:this={containerElement}
  class="code-editor-container relative rounded-lg border border-base-300 bg-base-100"
  style="min-height: {minHeight}; height: {computedHeight}px;"
>
  <!-- Line Numbers -->
  <div
    bind:this={lineNumbersElement}
    class="line-numbers absolute left-0 top-0 bottom-0 w-12 bg-base-200 text-base-content/50 text-right pr-2 pt-2 pb-4 select-none font-mono text-sm leading-6 overflow-hidden"
  >
    <div class="line-number">1</div>
  </div>

  <!-- Scrollable Editor Area -->
  <div
    bind:this={scrollAreaElement}
    class="editor-scroll-area absolute left-12 top-0 right-0 bottom-0 overflow-x-auto overflow-y-hidden"
    onscroll={syncScroll}
  >
    <!-- Inner container that sizes to content -->
    <div class="editor-content relative">
      <!-- Hidden pre element to determine content size -->
      <pre
        class="content-sizer p-2 pb-4 font-mono text-sm leading-6 whitespace-pre invisible"
        aria-hidden="true">{value || ' '}</pre>

      <!-- Syntax Highlighting Layer -->
      <div
        bind:this={highlightElement}
        class="highlight-layer absolute top-0 left-0 right-0 bottom-0 p-2 pb-4 font-mono text-sm leading-6 whitespace-pre pointer-events-none"
      ></div>

      <!-- Textarea (input layer) -->
      <textarea
        bind:this={textareaElement}
        bind:value
        oninput={handleInput}
        onkeydown={handleKeydown}
        onclick={handleClick}
        {placeholder}
        {readonly}
        class="textarea-input absolute top-0 left-0 w-full h-full p-2 pb-4 font-mono text-sm leading-6 bg-transparent text-transparent caret-base-content resize-none outline-none border-none whitespace-pre overflow-hidden"
        class:cursor-default={readonly}
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
      ></textarea>
    </div>
  </div>

  <!-- Autocomplete Dropdown -->
  {#if autocompleteVisible}
    <div
      class="autocomplete-dropdown absolute z-50 bg-base-200 border border-base-300 rounded-lg shadow-lg max-h-64 overflow-y-auto min-w-64"
      style="top: {autocompletePosition.top}px; left: {autocompletePosition.left}px;"
    >
      {#each autocompleteItems as item, i}
        <button
          type="button"
          class="autocomplete-item w-full text-left px-3 py-2 hover:bg-base-300 flex items-center gap-2 cursor-pointer"
          class:bg-base-300={i === autocompleteIndex}
          onclick={() => insertAutocomplete(item)}
          onmouseenter={() => (autocompleteIndex = i)}
        >
          <span
            class="badge badge-sm"
            class:badge-primary={item.syntax === 'variable'}
            class:badge-secondary={item.syntax === 'function-paren' ||
              item.syntax === 'function-brace'}
            class:badge-accent={item.syntax === 'keyword'}
          >
            {#if item.syntax === 'variable'}var{:else if item.syntax === 'keyword'}key{:else}fn{/if}
          </span>
          <span class="font-mono text-sm">{isJsAutocomplete ? '' : '$'}{item.name}</span>
          <span class="text-xs text-base-content/60 ml-auto">{item.description}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .code-editor-container {
    position: relative;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .line-numbers {
    z-index: 1;
  }

  .line-number {
    height: 1.5rem;
    line-height: 1.5rem;
  }

  .editor-scroll-area {
    z-index: 2;
    scrollbar-gutter: stable;
  }

  /* Use overlay scrollbars where supported */
  .editor-scroll-area::-webkit-scrollbar {
    height: 8px;
    width: 8px;
  }

  .editor-scroll-area::-webkit-scrollbar-track {
    background: transparent;
  }

  .editor-scroll-area::-webkit-scrollbar-thumb {
    background: color-mix(in oklch, var(--color-base-content) 30%, transparent);
    border-radius: 4px;
  }

  .editor-scroll-area::-webkit-scrollbar-thumb:hover {
    background: color-mix(in oklch, var(--color-base-content) 50%, transparent);
  }

  .editor-content {
    display: inline-block;
    min-width: 100%;
    min-height: 100%;
    position: relative;
  }

  .content-sizer {
    display: block;
    min-width: max-content;
    margin: 0;
  }

  .highlight-layer {
    z-index: 1;
  }

  .textarea-input {
    z-index: 2;
    word-wrap: normal;
    overflow-wrap: normal;
  }

  .autocomplete-dropdown {
    z-index: 100;
  }

  /* Syntax highlighting colors - DaisyUI v5 color variables */
  :global(.bcfd-variable) {
    color: var(--color-primary);
  }

  :global(.bcfd-function) {
    color: var(--color-secondary);
  }

  :global(.bcfd-args) {
    color: var(--color-accent);
  }

  :global(.bcfd-keyword) {
    color: var(--color-warning);
    font-weight: 600;
  }

  :global(.bcfd-eval) {
    color: color-mix(in oklch, var(--color-base-content) 80%, transparent);
  }

  /* JavaScript syntax highlighting */
  :global(.js-keyword) {
    color: var(--color-primary);
    font-weight: 500;
  }

  :global(.js-string) {
    color: var(--color-success);
  }

  :global(.js-number) {
    color: var(--color-info);
  }

  :global(.js-comment) {
    color: color-mix(in oklch, var(--color-base-content) 50%, transparent);
    font-style: italic;
  }

  :global(.js-builtin) {
    color: var(--color-secondary);
  }
</style>
