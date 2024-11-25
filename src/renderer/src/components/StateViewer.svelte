<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

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

<div class="p-4">
  <h2 class="text-2xl font-bold mb-4">Bot State</h2>
  <div class="bg-base-200 p-4 rounded-lg shadow-lg mb-4">
    <div class="overflow-x-auto">
      <table class="table table-compact w-full">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {#each Object.entries(botState) as [key, value]}
            <tr>
              <td class="font-mono">{key}</td>
              <td class="font-mono">
                {#if editingKey === key}
                  <input
                    bind:value={editValue}
                    on:blur={saveEdit}
                    on:keydown={(e) => e.key === 'Enter' && saveEdit()}
                    class="input input-bordered input-sm w-full"
                    autofocus
                  />
                {:else}
                  <span on:dblclick={() => startEditing(key, value)}>
                    {JSON.stringify(value)}
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>

  <div class="bg-base-200 p-4 rounded-lg shadow-lg">
    <h3 class="text-xl font-bold mb-2">Run Code</h3>
    <div class="mb-2">
      <textarea
        bind:value={codeToRun}
        placeholder="Enter JavaScript code here..."
        class="textarea textarea-bordered w-full min-h-[2.5rem] resize-none overflow-hidden"
        spellcheck="false"
        on:input={autoResize}
      ></textarea>
    </div>
    <div class='flex justify-start gap-2'>

    <button class="btn btn-primary mb-2 grow-0 " on:click={runCode}><span class="material-symbols-outlined">play_arrow</span>Run</button>
    <div class="bg-base-300 p-2 rounded grow">
      <h4 class="font-bold">Output:</h4>
      <pre class="whitespace-pre-wrap break-words">{codeOutput}</pre>
    </div>
    </div>
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
