export interface IClock {
  now(): Date;
}

export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements IClock {
  private currentTime: Date;

  constructor(initialTime: Date | string) {
    this.currentTime = typeof initialTime === 'string' ? new Date(initialTime) : new Date(initialTime.getTime());
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  setNow(newTime: Date | string): void {
    this.currentTime = typeof newTime === 'string' ? new Date(newTime) : new Date(newTime.getTime());
  }
}
