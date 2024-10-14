<script lang="ts">
  import type { BCFDCommand } from '../types/types'
  import { createEventDispatcher } from 'svelte'

  export let mode: 'edit' | 'add' = 'add'
  export let command: BCFDCommand | null = null

  //const TYPE_MESSAGE_RECEIVED = 0
  //const TYPE_PM_RECEIVED = 1
  const TYPE_MEMBER_JOIN = 2
  const TYPE_MEMBER_LEAVE = 3
  const TYPE_MEMBER_BAN = 4

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
        deleteIfStrings: '',
        deleteNum: 0,
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
        isAdmin: false,
        phrase: false,
        privateMessage: '',
        reaction: '',
        roleToAssign: '',
        sendChannelEmbed: false,
        sendPrivateEmbed: false,
        specificChannel: '',
        specificMessage: '',
        requiredRole: '',
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
    if (
      editedCommand.type === TYPE_MEMBER_JOIN ||
      editedCommand.type === TYPE_MEMBER_LEAVE ||
      editedCommand.type === TYPE_MEMBER_BAN
    ) {
      // reset the fields that are not needed for these types
      editedCommand.isRequiredRole = false
      editedCommand.requiredRole = ''
      editedCommand.isAdmin = false
      editedCommand.phrase = false
      editedCommand.isNSFW = false
      editedCommand.deleteAfter = false
      editedCommand.deleteX = false
      editedCommand.deleteNum = 0
      editedCommand.deleteIf = false
      editedCommand.deleteIfStrings = ''
      editedCommand.isReact = false
      editedCommand.reaction = ''
      editedCommand.isKick = false
      editedCommand.isBan = false
      editedCommand.isVoiceMute = false
      editedCommand.command = ''
    }

    dispatch(mode === 'edit' ? 'update' : 'add', editedCommand)
  }
</script>

