/**
 * The outcome of a domain operation: its value, or why the domain refused.
 * The core never throws; only adapters throw, for system failures such as a
 * lost database connection.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly isOk: true;
  readonly value: T;
}

export interface Err<E> {
  readonly isOk: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { isOk: true, value };
}

export function err<E>(error: E): Err<E> {
  return { isOk: false, error };
}
