// loans.js — watches /loan-interest-rates.

import { getLoanInterestRates } from "../api.js";
import { getKey, setKey } from "../storage.js";
import { loadSettings } from "../settings.js";
import { notify } from "../notifier.js";

const KEY = "loanRatesSnapshot";

export async function runLoanWatcher() {
  const rates = await getLoanInterestRates();
  if (!Array.isArray(rates) || rates.length === 0) return null;
  const settings = await loadSettings();
  const prev = await getKey(KEY, null);
  // Pick representative rate (longest term as a benchmark).
  const sorted = rates.slice().sort((a, b) => (a.term || 0) - (b.term || 0));
  const benchmark = sorted[sorted.length - 1];
  const snapshot = {
    rates: sorted,
    benchmarkTerm: benchmark.term,
    benchmarkRate: benchmark.interestRate ?? benchmark.rate ?? benchmark.annualInterestRate,
    updatedAt: Date.now(),
  };
  await setKey(KEY, snapshot);
  if (prev && prev.benchmarkRate && snapshot.benchmarkRate) {
    const dropBps = (prev.benchmarkRate - snapshot.benchmarkRate) * 10000;
    if (dropBps >= settings.loanRateDropAlertBps) {
      await notify(
        "Loan rates dropped",
        `Benchmark ${snapshot.benchmarkTerm}w: ${(snapshot.benchmarkRate * 100).toFixed(2)}% (was ${(prev.benchmarkRate * 100).toFixed(2)}%). Good time to refinance or expand.`,
        "Loans",
      );
    }
  }
  return snapshot;
}
