// Gleitendes Fenster ueber die letzten 60 Sekunden. weav3r und Torn haben
// getrennte Budgets, also bekommt jeder Host seine eigene Instanz.
export class RateLimiter {
  constructor(maxPerMinute, label) {
    this.max = maxPerMinute;
    this.label = label;
    this.calls = [];
  }

  async acquire() {
    for (;;) {
      const cutoff = Date.now() - 60000;
      while (this.calls.length && this.calls[0] < cutoff) this.calls.shift();
      if (this.calls.length < this.max) {
        this.calls.push(Date.now());
        return;
      }
      await new Promise((r) => setTimeout(r, this.calls[0] - cutoff + 50));
    }
  }

  /** Wie viele Requests im laufenden Fenster noch frei sind. */
  remaining() {
    const cutoff = Date.now() - 60000;
    return this.max - this.calls.filter((t) => t >= cutoff).length;
  }
}
