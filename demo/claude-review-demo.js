'use strict';

// DEMO TARGET for the Claude PR-review action. Safe to delete; do NOT merge.
// This intentionally contains a few payments-flavored bugs so you can see what
// the reviewer catches on a real PR. The fqe gate would not catch most of these
// (they are logic, not exit codes) — that is the point of the advisory layer.

function applyPayment(account, amountStr) {
  const amount = parseFloat(amountStr);

  // money compared with floating point + loose equality
  if (account.balance == amount) {
    account.balance = account.balance - amount;
  }

  // no idempotency: calling this twice with the same request double-applies
  account.history.push({ amount, at: Date.now() });

  // swallowed error hides a real failure
  try {
    postToLedger(account.id, amount);
  } catch (e) {}

  return account.balance;
}

module.exports = { applyPayment };
