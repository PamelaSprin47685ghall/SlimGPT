<script>
  import Message from './Message.svelte';
  import { displayReplies } from '../lib/visibility.js';
  /** @type {{ turn: import('../../protocol/types.js').Turn, last?: boolean, running?: boolean, branches?: boolean }} */
  let { turn, last = false, running = false, branches = true } = $props();
  const shown = $derived(displayReplies(turn));
</script>

<section class="turn">
  {#if turn.user}
    <Message message={turn.user} branch={branches ? turn.userBranch : null} branchNodeId={turn.user.id} branchDisabled={running} />
  {/if}
  {#each shown.replies as reply, index (reply.id)}
    <Message
      message={reply}
      branch={branches && index === 0 ? turn.replyBranch : null}
      branchNodeId={shown.branchNodeId}
      branchDisabled={running}
    />
  {/each}
  {#if last && shown.searching}
    <p class="muted pending searching">正在搜索网页…</p>
  {/if}
</section>
