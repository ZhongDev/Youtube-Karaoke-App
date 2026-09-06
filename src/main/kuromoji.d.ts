// Minimal typings for kuromoji 0.1.x (the package ships none). Only what
// rubyService.ts uses.
declare module 'kuromoji' {
  export interface IpadicFeatures {
    surface_form: string;
    /** Katakana; undefined for unknown words. */
    reading?: string;
    pronunciation?: string;
    pos: string;
    pos_detail_1: string;
    basic_form: string;
    word_type: 'KNOWN' | 'UNKNOWN';
  }
  export interface Tokenizer {
    tokenize(text: string): IpadicFeatures[];
  }
  export interface TokenizerBuilder {
    build(cb: (err: Error | null, tokenizer: Tokenizer) => void): void;
  }
  export function builder(options: { dicPath: string }): TokenizerBuilder;
}
