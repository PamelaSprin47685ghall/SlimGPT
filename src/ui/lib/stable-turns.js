// Keep turn objects that did not change between two selections, so a
// streaming delta re-renders only the turn it touches (Svelte compares props
// by identity; selectTurns builds fresh objects every time).

const sameBranch = (a, b) => a === b || (!!a && !!b && a.index === b.index && a.count === b.count &&
  a.siblingIds.length === b.siblingIds.length && a.siblingIds.every((id, i) => id === b.siblingIds[i]));

function sameTurn(a, b) {
  return a.user === b.user && a.replies.length === b.replies.length && a.replies.every((reply, i) => reply === b.replies[i]) &&
    sameBranch(a.userBranch, b.userBranch) && sameBranch(a.replyBranch, b.replyBranch);
}

const keyOf = (turn, index) => turn.user?.id ?? `lead-${turn.replies[0]?.id ?? index}`;

/**
 * @template T
 * @param {T[]} previous
 * @param {T[]} next
 * @returns {T[]} `next`, with unchanged turns replaced by their previous object
 *   (and `previous` itself when nothing changed at all)
 */
export function stabilizeTurns(previous, next) {
  if (!previous?.length) return next;
  const old = new Map(previous.map((turn, index) => [keyOf(turn, index), turn]));
  let same = previous.length === next.length;
  const out = next.map((turn, index) => {
    const before = old.get(keyOf(turn, index));
    const kept = before && sameTurn(before, turn) ? before : turn;
    if (kept !== previous[index]) same = false;
    return kept;
  });
  return same ? previous : out;
}
