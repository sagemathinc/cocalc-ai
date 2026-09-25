// Non-waiting host-local admission. Identities come from authenticated routing,
// never from a caller-supplied search option.
export class SearchAdmission {
  private readonly accounts = new Map<
    string,
    { active: boolean; starts: number; since: number; elapsed: number }
  >();
  private active = 0;

  constructor(private readonly now = Date.now) {}

  acquire(account: string): () => void {
    if (typeof account !== "string" || !account.trim() || account.length > 200)
      throw new Error("Search requires an authenticated principal");
    const now = this.now();
    let state = this.accounts.get(account);
    if (state?.active) throw new Error("Account search is busy; retry shortly");
    if (state && now - state.since >= 60_000) {
      state.starts = 0;
      state.elapsed = 0;
      state.since = now;
    }
    // Count wall time through worker termination, including failed searches.
    // A final admitted request can exceed this budget by one worker timeout.
    if (state && (state.starts >= 150 || state.elapsed >= 12_000))
      throw new Error("Account search rate limit reached; retry later");
    if (this.active >= 3)
      throw new Error("Project host search capacity is busy; retry shortly");
    if (!state) {
      // Never evict live rate limits: reject new identities if the bounded
      // accounting table is full after removing expired inactive entries.
      if (this.accounts.size >= 10_000) {
        for (const [key, value] of this.accounts)
          if (!value.active && now - value.since >= 60_000)
            this.accounts.delete(key);
      }
      if (this.accounts.size >= 10_000)
        throw new Error("Project host search accounting is busy; retry later");
      state = { active: false, starts: 0, since: now, elapsed: 0 };
      this.accounts.set(account, state);
    }
    state.active = true;
    state.starts++;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state!.active = false;
      state!.elapsed += Math.max(0, this.now() - now);
      this.active--;
    };
  }
}

export const searchAdmission = new SearchAdmission();
