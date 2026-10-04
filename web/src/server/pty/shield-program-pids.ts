/**
 * The pid of the program inside each shielded session (its pane in the shield tmux), which is
 * where Claude's status, chat and pushes look. Read at creation or re-attach only, a pane
 * respawned since (`respawn-pane`) would leave a dead pid there and the notifier would watch
 * nothing for that session; `refresh` reads it again.
 */
export class ShieldProgramPids {
  private pids = new Map<string, number>();
  /** Sessions whose pane gave no live pid: asked again only on a full check. */
  private gone = new Set<string>();
  private refreshes = 0;

  constructor(
    private panePid: (sessionId: string) => Promise<number | null>,
    private isAlive: (pid: number) => boolean,
    /** Every this many refreshes, ask tmux for every pane, live pid or not (pid reuse). */
    private fullCheckEvery = 10
  ) {}

  get(sessionId: string): number | undefined {
    return this.pids.get(sessionId);
  }

  set(sessionId: string, pid: number): void {
    this.pids.set(sessionId, pid);
    this.gone.delete(sessionId);
  }

  /**
   * Re-read the pane pid of each of `sessionIds` (the running shielded sessions) whose stored
   * pid is missing or dead, and of all of them every `fullCheckEvery` calls: one tmux call per
   * session then, none otherwise. Forgets sessions not listed. Answers the pids that changed.
   */
  async refresh(
    sessionIds: string[]
  ): Promise<Array<{ sessionId: string; from?: number; to: number }>> {
    const full = ++this.refreshes % this.fullCheckEvery === 0;
    const listed = new Set(sessionIds);
    for (const sessionId of this.pids.keys())
      if (!listed.has(sessionId)) this.pids.delete(sessionId);
    for (const sessionId of this.gone) if (!listed.has(sessionId)) this.gone.delete(sessionId);

    const changed: Array<{ sessionId: string; from?: number; to: number }> = [];
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        const stored = this.pids.get(sessionId);
        if (!full && (this.gone.has(sessionId) || (stored && this.isAlive(stored)))) return;
        const current = await this.panePid(sessionId);
        if (!current || !this.isAlive(current)) {
          this.gone.add(sessionId);
          return;
        }
        this.gone.delete(sessionId);
        if (current === stored) return;
        this.pids.set(sessionId, current);
        changed.push({ sessionId, from: stored, to: current });
      })
    );
    return changed;
  }
}
