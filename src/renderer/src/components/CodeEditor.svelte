<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte'
  import { highlightBCFD } from '../utils/highlight'

  export let value: string = ''
  export let placeholder: string = ''
  export let minHeight: string = '200px'

  const dispatch = createEventDispatcher<{ change: string }>()

  let textareaElement: HTMLTextAreaElement
  let highlightElement: HTMLDivElement
  let lineNumbersElement: HTMLDivElement
  let containerElement: HTMLDivElement
  let autocompleteVisible = false
  let autocompleteItems: AutocompleteItem[] = []
  let autocompleteIndex = 0
  let autocompletePosition = { top: 0, left: 0 }
  let currentWord = ''
  let wordStartIndex = 0
  let isJsAutocomplete = false // Track if we're showing JS keywords (no $ prefix)

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
    { name: 'Date', syntax: 'variable', description: 'Date constructor' }
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
    const cursorPos = textareaElement.selectionStart
    const textBeforeCursor = value.substring(0, cursorPos)
    const insideEval = isInsideEvalBlock(value, cursorPos)

    // Check for $ prefix (BCFD variables/functions)
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

    // Check for JS keywords inside eval blocks (no $ prefix needed)
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
    highlightElement.innerHTML = highlightBCFD(value)
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

  onMount(() => {
    updateHighlighting()
    updateLineNumbers()
  })

  // React to external value changes
  $: if (textareaElement && value !== undefined) {
    tick().then(() => {
      updateHighlighting()
      updateLineNumbers()
    })
  }

  // Calculate dynamic height based on content
  $: lineCount = value.split('\n').length
  $: computedHeight = Math.max(parseInt(minHeight), lineCount * 24 + 16) // 24px per line + padding
</script>

<div
  bind:this={containerElement}
  class="code-editor-container relative rounded-lg border border-base-300 bg-base-100"
  style="min-height: {minHeight}; height: {computedHeight}px;"
>
  <!-- Line Numbers -->
  <div
    bind:this={lineNumbersElement}
    class="line-numbers absolute left-0 top-0 bottom-0 w-12 bg-base-200 text-base-content/50 text-right pr-2 pt-2 select-none font-mono text-sm leading-6"
  >
    <div class="line-number">1</div>
  </div>

  <!-- Syntax Highlighting Layer -->
  <div
    bind:this={highlightElement}
    class="highlight-layer absolute left-12 top-0 right-0 bottom-0 p-2 font-mono text-sm leading-6 whitespace-pre-wrap break-words pointer-events-none"
  ></div>

  <!-- Textarea (input layer) -->
  <textarea
    bind:this={textareaElement}
    bind:value
    on:input={handleInput}
    on:keydown={handleKeydown}
    on:click={handleClick}
    {placeholder}
    class="textarea-input absolute left-12 top-0 right-0 bottom-0 w-[calc(100%-3rem)] h-full p-2 font-mono text-sm leading-6 bg-transparent text-transparent caret-base-content resize-none outline-none border-none overflow-hidden"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
  ></textarea>

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
          on:click={() => insertAutocomplete(item)}
          on:mouseenter={() => (autocompleteIndex = i)}
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

  .highlight-layer {
    z-index: 2;
  }

  .textarea-input {
    z-index: 3;
  }

  .autocomplete-dropdown {
    z-index: 100;
  }

  /* Syntax highlighting colors */
  :global(.bcfd-variable) {
    color: oklch(var(--p));
  }

  :global(.bcfd-function) {
    color: oklch(var(--s));
  }

  :global(.bcfd-args) {
    color: oklch(var(--a));
  }

  :global(.bcfd-keyword) {
    color: oklch(var(--wa));
    font-weight: 600;
  }

  :global(.bcfd-eval) {
    color: oklch(var(--bc) / 0.8);
  }

  /* JavaScript syntax highlighting */
  :global(.js-keyword) {
    color: oklch(var(--p));
    font-weight: 500;
  }

  :global(.js-string) {
    color: oklch(var(--su));
  }

  :global(.js-number) {
    color: oklch(var(--in));
  }

  :global(.js-comment) {
    color: oklch(var(--bc) / 0.5);
    font-style: italic;
  }

  :global(.js-builtin) {
    color: oklch(var(--s));
  }
</style>
