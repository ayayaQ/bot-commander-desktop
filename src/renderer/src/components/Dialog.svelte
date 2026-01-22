<script lang="ts">
  interface Props {
    dialog: HTMLDialogElement;
    onclose?: () => void;
    children?: import('svelte').Snippet;
  }

  let { dialog = $bindable(), onclose, children }: Props = $props();
</script>

<dialog bind:this={dialog} onclose={onclose} class="modal">
  <div class="modal-box">
    {@render children?.()}
  </div>
</dialog>
