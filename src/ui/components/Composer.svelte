<script>
  import Button from 'framework7-svelte/components/button.svelte';
  import Link from 'framework7-svelte/components/link.svelte';
  /**
   * @type {{
   *   draft: string, running: boolean, pending: boolean, blocked: boolean, notice: string, offBranch: boolean,
   *   error: string, efforts: string[], effort: string,
   *   onsend: (text: string) => void, onstop: () => void, ondraft: (text: string) => void,
   *   onlatest: () => void, ondismiss: () => void, oneffort: (effort: string) => void,
   * }}
   */
  let { draft, running, pending, blocked, notice, offBranch, error, efforts, effort, onsend, onstop, ondraft, onlatest, ondismiss, oneffort } = $props();
  let area = $state();

  const EFFORT_LABELS = { light: '轻度', standard: '标准', extended: '进阶', heavy: '深度' };
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const canSubmit = $derived(!blocked && !pending && !!draft.trim());

  $effect(() => {
    void draft;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight + 2, Math.round(window.innerHeight * 0.4))}px`; // + borders (border-box)
  });

  function submit() {
    if (canSubmit) onsend(draft);
  }

  function onkeydown(event) {
    // Never send while an IME is composing (Chinese input) or on touch keyboards.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229 || coarse) return;
    event.preventDefault();
    submit();
  }
</script>

<div class="composer">
  {#if error}
    <div class="composer-line is-error" role="alert">
      <span>{error}</span>
      <Link iconOnly aria-label="关闭提示" onClick={ondismiss}>×</Link>
    </div>
  {:else if notice && !running}
    <div class="composer-line">
      <span>{notice}</span>
      {#if offBranch}<Button small onClick={onlatest}>回到最新分支</Button>{/if}
    </div>
  {/if}
  <div class="composer-row">
    <textarea
      bind:this={area}
      rows="1"
      value={draft}
      placeholder="给 ChatGPT 发消息"
      aria-label="消息输入框"
      enterkeyhint={coarse ? 'enter' : 'send'}
      oninput={(event) => ondraft(event.currentTarget.value)}
      {onkeydown}
    ></textarea>
    {#if running}
      <Button fill color="red" class="stop" onClick={onstop}>停止</Button>
    {:else}
      <Button fill class="send {canSubmit ? '' : 'disabled'}" onClick={submit}>{pending ? '发送中' : '发送'}</Button>
    {/if}
  </div>
  {#if efforts.length}
    <label class="effort">
      <span>思考强度</span>
      <select value={effort} onchange={(event) => oneffort(event.currentTarget.value)}>
        <option value="">默认</option>
        {#each efforts as item (item)}<option value={item}>{EFFORT_LABELS[item] || item}</option>{/each}
      </select>
    </label>
  {/if}
</div>
