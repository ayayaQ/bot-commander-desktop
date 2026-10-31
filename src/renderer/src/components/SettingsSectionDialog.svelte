<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    description: string
    icon: string
    children: Snippet
    oncancel?: (event: Event) => void
    onclose?: () => void
  }

  let { title, description, icon, children, oncancel, onclose }: Props = $props()
  const id = $props.id()
  let dialog: HTMLDialogElement = $state()
</script>

<button
  type="button"
  class="flex w-full items-center gap-4 rounded-box border border-base-300 bg-base-200/50 p-4 text-left transition-colors hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
  aria-haspopup="dialog"
  aria-controls={id}
  onclick={() => dialog.showModal()}
>
  <span class="material-symbols-outlined shrink-0 opacity-60" aria-hidden="true">{icon}</span>
  <span class="min-w-0 grow">
    <span class="block font-semibold">{title}</span>
    <span class="mt-1 block text-sm opacity-70">{description}</span>
  </span>
  <span class="material-symbols-outlined shrink-0 opacity-60" aria-hidden="true">chevron_right</span
  >
</button>

<dialog bind:this={dialog} {id} class="modal" aria-labelledby={`${id}-title`} {oncancel} {onclose}>
  <div class="modal-box flex max-h-[85dvh] w-11/12 max-w-4xl flex-col overflow-hidden p-0">
    <header
      class="flex shrink-0 items-center justify-between gap-4 border-b border-base-300 px-6 py-4"
    >
      <h3 id={`${id}-title`} class="text-lg font-bold">{title}</h3>
      <button
        type="button"
        class="btn btn-sm btn-circle btn-ghost"
        aria-label={`Close ${title}`}
        onclick={() => dialog.close()}
      >
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </header>
    <div class="min-h-0 overflow-y-auto px-6 py-4 space-y-4">
      {@render children()}
    </div>
    <footer class="flex shrink-0 justify-end border-t border-base-300 px-6 py-4">
      <button type="button" class="btn" onclick={() => dialog.close()}>Close</button>
    </footer>
  </div>
</dialog>
