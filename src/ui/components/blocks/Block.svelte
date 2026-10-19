<script>
  import TextBlock from './TextBlock.svelte';
  import ReasoningBlock from './ReasoningBlock.svelte';
  import ToolBlock from './ToolBlock.svelte';
  import MediaBlock from './MediaBlock.svelte';
  import ErrorBlock from './ErrorBlock.svelte';
  import UnknownBlock from './UnknownBlock.svelte';
  import DocumentBlock from './DocumentBlock.svelte';
  let { block, streaming = false } = $props();
</script>

{#if block.kind === 'text'}
  <TextBlock {block} {streaming} />
{:else if block.kind === 'textdoc'}
  <DocumentBlock {block} {streaming} />
{:else if block.kind === 'reasoning'}
  <ReasoningBlock {block} {streaming} />
{:else if block.kind === 'tool_call' || block.kind === 'tool_result'}
  <ToolBlock {block} />
{:else if block.kind === 'image' || block.kind === 'file'}
  <MediaBlock {block} />
{:else if block.kind === 'error'}
  <ErrorBlock message={block.message} />
{:else}
  <UnknownBlock block={block.kind === 'unknown' ? block : { contentType: String(block.kind), raw: block }} />
{/if}
