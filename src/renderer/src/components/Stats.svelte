<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from '../stores/localisation'

  let stats = {
    userCount: 0,
    messagesSent: 0,
    messagesReceived: 0,
    joinEventsReceived: 0,
    leaveEventsReceived: 0,
    banEventsReceived: 0,
    privateMessagesReceived: 0,
    serverCount: 0,
    commandCount: 0,
    webhooksSent: 0,
    timeSpentInApp: 0
  };

  let displayTimeSpentInApp = 0;
  let updateInterval: NodeJS.Timeout;
  let timeUpdateInterval: NodeJS.Timeout;

  onMount(() => {
    updateStats();
    updateInterval = setInterval(updateStats, 5000); // Update stats every 5 seconds
    timeUpdateInterval = setInterval(updateDisplayTime, 1000); // Update time every second
  });

  onDestroy(() => {
    clearInterval(updateInterval);
    clearInterval(timeUpdateInterval);
  });

  async function updateStats() {
    stats = await (window as any).electron.ipcRenderer.invoke('get-stats');
    displayTimeSpentInApp = stats.timeSpentInApp;
  }

  function updateDisplayTime() {
    displayTimeSpentInApp += 1;
  }

  function formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }
</script>

<div class="p-4">
  <h2 class="text-2xl font-bold mb-4">{$t('stats')}</h2>

  <div class="flex flex-row gap-4 flex-wrap">
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">people</span>
        </div>
        <div class="stat-title">{$t('users')}</div>
        <div class="stat-value">{stats.userCount}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">chat</span>
        </div>
        <div class="stat-title">{$t('messages-sent')}</div>
        <div class="stat-value">{stats.messagesSent}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">chat_bubble</span>
        </div>
        <div class="stat-title">{$t('messages-received')}</div>
        <div class="stat-value">{stats.messagesReceived}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">person_add</span>
        </div>
        <div class="stat-title">{$t('on-join')}</div>
        <div class="stat-value">{stats.joinEventsReceived}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">exit_to_app</span>
        </div>
        <div class="stat-title">{$t('on-leave')}</div>
        <div class="stat-value">{stats.leaveEventsReceived}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">block</span>
        </div>
        <div class="stat-title">{$t('on-ban')}</div>
        <div class="stat-value">{stats.banEventsReceived}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">chat_bubble_outline</span>
        </div>
        <div class="stat-title">{$t('private-messages-received')}</div>
        <div class="stat-value">{stats.privateMessagesReceived}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">dns</span>
        </div>
        <div class="stat-title">{$t('servers')}</div>
        <div class="stat-value">{stats.serverCount}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">auto_fix_high</span>
        </div>
        <div class="stat-title">{$t('commands')}</div>
        <div class="stat-value">{stats.commandCount}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">timer</span>
        </div>
        <div class="stat-title">{$t('time-spent-in-app')}</div>
        <div class="stat-value">{formatTime(displayTimeSpentInApp)}</div>
      </div>
    </div>
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-figure text-primary">
          <span class="material-symbols-outlined" style="font-size: 48px;">webhook</span>
        </div>
        <div class="stat-title">{$t('webhooks-sent')}</div>
        <div class="stat-value">{stats.webhooksSent}</div>
      </div>
    </div>
  </div>
</div>
