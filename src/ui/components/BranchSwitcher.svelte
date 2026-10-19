<script>
  /** @type {{ branch: { index: number, count: number }, disabled?: boolean, onswitch: (delta: number) => void }} */
  let { branch, disabled = false, onswitch } = $props();
  const hint = $derived(disabled ? '生成中，完成后可切换分支' : '');
</script>

<span class="branch" title={hint}>
  <button type="button" class="icon-btn" aria-label="上一分支" disabled={disabled || branch.index <= 0} onclick={() => onswitch(-1)}>‹</button>
  <span class="branch-pos">{branch.index + 1}/{branch.count}</span>
  <button type="button" class="icon-btn" aria-label="下一分支" disabled={disabled || branch.index >= branch.count - 1} onclick={() => onswitch(1)}>›</button>
</span>
