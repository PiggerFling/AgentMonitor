import { app } from './app';
import { common } from './common';
import { remote } from './remote';
import { tokens } from './tokens';
import { trace } from './trace';
import { ui } from './ui';

export const en = {
  common,
  ui,
  app,
  trace,
  tokens,
  remote,
};

/** Every locale must provide the same shape as English; plural entries only need `other`. */
type Widen<T> = T extends string ? string
  : T extends { other: string } ? { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string }
    : { [K in keyof T]: Widen<T[K]> };
export type Messages = Widen<typeof en>;
