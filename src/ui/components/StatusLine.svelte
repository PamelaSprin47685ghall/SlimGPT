<script>
  import Subnavbar from 'framework7-svelte/components/subnavbar.svelte';
  import Preloader from 'framework7-svelte/components/preloader.svelte';
  import Button from 'framework7-svelte/components/button.svelte';
  /** @type {{ status: { tone: string, text: string, action?: { label: string, type: string } }, onaction: (type: string) => void }} */
  let { status, onaction } = $props();
</script>

<Subnavbar class="status" data-tone={status.tone}>
  <span class="status-text" role="status">
    {#if status.tone === 'info'}<Preloader size={16} />{/if}
    <span>{status.text}</span>
  </span>
  {#if status.action}
    <Button small onClick={() => onaction(status.action.type)}>{status.action.label}</Button>
  {/if}
</Subnavbar>
