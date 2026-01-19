<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte'
  import { commandRepoStore, type SharedCommandResponse, type SortBy } from '../stores/commandRepository'
  import HeaderBar from './HeaderBar.svelte'
  import { t } from '../stores/localisation'
  import type { BCFDCommand } from '../types/types'
  import CommandOutputPreview from './CommandOutputPreview.svelte'
  import CommandPreviewModal from './CommandPreviewModal.svelte'

  const dispatch = createEventDispatcher<{
    import: BCFDCommand
    close: void
  }>()

  let searchInput = ''
  let searchTimeout: ReturnType<typeof setTimeout> | null = null
  let previewCommand: BCFDCommand | null = null
  let activeTab: 'browse' | 'my-commands' = 'browse'
  let myCommandsPage = 1
  let myCommandsTotalPages = 1

  onMount(async () => {
    await commandRepoStore.ipc.fetchCommands(1, $commandRepoStore.sortBy)
  })

  async function switchTab(tab: 'browse' | 'my-commands') {
    activeTab = tab
    if (tab === 'my-commands') {
      const result = await commandRepoStore.ipc.fetchMyCommands(1)
      if (result.success && result.data) {
        myCommandsPage = result.data.page
        myCommandsTotalPages = result.data.total_pages
      }
    }
  }

  async function handleMyCommandsPageChange(page: number) {
    const result = await commandRepoStore.ipc.fetchMyCommands(page)
    if (result.success && result.data) {
      myCommandsPage = result.data.page
      myCommandsTotalPages = result.data.total_pages
    }
  }

  async function handleDeleteCommand(command: SharedCommandResponse) {
    if (!confirm($t('confirm-delete-shared-command') || `Are you sure you want to delete "${command.command_name}" from the repository?`)) {
      return
    }
    const result = await commandRepoStore.ipc.deleteSharedCommand(command.id)
    if (!result.success) {
      alert($t('delete-command-failed') || 'Failed to delete command: ' + (result.error || 'Unknown error'))
    }
  }

  async function handleSortChange(sort: SortBy) {
    commandRepoStore.setSortBy(sort)
    if ($commandRepoStore.searchQuery) {
      await commandRepoStore.ipc.searchCommands($commandRepoStore.searchQuery, 1)
    } else {
      await commandRepoStore.ipc.fetchCommands(1, sort)
    }
  }

  function handleSearchInput() {
    if (searchTimeout) clearTimeout(searchTimeout)
    searchTimeout = setTimeout(async () => {
      if (searchInput.trim()) {
        await commandRepoStore.ipc.searchCommands(searchInput.trim(), 1)
      } else {
        await commandRepoStore.ipc.fetchCommands(1, $commandRepoStore.sortBy)
      }
    }, 300)
  }

  async function handlePageChange(page: number) {
    if ($commandRepoStore.searchQuery) {
      await commandRepoStore.ipc.searchCommands($commandRepoStore.searchQuery, page)
    } else {
      await commandRepoStore.ipc.fetchCommands(page, $commandRepoStore.sortBy)
    }
  }

  async function handleImport(command: SharedCommandResponse) {
    const result = await commandRepoStore.ipc.importCommand(command.id)
    if (result.success && result.command) {
      dispatch('import', result.command)
    } else {
      alert('Failed to import command: ' + (result.error || 'Unknown error'))
    }
  }

  function formatDate(dateString: string) {
    const date = new Date(dateString)
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }

  function getCommandTypeIcon(type: number) {
    switch (type) {
      case 0: return 'message'
      case 1: return 'chat'
      case 2: return 'person_add'
      case 3: return 'exit_to_app'
      case 4: return 'person_remove'
      case 5: return 'thumb_up'
      default: return 'message'
    }
  }

  function getCommandTypeName(type: number) {
    switch (type) {
      case 0: return 'Message'
      case 1: return 'PM'
      case 2: return 'Join'
      case 3: return 'Leave'
      case 4: return 'Ban'
      case 5: return 'Reaction'
      default: return 'Message'
    }
  }
</script>

