<script>
  /** @type {{ status: { tone: string, text: string, action?: { label: string, type: string } } | null, onaction: (type: string) => void }} */
  let { status, onaction } = $props();
</script>

{#if status}
  <div class="status" data-tone={status.tone} role="status">
    <span>{status.text}</span>
    {#if status.action}
      <button type="button" class="text-btn strong" onclick={() => onaction(status.action.type)}>{status.action.label}</button>
    {/if}
  </div>
{/if}
