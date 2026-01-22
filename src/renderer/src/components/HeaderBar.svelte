<script>
  /**
   * @typedef {Object} Props
   * @property {import('svelte').Snippet} [children]
   */

  /** @type {Props} */
  let { children } = $props();
</script>

<div class="p-4 sticky top-0 z-10 bg-base-200 items-center justify-between flex gap-2 shadow-sm">
  {@render children?.()}
</div>
