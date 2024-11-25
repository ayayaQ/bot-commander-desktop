<script lang="ts">
  import type { BCFDCommand } from '../types/types'
  import Dialog from './Dialog.svelte'

  export let command: BCFDCommand
  export let editCommand: (command: BCFDCommand) => void
  export let deleteCommand: (command: BCFDCommand) => void

  let dialog: HTMLDialogElement

  function exportCommand() {
    const jsonCommand = JSON.stringify(command, null, 2)
    navigator.clipboard.writeText(jsonCommand)
      .then(() => {
        const toast = document.getElementById('toast') as HTMLDivElement
        toast.classList.remove('hidden')
        setTimeout(() => toast.classList.add('hidden'), 3000)
      })
      .catch(err => console.error('Failed to copy command: ', err))
  }

  const TYPE_MESSAGE_RECEIVED = 0
  const TYPE_PM_RECEIVED = 1
  const TYPE_MEMBER_JOIN = 2
  const TYPE_MEMBER_LEAVE = 3
  const TYPE_MEMBER_BAN = 4
  const TYPE_REACTION = 5

  function displayNameForCommand(command: BCFDCommand) {
    switch (command.type) {
      case TYPE_MESSAGE_RECEIVED: return command.command
      case TYPE_PM_RECEIVED: return command.command
      case TYPE_MEMBER_JOIN: return 'Member Join'
      case TYPE_MEMBER_LEAVE: return 'Member Leave'
      case TYPE_MEMBER_BAN: return 'Member Ban'
      default: return command.command
    }
  }

  function displayIconForCommand(command: BCFDCommand) {
    // icons should be unique from material symbols
    switch (command.type) {
      case TYPE_MESSAGE_RECEIVED: return 'message'
      case TYPE_PM_RECEIVED: return 'chat'
      case TYPE_MEMBER_JOIN: return 'person_add'
      case TYPE_MEMBER_LEAVE: return 'exit_to_app'
      case TYPE_MEMBER_BAN: return 'person_remove'
      case TYPE_REACTION: return 'thumb_up'
      default: return 'message'
    }
  }
</script>

<li class="card bg-base-200 shadow-xl">
  <div class="card-body">
    <div class="flex justify-between items-start">
      <div class="flex items-center justify-center gap-2">
        <div class="flex items-center justify-center"><span class="material-symbols-outlined" style="font-size: 3rem;">{displayIconForCommand(command)}</span></div>
        <div>
        <h3 class="card-title">{displayNameForCommand(command)}</h3>
        <p>{command.commandDescription}</p>
    </div>
      </div>
      <div class="space-x-2">
        <button class="btn btn-square btn-ghost" on:click={() => editCommand(command)}><span class="material-symbols-outlined">edit</span></button>
        <button class="btn btn-square btn-ghost" on:click={exportCommand}><span class="material-symbols-outlined">download</span></button>
        <button class="btn btn-square btn-ghost" on:click={() => dialog.showModal()}><span class="material-symbols-outlined">delete</span></button>

        <Dialog bind:dialog on:close={() => console.log('closed')}>
          <p>Are you sure you want to delete the command "{command.command}"?</p>
          <div class="modal-action">
            <form method="dialog">
              <button class="btn btn-sm btn-error" on:click={() => deleteCommand(command)}
                >Delete</button
              >
              <button class="btn btn-sm btn-ghost">Cancel</button>
            </form>
          </div>
        </Dialog>
      </div>
    </div>
  </div>
</li>

<div id="toast" class="toast toast-bottom toast-end hidden z-50 mb-14">
  <div class="alert alert-success select-none">
    <span>Command exported to clipboard!</span>
  </div>
</div>
