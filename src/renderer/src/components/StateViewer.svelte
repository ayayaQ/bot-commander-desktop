<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { t } from '../stores/localisation'
  import HeaderBar from './HeaderBar.svelte'

  let botState: Record<string, any> = {}
  let editingKey: string | null = null
  let editValue: string = ''
  let showToast = false
  let toastMessage = ''
  let codeToRun = ''
  let codeOutput = ''

  function updateBotState() {
    ;(window as any).electron.ipcRenderer.invoke('getBotState').then((state) => {
      botState = state
    })
  }

  function startEditing(key: string, value: any) {
    editingKey = key
    editValue = JSON.stringify(value)
  }

  function saveEdit() {
    if (editingKey !== null) {
      try {
        const parsedValue = JSON.parse(editValue)
        if (parsedValue) {
          ;(window as any).electron.ipcRenderer
            .invoke('updateBotState', editingKey, parsedValue)
            .then((success) => {
              if (success) {
                updateBotState()
              } else {
                showErrorToast('Failed to update value')
              }
            })
            .catch((error) => {
              showErrorToast(`Error: ${error.message}`)
            })
        } else {
          showErrorToast('Invalid JSON input')
        }
      } catch (error) {
        showErrorToast('Invalid JSON input')
      }
      editingKey = null
    }
  }

  function showErrorToast(message: string) {
    toastMessage = message
    showToast = true
    setTimeout(() => {
      showToast = false
    }, 3000) // Hide toast after 3 seconds
  }

  function runCode() {
    ;(window as any).electron.ipcRenderer
      .invoke('runCodeInContext', codeToRun)
      .then((result) => {
        codeOutput = result
        updateBotState()
      })
      .catch((error) => {
        codeOutput = `Error: ${error.message}`
      })
  }

  function saveStateToDisk() {
    /** We save the state as a json string in a json file and then use the 'a' click trick to download it */
    const jsonString = JSON.stringify(botState)
    const blob = new Blob([jsonString], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bot_state.json'
    a.click()
  }

  function loadStateFromDisk() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        const reader = new FileReader()
        reader.onload = (e) => {
          const jsonString = e.target?.result as string
          try {
            const parsedState = JSON.parse(jsonString)
            if (parsedState) {
              let runningCode = `botState = ${jsonString};`
              ;(window as any).electron.ipcRenderer
                .invoke('runCodeInContext', runningCode)
                .then((_result) => {
                  updateBotState()
                })
                .catch((error) => {
                  showErrorToast(`Error: ${error.message}`)
                })
            }
          } catch (error) {
            showErrorToast('Invalid JSON input')
          }
        }
        reader.readAsText(file)
      }
    }
    input.click()
  }

  let interval: NodeJS.Timeout

  onMount(() => {
    updateBotState()
    interval = setInterval(updateBotState, 1000) // Update every second
  })

  onDestroy(() => {
    clearInterval(interval)
  })

  function autoResize(e: Event) {
    const textarea = e.target as HTMLTextAreaElement
    textarea.style.height = 'auto'
    textarea.style.height = textarea.scrollHeight + 'px'
  }
</script>

<HeaderBar>
  <h2 class="text-2xl font-bold">{$t('bot-state')}</h2>
  <div>
    <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('save')}>
      <button
        type="button"
        class="btn btn-primary"
        on:click={() => {
          saveStateToDisk()
        }}><span class="material-symbols-outlined">download</span></button
      >
    </span>
    <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('import')}>
      <button
        type="button"
        class="btn btn-primary"
        on:click={() => {
          loadStateFromDisk()
        }}><span class="material-symbols-outlined">upload</span></button
      >
    </span>
  </div>
</HeaderBar>

<div class="p-4">
  <div class="bg-base-200 p-4 rounded-lg shadow-lg mb-4">
    <div class="overflow-x-auto">
      <table class="table table-compact w-full">
        <thead>
          <tr>
            <th>{$t('name')}</th>
            <th>{$t('value')}</th>
          </tr>
        </thead>
        <tbody>
          {#each Object.entries(botState) as [key, value]}
            <tr>
              <td class="font-mono">{key}</td>
              <td class="font-mono">
                {#if editingKey === key}
                  <!-- svelte-ignore a11y-autofocus -->
                  <input
                    bind:value={editValue}
                    on:blur={saveEdit}
                    on:keydown={(e) => e.key === 'Enter' && saveEdit()}
                    class="input input-bordered input-sm w-full"
                    autofocus
                  />
                {:else}
                  <span role="button" tabindex="0" on:dblclick={() => startEditing(key, value)}>
                    {JSON.stringify(value)}
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
          {#if Object.keys(botState).length === 0}
            <tr>
              <td colspan="2" class="text-center">{$t('no-state-data')}</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>

  <div class="bg-base-200 p-4 rounded-lg shadow-lg">
    <div class="flex flex-row justify-between items-center">
      <h3 class="text-xl font-bold mb-2">{$t('run-code')}</h3>
      <button class="btn btn-primary mb-2 grow-0" on:click={runCode}
        ><span class="material-symbols-outlined">play_arrow</span>{$t('run')}</button
      >
    </div>

    <div class="mb-2">
      <textarea
        bind:value={codeToRun}
        placeholder={$t('run-code-placeholder')}
        class="textarea textarea-bordered w-full min-h-[2.5rem] resize-none overflow-hidden"
        spellcheck="false"
        on:input={autoResize}
      ></textarea>
    </div>
    {#if codeOutput}
      <div class="flex justify-start gap-2">
        <div class="bg-base-300 p-2 rounded grow">
          <h4 class="font-bold">{$t('output')}:</h4>
          <pre class="whitespace-pre-wrap break-words">{codeOutput}</pre>
        </div>
      </div>
    {/if}
  </div>
</div>

{#if showToast}
  <div class="toast toast-top toast-end">
    <div class="alert alert-error">
      <div>
        <span>{toastMessage}</span>
      </div>
    </div>
  </div>
{/if}
