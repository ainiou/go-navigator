import { Token, TokenKind } from './model';

const KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'
]);

const OPERATORS = new Set([
  ':=', '...', '<-', '==', '!=', '<=', '>=', '&&', '||', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^',
  '<<=', '>>=', '&^='
]);

function isIdentStart(ch: string): boolean {
  return ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isIdentPart(ch: string): boolean {
  if (isIdentStart(ch)) {
    return true;
  }
  if (ch >= '0' && ch <= '9') {
    return true;
  }
  // 简化处理非 ASCII 标识符（Go 支持 Unicode 字母）
  return ch.charCodeAt(0) > 127;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * 将 Go 源码切分为 token 流。注释被丢弃，但保留「token 前是否有换行」信息，
 * 用于还原 Go 的分号插入规则，从而正确切分结构体字段与语句。
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let newline = false;
  const len = src.length;

  const push = (kind: TokenKind, start: number, end: number) => {
    tokens.push({ kind, text: src.slice(start, end), start, end, nl: newline });
    newline = false;
  };

  while (i < len) {
    const ch = src[i];

    if (ch === '\n') {
      newline = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    // 行注释
    if (ch === '/' && src[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < len && src[i] !== '\n') {
        i++;
      }
      // 注释本身不产生 token
      void start;
      continue;
    }

    // 块注释
    if (ch === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          newline = true;
        }
        i++;
      }
      i = Math.min(i + 2, len);
      void start;
      continue;
    }

    // 字符串
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len && src[i] !== '"') {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '\n') {
          break;
        }
        i++;
      }
      i++;
      push('string', start, Math.min(i, len));
      continue;
    }

    // 原始字符串
    if (ch === '`') {
      const start = i;
      i++;
      while (i < len && src[i] !== '`') {
        if (src[i] === '\n') {
          newline = true;
        }
        i++;
      }
      i++;
      push('string', start, Math.min(i, len));
      continue;
    }

    // 字符字面量
    if (ch === '\'') {
      const start = i;
      i++;
      while (i < len && src[i] !== '\'') {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        i++;
      }
      i++;
      push('rune', start, Math.min(i, len));
      continue;
    }

    // 标识符 / 关键字
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentPart(src[i])) {
        i++;
      }
      const text = src.slice(start, i);
      push(KEYWORDS.has(text) ? 'keyword' : 'ident', start, i);
      continue;
    }

    // 数字
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] ?? ''))) {
      const start = i;
      const hex = ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X');
      i++;
      while (i < len) {
        const c = src[i];
        if (isIdentPart(c) || c === '.' || c === '_') {
          // 指数符号：1e-9
          if ((c === 'e' || c === 'E' || c === 'p' || c === 'P') && (src[i + 1] === '+' || src[i + 1] === '-')) {
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        break;
      }
      void hex;
      push('number', start, i);
      continue;
    }

    // 多字符运算符
    const three = src.slice(i, i + 3);
    if (OPERATORS.has(three)) {
      push('operator', i, i + 3);
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPERATORS.has(two)) {
      push('operator', i, i + 2);
      i += 2;
      continue;
    }

    if ('()[]{},;.'.includes(ch)) {
      push('punct', i, i + 1);
      i++;
      continue;
    }

    push('operator', i, i + 1);
    i++;
  }

  return tokens;
}
