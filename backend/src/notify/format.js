export const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

/** Spec rule 7: "is hafte ₹X lage, Y leads, ek lead ₹Z ki" (+ customers if CRM linked) */
export function moneyLine({ spend, leads, won }) {
  const cpl = leads > 0 ? spend / leads : null;
  let s = `${inr(spend)} lage, ${leads} leads${cpl != null ? `, ek lead ${inr(cpl)} ki` : ''}`;
  if (won != null) s += `, CRM mein ${won} customer bane${won > 0 ? ` (ek customer ${inr(spend / won)} ka)` : ''}`;
  return s;
}

export function weeklyReport({ businessName, spend, leads, won, actions = [] }) {
  const lines = [`*${businessName} — weekly report*`, `Pichle hafte ${moneyLine({ spend, leads, won })}.`];
  if (actions.length) {
    lines.push('', '*Is hafte: 3 kaam*');
    actions.slice(0, 3).forEach((a, i) => lines.push(`${i + 1}. ${a.title}${a.why ? ` — ${a.why}` : ''}`));
  }
  return lines.join('\n');
}
