export class ActorDrainingError extends Error {
  constructor() {
    super("Match actor is draining and no longer accepts commands.");
  }
}

export interface ScheduledDeadline<Command> {
  readonly id: string;
  readonly deadlineAt: number;
  readonly command: Command;
}

export class DeadlineScheduler<Command> {
  readonly #dispatch: (command: Command) => Promise<unknown>;
  readonly #now: () => number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    dispatch: (command: Command) => Promise<unknown>,
    now = Date.now,
  ) {
    this.#dispatch = dispatch;
    this.#now = now;
  }

  schedule(deadline: ScheduledDeadline<Command>): void {
    this.cancel(deadline.id);
    const delay = Math.max(0, deadline.deadlineAt - this.#now());
    const timer = setTimeout(
      () => {
        this.#timers.delete(deadline.id);
        void this.#dispatch(deadline.command);
      },
      Math.min(delay, 2_147_483_647),
    );
    timer.unref?.();
    this.#timers.set(deadline.id, timer);
  }

  cancel(id: string): void {
    const timer = this.#timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
  }

  close(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
  }
}

export interface MatchActorOptions<State, Command, Result> {
  readonly initialState: State;
  readonly process: (
    state: Readonly<State>,
    command: Readonly<Command>,
  ) => Promise<{
    readonly state: State;
    readonly result: Result;
  }>;
  readonly saveFinalSnapshot: (state: Readonly<State>) => Promise<void>;
}

/** One in-process actor owns one match; the promise tail is its single command lane. */
export class MatchActor<State, Command, Result> {
  #state: State;
  readonly #process: MatchActorOptions<State, Command, Result>["process"];
  readonly #saveFinalSnapshot: MatchActorOptions<
    State,
    Command,
    Result
  >["saveFinalSnapshot"];
  #tail: Promise<void> = Promise.resolve();
  #draining = false;

  constructor(options: MatchActorOptions<State, Command, Result>) {
    this.#state = options.initialState;
    this.#process = options.process;
    this.#saveFinalSnapshot = options.saveFinalSnapshot;
  }

  get state(): Readonly<State> {
    return this.#state;
  }

  dispatch(command: Command): Promise<Result> {
    if (this.#draining) {
      return Promise.reject(new ActorDrainingError());
    }
    let resolveResult!: (value: Result) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#tail = this.#tail.then(async () => {
      try {
        const processed = await this.#process(this.#state, command);
        this.#state = processed.state;
        resolveResult(processed.result);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  async stop(): Promise<void> {
    this.#draining = true;
    await this.#tail;
    await this.#saveFinalSnapshot(this.#state);
  }
}
