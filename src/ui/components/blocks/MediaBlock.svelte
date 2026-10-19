<script>
  let { block } = $props();
  const isAudio = $derived(block.kind === 'file' && /^audio\//.test(block.mime || ''));
  const kindLabel = $derived(block.kind === 'image' ? '图片' : isAudio ? '音频' : '文件');
  const detail = $derived.by(() => {
    if (block.kind === 'image') return block.width && block.height ? `${block.width}×${block.height}` : '';
    const size = Number(block.size);
    const sizeText = !Number.isFinite(size) || size <= 0 ? '' : size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`;
    return [block.name, sizeText].filter(Boolean).join(' · ');
  });
</script>

<figure class="media-card" data-kind={block.kind === 'image' ? 'image' : isAudio ? 'audio' : 'file'}>
  <span class="media-icon" aria-hidden="true">{block.kind === 'image' ? '▣' : isAudio ? '♪' : '▤'}</span>
  <figcaption><strong>{kindLabel}</strong>{#if detail}<span class="muted">{` ${detail}`}</span>{/if}</figcaption>
</figure>
