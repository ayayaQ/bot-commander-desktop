<script lang="ts">
  import { onMount } from 'svelte'
  import { botStatusStore, loadBotStatus, saveBotStatus } from '../stores/status'

  let status = $botStatusStore.status
  let activity = $botStatusStore.activity
  let activityDetails = $botStatusStore.activityDetails
  let streamUrl = $botStatusStore.streamUrl

  const statusOptions = ['Online', 'Idle', 'Do Not Disturb', 'Invisible']
  const activityOptions = ['Playing', 'Streaming', 'Listening', 'Watching', 'None', 'Competing']

  function handleActivityChange() {
    if (activity === 'None') {
      activityDetails = ''
      streamUrl = ''
    }
  }

  function handleSubmit(): void {

    console.log({ status, activity, activityDetails, streamUrl })
    // validate stream url
    if (activity === 'Streaming') {
      if (!streamUrl.startsWith('https://www.twitch.tv/')) {
        alert('Please enter a valid Twitch.tv URL')
        return
      }
    }
    saveBotStatus({ status, activity, activityDetails, streamUrl })
  }

  onMount(async () => {
    
    status = $botStatusStore.status
    activity = $botStatusStore.activity
    activityDetails = $botStatusStore.activityDetails
    streamUrl = $botStatusStore.streamUrl
  })
</script>

<div class="form-control w-full max-w-xs">
  <label for="status" class="label">
    <span class="label-text">Status:</span>
  </label>
  <select id="status" class="select select-bordered" bind:value={status}>
    {#each statusOptions as option}
      <option value={option}>{option}</option>
    {/each}
  </select>
</div>
<div class="form-control w-full max-w-xs">
  <label for="activity" class="label">
    <span class="label-text">Activity:</span>
  </label>
  <select
    id="activity"
    class="select select-bordered"
    bind:value={activity}
    on:change={handleActivityChange}
  >
    {#each activityOptions as option}
      <option value={option}>{option}</option>
    {/each}
  </select>
</div>
{#if activity !== 'None'}
  <div class="form-control w-full max-w-xs">
    <label for="activityDetails" class="label">
      <span class="label-text">{activity} Details:</span>
    </label>
    <input
      type="text"
      id="activityDetails"
      class="input input-bordered"
      bind:value={activityDetails}
      placeholder="Enter activity details"
    />
  </div>
  {#if activity === 'Streaming'}
    <div class="form-control w-full max-w-xs">
      <label for="streamUrl" class="label">
        <span class="label-text">Twitch.tv URL:</span>
      </label>
      <input
        type="url"
        id="streamUrl"
        class="input input-bordered"
        bind:value={streamUrl}
        placeholder="https://www.twitch.tv/username"
      />
    </div>
  {/if}
{/if}
<div class="card-actions justify-end mt-4">
  <button class="btn btn-primary" on:click={handleSubmit}>Update Status</button>
</div>
