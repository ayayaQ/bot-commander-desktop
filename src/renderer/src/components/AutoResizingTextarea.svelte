<script lang="ts">
  import { afterUpdate, onMount } from 'svelte'
  export let value: string = ''
  export let placeholder: string = ''
  export let disabled: boolean = false
  export let spellcheck: boolean = false
  export let className: string = ''
  export let minHeight: string = '2.5rem'
  export let resize: string = 'none'
  export let onInput: ((e: Event) => void) | undefined
  let textareaEl: HTMLTextAreaElement

  function autoResize() {
    if (textareaEl) {
      textareaEl.style.height = 'auto'
      textareaEl.style.height = textareaEl.scrollHeight + 'px'
    }
  }

  function handleInput(e: Event) {
    value = (e.target as HTMLTextAreaElement).value
    autoResize()
    if (onInput) onInput(e)
  }

  onMount(() => {
    autoResize()
  })

  afterUpdate(() => {
    autoResize()
  })
</script>

<textarea
  bind:this={textareaEl}
  bind:value
  {placeholder}
  class={className}
  style="min-height: {minHeight}; resize: {resize}; overflow:hidden;"
  {disabled}
  {spellcheck}
  on:input={handleInput}
></textarea>
