<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte'
  import { bcfdItems, type BCFDLanguageItem } from '../../../shared/bcfdLanguage'
  import { lintBCFD, type BCFDLintDiagnostic } from '../../../shared/bcfdLint'
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
  let diagnostics: BCFDLintDiagnostic[] = $state([])
  let warningTooltipVisible = $state(false)
  let warningTooltipPosition = $state({ top: 0, left: 0 })
  let warningTooltipContent = $state('')

  type AutocompleteItem = BCFDLanguageItem

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
    updateDiagnostics()
    updateHighlighting()
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
      updateDiagnostics()
      updateHighlighting()
    })
  }

  function updateDiagnostics() {
    diagnostics = lintBCFD(value, { mode })
  }

  function updateHighlighting() {
    if (!highlightElement) return
    if (mode === 'js') {
      // Pure JavaScript mode - use JS highlighting with line breaks
      let html = highlightJavaScript(value, diagnostics)
      html = html.replace(/\n/g, '<br>')
      if (html.endsWith('<br>')) {
        html += '&nbsp;'
      }
      highlightElement.innerHTML = html
    } else {
      highlightElement.innerHTML = highlightBCFD(value, diagnostics)
    }
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

  function showWarningTooltip(target: EventTarget | null, content: string) {
    if (!(target instanceof HTMLElement)) return

    const rect = target.getBoundingClientRect()
    warningTooltipPosition = {
      top: rect.top - 8,
      left: rect.left + rect.width / 2
    }
    warningTooltipContent = content
    warningTooltipVisible = true
  }

  function hideWarningTooltip() {
    warningTooltipVisible = false
  }

  onMount(() => {
    updateDiagnostics()
    updateHighlighting()
  })

  // React to external value changes
  $effect(() => {
    if (textareaElement && value !== undefined) {
      tick().then(() => {
        updateDiagnostics()
        updateHighlighting()
      })
    }
  })

  // Calculate dynamic height based on content
  let lineCount = $derived(value.split('\n').length)
  let lineNumbers = $derived(Array.from({ length: lineCount }, (_, index) => index + 1))
  let computedHeight = $derived(Math.max(parseInt(minHeight), lineCount * 24 + 40)) // 24px per line + editor padding and footer
  let warningSummary = $derived(diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
  let diagnosticsByLine = $derived(
    (() => {
      const byLine = new Map<number, BCFDLintDiagnostic[]>()
      for (const diagnostic of diagnostics) {
        const line = lineForPosition(value, diagnostic.position)
        const lineDiagnostics = byLine.get(line) ?? []
        lineDiagnostics.push(diagnostic)
        byLine.set(line, lineDiagnostics)
      }
      return byLine
    })()
  )

  function lineForPosition(text: string, position: number): number {
    let line = 1
    for (let index = 0; index < position && index < text.length; index++) {
      if (text[index] === '\n') {
        line++
      }
    }
    return line
  }

  function lineWarningSummary(line: number): string {
    return (diagnosticsByLine.get(line) ?? []).map((diagnostic) => diagnostic.message).join('\n')
  }
</script>

<div
  bind:this={containerElement}
  class="code-editor-container relative rounded-lg border border-base-300 bg-base-100"
  style="min-height: {minHeight}; height: {computedHeight}px;"
>
  <!-- Line Numbers -->
  <div
    bind:this={lineNumbersElement}
    class="line-numbers absolute left-0 top-0 bottom-6 w-12 bg-base-200 text-base-content/50 pr-2 pt-2 pb-4 select-none font-mono text-sm leading-6 overflow-hidden"
  >
    {#each lineNumbers as line}
      <div class="line-number flex items-center justify-end gap-1">
        {#if diagnosticsByLine.has(line)}
          <button
            type="button"
            class="line-warning-marker material-symbols-outlined text-warning cursor-help bg-transparent border-0 p-0 leading-none"
            aria-label={lineWarningSummary(line)}
            onmouseenter={(event) =>
              showWarningTooltip(event.currentTarget, lineWarningSummary(line))}
            onmouseleave={hideWarningTooltip}
            onfocus={(event) => showWarningTooltip(event.currentTarget, lineWarningSummary(line))}
            onblur={hideWarningTooltip}
          >
            warning
          </button>
        {/if}
        <span>{line}</span>
      </div>
    {/each}
  </div>

  <!-- Scrollable Editor Area -->
  <div
    bind:this={scrollAreaElement}
    class="editor-scroll-area absolute left-12 top-0 right-0 bottom-6 overflow-x-auto overflow-y-hidden"
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

  <div
    class="absolute left-0 right-0 bottom-0 h-6 border-t border-base-300 bg-base-200 px-2 flex items-center justify-between gap-2 text-xs text-base-content/60 select-none"
  >
    <div class="min-w-0 truncate">
      {#if diagnostics.length > 0}
        <button
          type="button"
          class="text-warning cursor-help bg-transparent border-0 p-0 text-xs"
          aria-label={warningSummary}
          onmouseenter={(event) => showWarningTooltip(event.currentTarget, warningSummary)}
          onmouseleave={hideWarningTooltip}
          onfocus={(event) => showWarningTooltip(event.currentTarget, warningSummary)}
          onblur={hideWarningTooltip}
        >
          {diagnostics.length}
          {diagnostics.length === 1 ? 'warning' : 'warnings'}
        </button>
      {/if}
    </div>
    <div class="shrink-0">
      {value.length}
      {value.length === 1 ? 'character' : 'characters'}
    </div>
  </div>
</div>

{#if warningTooltipVisible && warningTooltipContent}
  <div
    class="fixed z-[10000] max-w-sm -translate-x-1/2 -translate-y-full rounded bg-warning px-2 py-1 text-xs text-warning-content shadow-lg whitespace-pre-line pointer-events-none"
    style="top: {warningTooltipPosition.top}px; left: {warningTooltipPosition.left}px;"
    role="tooltip"
  >
    {warningTooltipContent}
  </div>
{/if}

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

  .line-warning-marker {
    width: 0.75rem;
    min-width: 0.75rem;
    max-width: 0.75rem;
    height: 0.75rem;
    overflow: hidden;
    font-size: 0.75rem;
    font-variation-settings:
      'FILL' 1,
      'wght' 400,
      'GRAD' 0,
      'opsz' 20;
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

  :global(.bcfd-warning) {
    text-decoration-line: underline;
    text-decoration-style: wavy;
    text-decoration-color: var(--color-warning);
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
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
