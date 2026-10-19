<script>
  import Link from 'framework7-svelte/components/link.svelte';
  /** @type {{ branch: { index: number, count: number }, disabled?: boolean, onswitch: (delta: number) => void }} */
  let { branch, disabled = false, onswitch } = $props();
  const canPrev = $derived(!disabled && branch.index > 0);
  const canNext = $derived(!disabled && branch.index < branch.count - 1);
</script>

<span class="branch" title={disabled ? '生成中，完成后可切换分支' : ''}>
  <Link iconOnly aria-label="上一分支" class={canPrev ? '' : 'disabled'} onClick={() => canPrev && onswitch(-1)}>‹</Link>
  <span class="branch-pos">{branch.index + 1}/{branch.count}</span>
  <Link iconOnly aria-label="下一分支" class={canNext ? '' : 'disabled'} onClick={() => canNext && onswitch(1)}>›</Link>
</span>
