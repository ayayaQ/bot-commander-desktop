<script lang="ts">
  import type { BCFDCommand } from '../types/types'
  import { createEventDispatcher } from 'svelte'

  export let mode: 'edit' | 'add' = 'add'
  export let command: BCFDCommand | null = null

  const dispatch = createEventDispatcher()

  let editedCommand: BCFDCommand = command
    ? { ...command }
    : {
        actionArr: [false, false],
        channelMessage: '',
        command: '',
        commandDescription: '',
        deleteAfter: false,
        deleteIf: false,
        commandIfStrings: false,
        commandNum: 0,
        deleteX: false,
        ignoreErrorMessage: false,
        isBan: false,
        isKick: false,
        isNSFW: false,
        isReact: false,
        isRequiredRole: false,
        isRoleAssigner: false,
        isSpecificChannel: false,
        isSpecificMessage: false,
        isVoiceMute: false,
        phrase: '',
        privateMessage: '',
        reaction: '',
        roleToAssign: '',
        sendChannelEmbed: false,
        sendPrivateEmbed: false,
        specificChannel: '',
        specificMessage: '',
        type: 0,
        channelEmbed: {
          title: '',
          description: '',
          hexColor: '',
          imageURL: '',
          thumbnailURL: '',
          footer: ''
        },
        privateEmbed: {
          title: '',
          description: '',
          hexColor: '',
          imageURL: '',
          thumbnailURL: '',
          footer: ''
        }
      }

  function handleSubmit() {
    dispatch(mode === 'edit' ? 'update' : 'add', editedCommand)
  }
</script>

<div class="p-4 bg-base-200 rounded-lg">
  <h2 class="text-2xl font-bold mb-4">{mode === 'edit' ? 'Edit' : 'Add'} Command</h2>
  <form on:submit|preventDefault={handleSubmit} class="space-y-4">
    <div class="form-control">
      <label class="label" for="type">
        <span class="label-text">Type</span>
      </label>
      <select id="type" bind:value={editedCommand.type} class="select select-bordered">
        <option value="0">Message Received</option>
        <option value="1">Private Message Received</option>
        <option value="2">Member Join</option>
        <option value="3">Member Leave</option>
        <option value="4">Member Ban</option>
        <option value="5">Member Add</option>
      </select>
    </div>

    <div class="form-control">  
      <label class="label" for="command">
        <span class="label-text">Command</span>
      </label>
      <input
        type="text"
        id="command"
        bind:value={editedCommand.command}
        class="input input-bordered"
        required
      />
    </div>

    <div class="form-control">
      <label class="label" for="commandDescription">
        <span class="label-text">Description</span>
      </label>
      <input
        type="text"
        id="commandDescription"
        bind:value={editedCommand.commandDescription}
        class="input input-bordered"
        required
      />
    </div>

    <div class="form-control">
      <label class="label" for="phrase">
        <span class="label-text">Phrase</span>
      </label>
      <input
        type="text"
        id="phrase"
        bind:value={editedCommand.phrase}
        class="input input-bordered"
      />
    </div>

    <div class="form-control">
      <label class="label" for="sendMessage">
        <span class="label-text">Send Message</span>
      </label>
      <input
        type="checkbox"
        id="sendMessage"
        bind:checked={editedCommand.actionArr[0]}
        class="checkbox"
      />
    </div>

    {#if editedCommand.actionArr[0]}
      <div class="form-control">
        <label class="label" for="channelMessage">
          <span class="label-text">Channel Message</span>
        </label>
        <textarea
          id="channelMessage"
          bind:value={editedCommand.channelMessage}
          class="textarea textarea-bordered"
          rows="3"
        ></textarea>
      </div>
    {/if}

    <div class="form-control">
      <label class="label" for="sendMessage">
        <span class="label-text">Send Private Message</span>
      </label>
      <input
        type="checkbox"
        id="sendMessage"
        bind:checked={editedCommand.actionArr[1]}
        class="checkbox"
      />
    </div>

    {#if editedCommand.actionArr[1]}
      <div class="form-control">
        <label class="label" for="privateMessage">
          <span class="label-text">Private Message</span>
        </label>
        <textarea
          id="privateMessage"
          bind:value={editedCommand.privateMessage}
          class="textarea textarea-bordered"
          rows="3"
        ></textarea>
      </div>
    {/if}

    <!-- Add more form fields for other properties -->

    <div class="form-control">
      <label class="label cursor-pointer">
        <span class="label-text">Delete After</span>
        <input type="checkbox" bind:checked={editedCommand.deleteAfter} class="checkbox" />
      </label>
    </div>

    <div class="form-control">
      <label class="label cursor-pointer">
        <span class="label-text">Is NSFW</span>
        <input type="checkbox" bind:checked={editedCommand.isNSFW} class="checkbox" />
      </label>
    </div>

    <!-- Add more checkbox inputs for boolean properties -->

    <button type="submit" class="btn btn-primary"
      ><span class="material-symbols-outlined">add</span>{mode === 'edit' ? 'Update' : 'Add'} Command</button
    >
  </form>
</div>
