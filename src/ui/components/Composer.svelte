<script>
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

  function resize() {
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  $effect(() => {
    void draft;
    resize();
  });

  function submit(event) {
    event?.preventDefault();
    if (blocked || !draft.trim()) return;
    onsend(draft);
  }

  function onkeydown(event) {
    // Never send while an IME is composing (Chinese input) or on touch keyboards.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229 || coarse) return;
    event.preventDefault();
    submit();
  }
</script>

<form class="composer" onsubmit={submit}>
  {#if error}
    <p class="composer-error" role="alert">
      <span>{error}</span>
      <button type="button" class="icon-btn" aria-label="关闭提示" onclick={ondismiss}>×</button>
    </p>
  {:else if notice && !running}
    <p class="composer-notice">
      <span>{notice}</span>
      {#if offBranch}<button type="button" class="text-btn strong" onclick={onlatest}>回到最新分支</button>{/if}
    </p>
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
      <button type="button" class="btn stop" onclick={onstop}>停止</button>
    {:else}
      <button type="submit" class="btn primary" disabled={blocked || pending || !draft.trim()}>{pending ? '发送中' : '发送'}</button>
    {/if}
  </div>
  {#if efforts.length}
    <label class="effort">
      <span class="muted">思考强度</span>
      <select value={effort} onchange={(event) => oneffort(event.currentTarget.value)}>
        <option value="">默认</option>
        {#each efforts as item (item)}<option value={item}>{EFFORT_LABELS[item] || item}</option>{/each}
      </select>
    </label>
  {/if}
</form>
