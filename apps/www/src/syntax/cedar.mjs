// TextMate grammar for Cedar policy examples.
// Language syntax: https://docs.cedarpolicy.com/policies/syntax-grammar.html
export default {
  name: "cedar",
  scopeName: "source.cedar",
  patterns: [
    { name: "comment.line.double-slash.cedar", match: "//.*$" },
    {
      name: "string.quoted.double.cedar",
      begin: '"',
      end: '"|$',
      patterns: [{ name: "constant.character.escape.cedar", match: "\\\\." }],
    },
    {
      name: "entity.name.function.decorator.cedar",
      match: "@[A-Za-z_][A-Za-z0-9_]*",
    },
    {
      match: "\\b(is)\\s+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)",
      captures: {
        1: { name: "keyword.operator.word.cedar" },
        2: { name: "entity.name.type.cedar" },
      },
    },
    {
      name: "entity.name.type.cedar",
      match: '\\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*(?=::")',
    },
    {
      name: "keyword.control.cedar",
      match: "\\b(permit|forbid|when|unless|if|then|else)\\b",
    },
    { name: "keyword.operator.word.cedar", match: "\\b(in|has|like)\\b" },
    { name: "constant.language.boolean.cedar", match: "\\b(true|false)\\b" },
    { name: "constant.numeric.cedar", match: "\\b[0-9]+\\b" },
    { name: "variable.parameter.cedar", match: "\\?(principal|resource)\\b" },
    {
      name: "variable.language.cedar",
      match: "(?<!\\.)\\b(principal|action|resource|context)\\b",
    },
    {
      name: "entity.name.function.cedar",
      match: "\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*\\()",
    },
    { name: "keyword.operator.cedar", match: "&&|\\|\\||==|!=|>=|<=|[><+*!-]" },
    { name: "punctuation.separator.namespace.cedar", match: "::" },
  ],
}
