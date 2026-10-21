// Privacy meter: how well a withdrawal hides, judged only from public data (the deposit list
// everyone can read). It shows what an observer can narrow a withdrawal down to.
import { formatEther } from "viem";

export const ROUND = ["0.001", "0.005", "0.01", "0.05", "0.1", "0.5", "1", "5"];

/** Round = at most 3 decimals, which is what the deposit chips offer. */
export const isRound = (wei) => /^\d+(\.\d{1,3})?$/.test(formatEther(wei));

/** How many approved deposits there are of each value (for the deposit chips). */
export function amountCounts(crowd) {
  const m = new Map();
  for (const d of crowd) if (d.approved) m.set(d.value, (m.get(d.value) ?? 0) + 1);
  return m;
}

/**
 * @param crowd    all deposits: { value, block, approved }
 * @param note     the deposit being spent: { deposited, depositBlock }
 * @param amount   withdrawal amount (wei)
 * @param ageSec   seconds since the deposit
 * @returns { level 1..3, label, cover, same, after, tips[] }
 */
export function privacyCheck({ crowd, note, amount, ageSec }) {
  const approved = crowd.filter((d) => d.approved);
  // any approved deposit at least this large could have paid for this withdrawal
  const cover = approved.filter((d) => d.value >= amount).length;
  // a withdrawal that equals a deposit amount points at deposits of exactly that amount
  const same = approved.filter((d) => d.value === amount).length;
  const after = crowd.filter((d) => d.block > note.depositBlock).length;
  const tips = [];
  let level = cover >= 20 ? 3 : cover >= 5 ? 2 : 1;

  if (cover < 5)
    tips.push(`Only ${cover} approved deposit${cover === 1 ? "" : "s"} could have paid for this. Waiting lets more people deposit and grows your crowd.`);
  if (amount === note.deposited && same < 10) {
    level = Math.min(level, same < 3 ? 1 : 2);
    tips.push(
      `You are taking out exactly what you put in (${formatEther(amount)} ETH), and only ${same} deposit${same === 1 ? "" : "s"} used that amount. Withdraw a different round amount, or split it.`,
    );
  }
  if (!isRound(amount)) {
    level = Math.min(level, 2);
    tips.push("Odd amounts are easy to match. Use a round amount and take the rest later.");
  }
  if (ageSec < 3600) {
    level = Math.min(level, 2);
    tips.push(`You deposited ${Math.max(1, Math.round(ageSec / 60))} min ago. A withdrawal right after a deposit is the easiest link to guess: wait hours, not minutes.`);
  }
  if (after < 3)
    tips.push(`Only ${after} deposit${after === 1 ? "" : "s"} came in after yours. The more that follow, the less your deposit stands out.`);
  if (level === 3 && !tips.length) tips.push("Good: a large crowd, a round amount and enough time.");
  return { level, label: ["", "Weak", "Fair", "Good"][level], cover, same, after, tips };
}

export function meterHtml(r) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `
    <div class="meter lv${r.level}">
      <div class="meter-head">
        <b>Privacy: ${r.label}</b>
        <span class="meter-bar"><i></i><i></i><i></i></span>
      </div>
      <div class="meter-nums">
        <span><b>${r.cover}</b> deposits could be the source</span>
        <span><b>${r.after}</b> deposits since yours</span>
      </div>
      <ul>${r.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>`;
}
