<script lang="ts">
	export let dialog: HTMLDialogElement;
</script>
<dialog bind:this={dialog} on:close class="modal">
    <div class="modal-box">
        <slot/>
    </div>
</dialog>