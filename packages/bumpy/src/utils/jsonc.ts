// JSONC parsing adapted from https://github.com/fabiospampinato/tiny-jsonc
const stringOrCommentRe = /("(?:\\?[^])*?")|(\/\/.*)|(\/\*[^]*?\*\/)/g;
const stringOrTrailingCommaRe = /("(?:\\?[^])*?")|(,\s*)(?=]|})/g;

export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(stringOrCommentRe, '$1').replace(stringOrTrailingCommaRe, '$1'));
  }
}
