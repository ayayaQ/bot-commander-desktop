<script lang="ts">
  import { t } from '../stores/localisation'
  import { sendWebhook } from '../stores/webhooks'
  import HeaderBar from './HeaderBar.svelte'

  let webhookUrl = ''
  let name = ''
  let avatarUrl = ''
  let message = ''

  const webhookUrlRegex = /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/

  function send() {
    if (!webhookUrlRegex.test(webhookUrl)) {
      alert('Invalid webhook URL')
      return
    }

    // use ipc renderer to send webhook to main process
    sendWebhook(webhookUrl, name, avatarUrl, message)
  }
</script>

<HeaderBar>
  <h2 class="text-2xl font-bold">{$t('send-webhook')}</h2>
</HeaderBar>

<div class="p-4">
  <div class="p-4 bg-base-200 rounded-lg shadow-lg">
    <form on:submit|preventDefault={send} class="space-y-4">
      <div class="form-control">
        <label for="webhookUrl" class="label">
          <span class="label-text">{$t('webhook-url')}</span>
        </label>
        <input
          type="text"
          id="webhookUrl"
          bind:value={webhookUrl}
          class="input input-bordered w-full"
          placeholder="https://discord.com/api/webhooks/..."
          required
        />
      </div>

      <div class="form-control">
        <label for="name" class="label">
          <span class="label-text">{$t('name')}</span>
        </label>
        <input
          type="text"
          id="name"
          bind:value={name}
          class="input input-bordered w-full"
          placeholder={$t('bot')}
        />
      </div>

      <div class="form-control">
        <label for="avatarUrl" class="label">
          <span class="label-text">{$t('avatar')}</span>
        </label>
        <input
          type="url"
          id="avatarUrl"
          bind:value={avatarUrl}
          class="input input-bordered w-full"
          placeholder="https://example.com/avatar.png"
        />
      </div>

      <div class="form-control">
        <label for="message" class="label">
          <span class="label-text">{$t('message')}</span>
        </label>
        <textarea
          id="message"
          bind:value={message}
          class="textarea textarea-bordered h-24 w-full"
          placeholder={$t('message-placeholder')}
          required
        ></textarea>
      </div>

      <button type="submit" class="btn btn-primary w-full"
        ><span class="material-symbols-outlined">send</span>{$t('send')}</button
      >
    </form>
  </div>
</div>
