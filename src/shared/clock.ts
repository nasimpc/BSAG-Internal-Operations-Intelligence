export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  readonly #value: Date;

  constructor(value: Date | string) {
    this.#value = value instanceof Date ? new Date(value) : new Date(value);
  }

  now(): Date {
    return new Date(this.#value);
  }
}
