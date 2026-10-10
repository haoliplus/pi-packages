import { proveCommandEffect } from "./command-effects";
import { commandWordNodes } from "./nested-execution";
import type { WordReader } from "./node-text";
import type { TSNode } from "./parser";

/**
 * A glob snapshot is useful only when earlier execution cannot change its
 * directory or entries. Keep this proof narrower than general path projection:
 * one reader, successful && reader/cd chains, or reader-only pipelines.
 */
export function supportsGlobSnapshot(node: TSNode, words: WordReader): boolean {
  switch (node.type) {
    case "program": {
      const statements = childrenOf(node).filter(
        (child) => child.isNamed && child.type !== "comment",
      );
      return (
        statements.length === 1 && supportsGlobSnapshot(statements[0], words)
      );
    }
    case "list":
      return childrenOf(node).every(
        (child) => child.type === "&&" || supportsGlobSnapshot(child, words),
      );
    case "pipeline":
      return childrenOf(node).every(
        (child) =>
          child.type === "|" ||
          (child.type === "command" && stableReader(child, words, false)),
      );
    case "command":
      return stableReader(node, words, true);
    default:
      return false;
  }
}

function stableReader(
  node: TSNode,
  words: WordReader,
  allowCd: boolean,
): boolean {
  if (hasExecutionOrWrite(node)) return false;
  const nodes = commandWordNodes(node);
  const values = nodes.map((word) => words.argWord(word));
  const head = values.at(0);
  if (!head || !/^[a-z]+$/.test(head.value) || nodes[0].text !== head.value)
    return false;
  if (head.value === "cd") {
    const target = values.at(1);
    // An explicit ./ or / also avoids inherited CDPATH lookup. Options and
    // dot-dot need shell semantics the existing lexical base cannot prove.
    return (
      allowCd &&
      values.length === 2 &&
      target !== undefined &&
      !target.computed &&
      /^(?:\/|\.\/)[a-zA-Z0-9_./-]*$/.test(target.value) &&
      !target.value.split("/").includes("..")
    );
  }
  return proveCommandEffect(head.value, values.slice(1)).effect === "read";
}

function hasExecutionOrWrite(node: TSNode): boolean {
  if (
    [
      "command_substitution",
      "process_substitution",
      "arithmetic_expansion",
      "simple_expansion",
      "expansion",
      "variable_assignment",
      "file_redirect",
      "heredoc_redirect",
      "herestring_redirect",
    ].includes(node.type)
  )
    return true;
  return childrenOf(node).some(hasExecutionOrWrite);
}

function childrenOf(node: TSNode): TSNode[] {
  const children: TSNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) children.push(child);
  }
  return children;
}
