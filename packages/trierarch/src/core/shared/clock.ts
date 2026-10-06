/** Outbound port: the time now. Tests hold their own clock. */
export interface Clock {
  now(): Date;
}
