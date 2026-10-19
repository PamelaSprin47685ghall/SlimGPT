<script>
  import Markdown from './Markdown.svelte';
  let { block, streaming = false } = $props();
</script>

<Markdown source={block.markdown} citations={block.citations} final={!streaming} />
