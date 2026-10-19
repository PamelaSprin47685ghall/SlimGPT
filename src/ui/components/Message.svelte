<script>
  import { getContext } from 'svelte';
  import Block from './blocks/Block.svelte';
  import ErrorBlock from './blocks/ErrorBlock.svelte';
  import BranchSwitcher from './BranchSwitcher.svelte';
  import { copyWithFeedback } from '../lib/clipboard.js';

  /** @type {{ message: import('../../protocol/types.js').Message, branch?: { index: number, count: number } | null, branchDisabled?: boolean, canContinue?: boolean }} */
  let { message, branch = null, branchDisabled = false, canContinue = false } = $props();
  const app = getContext('slimgpt');

  const streaming = $derived(message.status === 'streaming');
  const hasContent = $derived(message.blocks.some((block) => ['text', 'image', 'file'].includes(block.kind)));
  const hasErrorBlock = $derived(message.blocks.some((block) => block.kind === 'error'));
  const showBranch = $derived(!!branch && branch.count > 1);
  const showActions = $derived(showBranch || message.status === 'interrupted' || (hasContent && !streaming && (message.role === 'user' || message.role === 'assistant')));

  function copy(event) {
    let text = '';
    try { text = app.protocol.messageToPlainText(message); } catch { text = ''; }
    void copyWithFeedback(event.currentTarget, text);
  }
</script>

<article class="msg" data-role={message.role} data-status={message.status} data-id={message.id}>
  <div class="msg-body">
    {#each message.blocks as block, index (index)}
      <Block {block} {streaming} />
    {/each}
    {#if streaming && !message.blocks.length}
      <p class="muted pending">正在生成…</p>
    {/if}
    {#if message.status === 'error' && !hasErrorBlock}
      <ErrorBlock message="消息生成失败或被官方界面中断" />
    {/if}
  </div>
  {#if showActions}
    <footer class="msg-actions">
      {#if showBranch}
        <BranchSwitcher {branch} disabled={branchDisabled} onswitch={(delta) => app.dispatch({ type: 'switch-branch', nodeId: message.id, delta })} />
      {/if}
      {#if hasContent && !streaming}
        <button type="button" class="text-btn" onclick={copy}>复制</button>
      {/if}
      {#if message.status === 'interrupted'}
        <span class="muted">回答未完成</span>
        {#if canContinue}
          <button type="button" class="text-btn strong" onclick={() => app.dispatch({ type: 'continue', messageId: message.id })}>继续生成</button>
        {/if}
      {/if}
    </footer>
  {/if}
</article>
