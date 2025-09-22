<script>
  import { t } from '../stores/localisation'
  import HeaderBar from './HeaderBar.svelte'

  const helpUrl = 'https://ayayaq.com/DiscordBots-Help/'
</script>

<div class="flex flex-col h-full">
  <HeaderBar>
    <h2 class="text-2xl font-bold">{$t('help')}</h2>
  </HeaderBar>

  <div class="help-container flex-1">
    <iframe src={helpUrl} title="Bot Commander Help" width="100%" height="100%" frameborder="0"
    ></iframe>
  </div>
</div>

<style>
  .help-container {
    width: 100%;
    overflow: hidden;
  }
</style>
