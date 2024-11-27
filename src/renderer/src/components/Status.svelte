<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { botStatusStore, saveBotStatus } from '../stores/status'
  import { t } from '../stores/localisation'

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

  let unsubscribe: () => void;

  onMount(async () => {
    unsubscribe = botStatusStore.subscribe((storeStatus) => {
      status = storeStatus.status
      activity = storeStatus.activity
      activityDetails = storeStatus.activityDetails
      streamUrl = storeStatus.streamUrl
    })
  })

  onDestroy(() => {
    unsubscribe()
  })
</script>

<div class="form-control w-full max-w-xs">
  <label for="status" class="label">
    <span class="label-text">{$t('status')}:</span>
  </label>
  <select id="status" class="select select-bordered" bind:value={status}>
    {#each statusOptions as option}
      <option value={option}>{option}</option>
    {/each}
  </select>
</div>
<div class="form-control w-full max-w-xs">
  <label for="activity" class="label">
    <span class="label-text">{$t('activity')}:</span>
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
      <span class="label-text">{$t('status-details')}:</span>
    </label>
    <input
      type="text"
      id="activityDetails"
      class="input input-bordered"
      bind:value={activityDetails}
      placeholder={$t('status-details-placeholder')}
    />
  </div>
  {#if activity === 'Streaming'}
    <div class="form-control w-full max-w-xs">
      <label for="streamUrl" class="label">
        <span class="label-text">{$t('twitch-url')}:</span>
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
  <button class="btn btn-primary" on:click={handleSubmit}>{$t('update-status')}</button>
</div>
