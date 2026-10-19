<script>
  import Message from './Message.svelte';
  /** @type {{ turn: import('../../protocol/types.js').Turn, last?: boolean, running?: boolean, canContinue?: boolean }} */
  let { turn, last = false, running = false, canContinue = false } = $props();
  const lastReply = $derived(turn.replies.at(-1));
</script>

<section class="turn">
  {#if turn.user}
    <Message message={turn.user} branch={turn.userBranch} branchDisabled={running} />
  {/if}
  {#each turn.replies as reply, index (reply.id)}
    <Message
      message={reply}
      branch={index === 0 ? turn.replyBranch : null}
      branchDisabled={running}
      canContinue={canContinue && last && reply === lastReply && reply.status === 'interrupted'}
    />
  {/each}
</section>
