import ts from 'typescript';
import { ReviewInput } from '../review-input.js';
import { CheckSpec } from './spec.js';

export type Severity = 'error' | 'warning';

/** A primitive hit before the rule's message template is applied. */
export interface RawFinding {
  node?: ts.Node;
  line?: number;   // 1-based, used when no node is given
  column?: number; // 1-based
  /** Placeholder values for the rule's message/fix templates. */
  values?: Record<string, string | number | undefined>;
  /** Overrides the finding key suffix, e.g. the missing file name. */
  key?: string;
}

export interface CheckContext<S extends CheckSpec = CheckSpec> {
  input: ReviewInput;
  spec: S;
  source: ts.SourceFile;
  lines: string[];
  isTS: boolean;
  isJsx: boolean;
}

export type Primitive<S extends CheckSpec = CheckSpec> = (ctx: CheckContext<S>) => RawFinding[];