<div class="h-full flex flex-col">
  <HeaderBar>
    <div class="basis-full">
      <div class="flex justify-between items-center mb-4">
        <div class="flex items-center gap-2">
          <button class="btn btn-ghost btn-sm" on:click={() => dispatch('close')}>
            <span class="material-symbols-outlined">arrow_back</span>
          </button>
          <h2 class="text-2xl font-bold">{$t('command-repository') || 'Command Repository'}</h2>
        </div>
        {#if activeTab === 'browse'}
          <div class="flex gap-2">
            <div class="join">
              <button
                class="btn btn-sm join-item {$commandRepoStore.sortBy === 'newest' ? 'btn-primary' : 'btn-ghost'}"
                on:click={() => handleSortChange('newest')}
              >
                <span class="material-symbols-outlined text-sm">schedule</span>
                {$t('newest') || 'Newest'}
              </button>
              <button
                class="btn btn-sm join-item {$commandRepoStore.sortBy === 'downloads' ? 'btn-primary' : 'btn-ghost'}"
                on:click={() => handleSortChange('downloads')}
              >
                <span class="material-symbols-outlined text-sm">download</span>
                {$t('most-downloaded') || 'Popular'}
              </button>
            </div>
          </div>
        {/if}
      </div>
      <div class="flex gap-4 mb-4">
        <div role="tablist" class="tabs tabs-boxed">
          <button
            role="tab"
            class="tab {activeTab === 'browse' ? 'tab-active' : ''}"
            on:click={() => switchTab('browse')}
          >
            <span class="material-symbols-outlined text-sm mr-1">explore</span>
            {$t('browse') || 'Browse'}
          </button>
          <button
            role="tab"
            class="tab {activeTab === 'my-commands' ? 'tab-active' : ''}"
            on:click={() => switchTab('my-commands')}
          >
            <span class="material-symbols-outlined text-sm mr-1">folder_shared</span>
            {$t('my-shared-commands') || 'My Commands'}
          </button>
        </div>
      </div>
      {#if activeTab === 'browse'}
        <div class="">
          <label class="input flex items-center gap-2">
            <input
              type="text"
              class="grow"
              placeholder={$t('search-commands') || 'Search commands...'}
              bind:value={searchInput}
              on:input={handleSearchInput}
            />
            <span class="material-symbols-outlined">search</span>
          </label>
        </div>
      {/if}
    </div>
  </HeaderBar>

  <div class="flex-1 overflow-y-auto p-4">
    {#if $commandRepoStore.isLoading}
      <div class="flex justify-center items-center h-32">
        <span class="loading loading-spinner loading-lg"></span>
      </div>
    {:else if $commandRepoStore.error}
      <div class="alert alert-error">
        <span class="material-symbols-outlined">error</span>
        <span>{$commandRepoStore.error}</span>
        <button class="btn btn-sm btn-ghost" on:click={() => commandRepoStore.clearError()}>
          {$t('dismiss') || 'Dismiss'}
        </button>
      </div>
    {:else if activeTab === 'browse'}
      <!-- Browse Tab Content -->
      {#if $commandRepoStore.commands.length === 0}
        <div class="text-center py-8 text-base-content/60">
          <span class="material-symbols-outlined text-6xl mb-4">inventory_2</span>
          <p>{$t('no-commands-in-repository') || 'No commands found in the repository.'}</p>
          {#if $commandRepoStore.searchQuery}
            <p class="mt-2">{$t('try-different-search') || 'Try a different search term.'}</p>
          {/if}
        </div>
      {:else}
        <div class="space-y-3">
          {#each $commandRepoStore.commands as command}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <div class="flex justify-between items-start">
                  <div class="flex items-center gap-3">
                    <div class="flex items-center justify-center">
                      <span class="material-symbols-outlined text-3xl text-primary">
                        {getCommandTypeIcon(command.command_data.type)}
                      </span>
                    </div>
                    <div class="space-y-1">
                      <h3 class="card-title text-lg">{command.command_name}</h3>
                      {#if command.command_description}
                        <p class="text-sm text-base-content/70">{command.command_description}</p>
                      {/if}
                      <div class="flex items-center gap-3 text-xs text-base-content/60">
                        <span class="flex items-center gap-1">
                          <span class="material-symbols-outlined text-sm">person</span>
                          {command.author_username}
                        </span>
                        <span class="flex items-center gap-1">
                          <span class="material-symbols-outlined text-sm">download</span>
                          {command.downloads}
                        </span>
                        <span class="flex items-center gap-1">
                          <span class="material-symbols-outlined text-sm">schedule</span>
                          {formatDate(command.created_at)}
                        </span>
                        <span class="badge badge-ghost badge-sm">
                          {getCommandTypeName(command.command_data.type)}
                        </span>
                      </div>
                      <CommandOutputPreview command={command.command_data} />
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <button
                      class="btn btn-ghost btn-sm"
                      on:click={() => previewCommand = command.command_data}
                    >
                      <span class="material-symbols-outlined text-sm">visibility</span>
                      {$t('preview') || 'Preview'}
                    </button>
                    <button
                      class="btn btn-primary btn-sm"
                      on:click={() => handleImport(command)}
                    >
                      <span class="material-symbols-outlined text-sm">add</span>
                      {$t('import') || 'Import'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          {/each}
        </div>

        <!-- Pagination -->
        {#if $commandRepoStore.totalPages > 1}
          <div class="flex justify-center mt-6">
            <div class="join">
              <button
                class="join-item btn btn-sm"
                disabled={$commandRepoStore.currentPage === 1}
                on:click={() => handlePageChange($commandRepoStore.currentPage - 1)}
              >
                <span class="material-symbols-outlined text-sm">chevron_left</span>
              </button>
              <button class="join-item btn btn-sm btn-disabled">
                {$commandRepoStore.currentPage} / {$commandRepoStore.totalPages}
              </button>
              <button
                class="join-item btn btn-sm"
                disabled={$commandRepoStore.currentPage === $commandRepoStore.totalPages}
                on:click={() => handlePageChange($commandRepoStore.currentPage + 1)}
              >
                <span class="material-symbols-outlined text-sm">chevron_right</span>
              </button>
            </div>
          </div>
        {/if}
      {/if}
    {:else}
      <!-- My Commands Tab Content -->
      {#if $commandRepoStore.myCommands.length === 0}
        <div class="text-center py-8 text-base-content/60">
          <span class="material-symbols-outlined text-6xl mb-4">folder_off</span>
          <p>{$t('no-shared-commands') || 'You haven\'t shared any commands yet.'}</p>
          <p class="mt-2 text-sm">{$t('share-commands-hint') || 'Share commands from the command editor to see them here.'}</p>
        </div>
      {:else}
        <div class="space-y-3">
          {#each $commandRepoStore.myCommands as command}
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <div class="flex justify-between items-start">
                  <div class="flex items-center gap-3">
                    <div class="flex items-center justify-center">
                      <span class="material-symbols-outlined text-3xl text-primary">
                        {getCommandTypeIcon(command.command_data.type)}
                      </span>
                    </div>
                    <div class="space-y-1">
                      <h3 class="card-title text-lg">{command.command_name}</h3>
                      {#if command.command_description}
                        <p class="text-sm text-base-content/70">{command.command_description}</p>
                      {/if}
                      <div class="flex items-center gap-3 text-xs text-base-content/60">
                        <span class="flex items-center gap-1">
                          <span class="material-symbols-outlined text-sm">download</span>
                          {command.downloads} {$t('downloads') || 'downloads'}
                        </span>
                        <span class="flex items-center gap-1">
                          <span class="material-symbols-outlined text-sm">schedule</span>
                          {formatDate(command.created_at)}
                        </span>
                        <span class="badge badge-ghost badge-sm">
                          {getCommandTypeName(command.command_data.type)}
                        </span>
                      </div>
                      <CommandOutputPreview command={command.command_data} />
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <button
                      class="btn btn-ghost btn-sm"
                      on:click={() => previewCommand = command.command_data}
                    >
                      <span class="material-symbols-outlined text-sm">visibility</span>
                      {$t('preview') || 'Preview'}
                    </button>
                    <button
                      class="btn btn-error btn-sm"
                      on:click={() => handleDeleteCommand(command)}
                    >
                      <span class="material-symbols-outlined text-sm">delete</span>
                      {$t('delete') || 'Delete'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          {/each}
        </div>

        <!-- Pagination for My Commands -->
        {#if myCommandsTotalPages > 1}
          <div class="flex justify-center mt-6">
            <div class="join">
              <button
                class="join-item btn btn-sm"
                disabled={myCommandsPage === 1}
                on:click={() => handleMyCommandsPageChange(myCommandsPage - 1)}
              >
                <span class="material-symbols-outlined text-sm">chevron_left</span>
              </button>
              <button class="join-item btn btn-sm btn-disabled">
                {myCommandsPage} / {myCommandsTotalPages}
              </button>
              <button
                class="join-item btn btn-sm"
                disabled={myCommandsPage === myCommandsTotalPages}
                on:click={() => handleMyCommandsPageChange(myCommandsPage + 1)}
              >
                <span class="material-symbols-outlined text-sm">chevron_right</span>
              </button>
            </div>
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</div>

{#if previewCommand}
  <CommandPreviewModal
    command={previewCommand}
    open={true}
    on:close={() => previewCommand = null}
  />
{/if}