<div class="p-4">
  <div class="p-4 bg-base-200 rounded-lg">
    <h2 class="text-2xl font-bold mb-4">{mode === 'edit' ? 'Edit' : 'Add'} Command</h2>
    <form on:submit|preventDefault={handleSubmit} class="space-y-4">
      <div class="form-control">
        <label class="label" for="type">
          <span class="label-text">Choose Command Type</span>
        </label>
        <select id="type" bind:value={editedCommand.type} class="select select-bordered" required>
          <option value={0}>Message Received</option>
          <option value={1}>Private Message Received</option>
          <option value={2}>Member Join</option>
          <option value={3}>Member Leave</option>
          <option value={4}>Member Ban</option>
        </select>
      </div>

      {#if editedCommand.type !== TYPE_MEMBER_JOIN && editedCommand.type !== TYPE_MEMBER_LEAVE && editedCommand.type !== TYPE_MEMBER_BAN}
        <div class="form-control">
          <label class="label" for="command">
            <span class="label-text">Command</span>
          </label>
          <input
            type="text"
            id="command"
            bind:value={editedCommand.command}
            class="input input-bordered"
            placeholder="!command"
            required
          />
        </div>
      {/if}

      <div class="form-control">
        <label class="label" for="commandDescription">
          <span class="label-text">Description</span>
        </label>
        <input
          type="text"
          id="commandDescription"
          bind:value={editedCommand.commandDescription}
          class="input input-bordered"
          placeholder="This is a command that does something"
          required
        />
      </div>

      <h3 class="text-xl font-bold mb-2">Action</h3>

      {#if editedCommand.type !== TYPE_MEMBER_JOIN && editedCommand.type !== TYPE_MEMBER_LEAVE && editedCommand.type !== TYPE_MEMBER_BAN}
        <div class="form-control">
          <label class="label" for="phrase">
            <span class="label-text">Phrase (can appear anywhere in the message)</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.phrase} class="checkbox" />
        </div>

        <div class="form-control">
          <label class="label" for="requiresRole">
            <span class="label-text">Requires Role</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.isRequiredRole} class="checkbox" />
        </div>

        {#if editedCommand.isRequiredRole}
          <div class="form-control">
            <label class="label" for="requiredRole">
              <span class="label-text">Required Role</span>
            </label>
            <input
              type="text"
              id="requiredRole"
              bind:value={editedCommand.requiredRole}
              class="input input-bordered"
              placeholder="Role ID"
              required
            />
          </div>
        {/if}

        <div class="form-control">
          <label class="label" for="isAdmin ">
            <span class="label-text">Requires Admin</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.isAdmin} class="checkbox" />
        </div>
      {/if}

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
        <label class="label" for="sendChannelEmbed">
          <span class="label-text">Send Channel Embed</span>
        </label>
        <input
          type="checkbox"
          id="sendChannelEmbed"
          bind:checked={editedCommand.sendChannelEmbed}
          class="checkbox"
        />
      </div>

      {#if editedCommand.sendChannelEmbed}
        <div class="form-control">
          <label class="label" for="channelEmbedTitle">
            <span class="label-text">Channel Embed Title</span>
          </label>

          <textarea
            id="channelEmbedTitle"
            bind:value={editedCommand.channelEmbed.title}
            class="textarea textarea-bordered"
            rows="3"
          ></textarea>
        </div>

        <div class="form-control">
          <label class="label" for="channelEmbedDescription">
            <span class="label-text">Channel Embed Description</span>
          </label>
          <textarea
            id="channelEmbedDescription"
            bind:value={editedCommand.channelEmbed.description}
            class="textarea textarea-bordered"
            rows="3"
          ></textarea>
        </div>

        <div class="form-control">
          <label class="label" for="channelEmbedFooter">
            <span class="label-text">Channel Embed Footer</span>
          </label>
          <textarea
            id="channelEmbedFooter"
            bind:value={editedCommand.channelEmbed.footer}
            class="textarea textarea-bordered"
            rows="3"
          ></textarea>
        </div>

        <div class="form-control">
          <label class="label" for="channelEmbedImage">
            <span class="label-text">Channel Embed Image</span>
          </label>
          <input
            type="text"
            id="channelEmbedImage"
            bind:value={editedCommand.channelEmbed.imageURL}
            class="input input-bordered"
          />
        </div>

        <div class="form-control">
          <label class="label" for="channelEmbedThumbnail">
            <span class="label-text">Channel Embed Thumbnail</span>
          </label>
          <input
            type="text"
            id="channelEmbedThumbnail"
            bind:value={editedCommand.channelEmbed.thumbnailURL}
            class="input input-bordered"
          />
        </div>

        <div class="form-control">
          <label class="label" for="channelEmbedColor">
            <span class="label-text">Channel Embed Color</span>
          </label>
          <input
            type="text"
            id="channelEmbedColor"
            bind:value={editedCommand.channelEmbed.hexColor}
            class="input input-bordered"
          />
        </div>
      {/if}

      <div class="form-control">
        <label class="label" for="isSpecificChannel">
          <span class="label-text">Is Specific Channel</span>
        </label>
        <input type="checkbox" bind:checked={editedCommand.isSpecificChannel} class="checkbox" />
      </div>

      {#if editedCommand.isSpecificChannel}
        <div class="form-control">
          <label class="label" for="specificChannel">
            <span class="label-text">Specific Channel</span>
          </label>
          <input
            type="text"
            id="specificChannel"
            bind:value={editedCommand.specificChannel}
            class="input input-bordered"
          />
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

      <div class="form-control">
        <label class="label" for="sendPrivateEmbed">
          <span class="label-text">Send Private Embed</span>
        </label>
        <input
          type="checkbox"
          id="sendPrivateEmbed"
          bind:checked={editedCommand.sendPrivateEmbed}
          class="checkbox"
        />
      </div>

      {#if editedCommand.sendPrivateEmbed}
        <div class="form-control">
          <label class="label" for="privateEmbedTitle">
            <span class="label-text">Private Embed Title</span>
          </label>
          <textarea
            id="privateEmbedTitle"
            bind:value={editedCommand.privateEmbed.title}
            class="textarea textarea-bordered"
            rows="3"
          ></textarea>
        </div>

        <div class="form-control">
          <label class="label" for="privateEmbedDescription">
            <span class="label-text">Private Embed Description</span>
          </label>
          <textarea
            id="privateEmbedDescription"
            bind:value={editedCommand.privateEmbed.description}
            class="textarea textarea-bordered"
            rows="3"
          ></textarea>
        </div>

        <div class="form-control">
          <label class="label" for="privateEmbedFooter">
            <span class="label-text">Private Embed Footer</span>
          </label>
          <textarea
            id="privateEmbedFooter"
            bind:value={editedCommand.privateEmbed.footer}
            class="textarea textarea-bordered"
            rows="3"
          ></textarea>
        </div>

        <div class="form-control">
          <label class="label" for="privateEmbedImage">
            <span class="label-text">Private Embed Image</span>
          </label>
          <input
            type="text"
            id="privateEmbedImage"
            bind:value={editedCommand.privateEmbed.imageURL}
            class="input input-bordered"
          />
        </div>

        <div class="form-control">
          <label class="label" for="privateEmbedThumbnail">
            <span class="label-text">Private Embed Thumbnail</span>
          </label>
          <input
            type="text"
            id="privateEmbedThumbnail"
            bind:value={editedCommand.privateEmbed.thumbnailURL}
            class="input input-bordered"
          />
        </div>

        <div class="form-control">
          <label class="label" for="privateEmbedColor">
            <span class="label-text">Private Embed Color</span>
          </label>
          <input
            type="text"
            id="privateEmbedColor"
            bind:value={editedCommand.privateEmbed.hexColor}
            class="input input-bordered"
          />
        </div>
      {/if}

      {#if editedCommand.type !== TYPE_MEMBER_JOIN && editedCommand.type !== TYPE_MEMBER_LEAVE && editedCommand.type !== TYPE_MEMBER_BAN}
        <div class="form-control">
          <label class="label" for="isReact">
            <span class="label-text">React To Message</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.isReact} class="checkbox" />
        </div>

        {#if editedCommand.isReact}
          <div class="form-control">
            <label class="label" for="reactToMessage  ">
              <span class="label-text">React To Message</span>
            </label>
            <input
              type="text"
              id="reactToMessage"
              bind:value={editedCommand.reaction}
              class="input input-bordered"
            />
          </div>
        {/if}
      {/if}

      <div class="form-control">
        <label class="label" for="ignoreErrorMessage">
          <span class="label-text">Ignore Error Message</span>
        </label>
        <input type="checkbox" bind:checked={editedCommand.ignoreErrorMessage} class="checkbox" />
      </div>

      {#if editedCommand.type !== TYPE_MEMBER_JOIN && editedCommand.type !== TYPE_MEMBER_LEAVE && editedCommand.type !== TYPE_MEMBER_BAN}
        <div class="form-control">
          <label class="label" for="deleteIf">
            <span class="label-text">Delete If Contains</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.deleteIf} class="checkbox" />
        </div>

        {#if editedCommand.deleteIf}
          <div class="form-control">
            <label class="label" for="deleteIfStrings">
              <span class="label-text">Delete If Contains</span>
            </label>
            <input
              type="text"
              id="deleteIfStrings"
              bind:value={editedCommand.deleteIfStrings}
              class="input input-bordered"
            />
          </div>
        {/if}

        <div class="form-control">
          <label class="label" for="deleteAfter">
            <span class="label-text">Delete After</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.deleteAfter} class="checkbox" />
        </div>

        <div class="form-control">
          <label class="label" for="deleteX">
            <span class="label-text">Delete X Times</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.deleteX} class="checkbox" />
        </div>

        {#if editedCommand.deleteX}
          <div class="form-control">
            <label class="label" for="deleteNum">
              <span class="label-text">Delete X Times</span>
            </label>
            <input
              type="number"
              bind:value={editedCommand.deleteNum}
              class="input input-bordered"
              min="1"
              max="99"
            />
          </div>
        {/if}

        <div class="form-control">
          <label class="label" for="isNSFW">
            <span class="label-text">Is NSFW</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.isNSFW} class="checkbox" />
        </div>
      {/if}

      <h3 class="text-xl font-bold mb-2">Moderation</h3>

      {#if editedCommand.type !== TYPE_MEMBER_JOIN && editedCommand.type !== TYPE_MEMBER_LEAVE && editedCommand.type !== TYPE_MEMBER_BAN}
        <div class="form-control">
          <label class="label" for="isKick">
            <span class="label-text">Kick</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.isKick} class="checkbox" />
        </div>

        <div class="form-control">
          <label class="label" for="isBan">
            <span class="label-text">Ban</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.isBan} class="checkbox" />
        </div>

        <div class="form-control">
          <label class="label" for="isVoiceMute">
            <span class="label-text">Voice Mute</span>
          </label>
          <input type="checkbox" bind:checked={editedCommand.isVoiceMute} class="checkbox" />
        </div>
      {/if}

      <div class="form-control">
        <label class="label" for="isRoleAssigner">
          <span class="label-text">Role Assign</span>
        </label>
        <input type="checkbox" bind:checked={editedCommand.isRoleAssigner} class="checkbox" />
      </div>

      {#if editedCommand.isRoleAssigner}
        <div class="form-control">
          <label class="label" for="roleToAssign">
            <span class="label-text">Role To Assign</span>
          </label>
          <input
            type="text"
            id="roleToAssign"
            bind:value={editedCommand.roleToAssign}
            class="input input-bordered"
          />
        </div>
      {/if}

      <button type="submit" class="btn btn-primary"
        ><span class="material-symbols-outlined">add</span>{mode === 'edit' ? 'Update' : 'Add'} Command</button
      >
    </form>
  </div>
</div>
