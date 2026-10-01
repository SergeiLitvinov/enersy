/** Lightweight declaration index. This is deliberately not a semantic API parser. */
export function declarations(source, language) {
  const patterns = {
    julia: /^(?:function\s+|(?:mutable\s+)?struct\s+|abstract\s+type\s+|@enum\s+|module\s+|const\s+)[^\n]+/,
    go: /^(?:func\s+|type\s+)[^\n]+/,
    rust: /^\s*(?:(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod|type|const|impl)\s+)[^\n]+/,
    typescript: /^(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|interface|type|class|const)|(?:async\s+)?function)\s+[^\n]+/,
    sql: /^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|INDEX|TYPE)|ALTER\s+TABLE)\s+[^\n]+/i
  };
  return source.split('\n').flatMap((line, i) => patterns[language]?.test(line) ? [{ line: i + 1, signature: line.trim() }] : []);
}

export function fence(source, language = '') {
  const ticks = Math.max(3, ...Array.from(source.matchAll(/`+/g), m => m[0].length + 1));
  const marker = '`'.repeat(ticks);
  return `${marker}${language}\n${source.trimEnd()}\n${marker}`;
}
