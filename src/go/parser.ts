import { tokenize } from './lexer';
import {
  CallSite, DeclRef, FuncDecl, GoFileIndex, ImportSpec, InterfaceMethod,
  LocalVar, MethodSignature, StructField, Token, TypeDecl, TypeRef
} from './model';
import { computeLineStarts, hashText } from './text';

const BUILTIN_TYPES = new Set([
  'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8',
  'uint16', 'uint32', 'uint64', 'uintptr', 'any', 'comparable', 'nil'
]);

/** 这些 token 后面的 `Name {` 属于控制语句，而非复合字面量。 */
const CONTROL_PREV = new Set([
  'if', 'for', 'switch', 'select', 'case', 'else', 'go', 'defer',
  'var', 'const', 'type', 'range', 'chan', 'map', 'func', 'struct', 'interface'
]);

export interface TypeExprResult {
  text: string;
  end: number;
  base?: TypeRef;
}

export function parseGoFile(text: string, path: string): GoFileIndex {
  return new Parser(text, path).parse();
}

class Parser {
  private readonly tokens: Token[];
  private readonly file: GoFileIndex;

  constructor(private readonly src: string, path: string) {
    this.tokens = tokenize(src);
    const sep = path.includes('\\') ? '\\' : '/';
    const dir = path.slice(0, path.lastIndexOf(sep));
    this.file = {
      path,
      dir: dir || path,
      packageName: '',
      imports: [],
      types: [],
      funcs: [],
      methods: [],
      decls: [],
      typeRefs: [],
      calls: [],
      lineStarts: computeLineStarts(src),
      contentHash: hashText(src)
    };
  }

  parse(): GoFileIndex {
    let i = 0;
    while (i < this.tokens.length) {
      const t = this.tokens[i];
      if (t.kind === 'keyword') {
        if (t.text === 'package') {
          const nameTok = this.tokens[i + 1];
          if (nameTok && nameTok.kind === 'ident') {
            this.file.packageName = nameTok.text;
            i += 2;
            continue;
          }
        } else if (t.text === 'import') {
          i = this.parseImport(i + 1);
          continue;
        } else if (t.text === 'type') {
          i = this.parseTypeDecl(i + 1);
          continue;
        } else if (t.text === 'func') {
          i = this.parseFunc(i);
          continue;
        }
      }
      i++;
    }
    return this.file;
  }

  // ------------------------------------------------------------------ 基础工具

  private textBetween(a: number, b: number): string {
    let out = '';
    for (let i = a; i < b && i < this.tokens.length; i++) {
      out += this.tokens[i].text;
    }
    return out;
  }

  private findMatching(i: number): number {
    const open = this.tokens[i]?.text;
    if (!open) {
      return i;
    }
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 0;
    for (let j = i; j < this.tokens.length; j++) {
      const text = this.tokens[j].text;
      if (text === open) {
        depth++;
      } else if (text === close) {
        depth--;
        if (depth === 0) {
          return j;
        }
      }
    }
    return this.tokens.length - 1;
  }

  private isTypeStart(tok: Token | undefined): boolean {
    if (!tok) {
      return false;
    }
    if (tok.kind === 'ident') {
      return true;
    }
    return ['*', '[', 'map', 'chan', 'func', 'interface', 'struct', '(', '<-', '...', '~'].includes(tok.text);
  }

  private pushTypeRef(name: string, qualifier: string | undefined, start: number, end: number, text: string): void {
    if (!qualifier && BUILTIN_TYPES.has(name)) {
      return;
    }
    this.file.typeRefs.push({ name, qualifier, start, end, text });
  }

  // ------------------------------------------------------------ 类型表达式解析

  private readTypeExpr(i: number): TypeExprResult {
    const tok = this.tokens[i];
    if (!tok) {
      return { text: '', end: i };
    }
    const text = tok.text;

    if (text === '*' || text === '...' || text === '~') {
      const inner = this.readTypeExpr(i + 1);
      return {
        text: text + inner.text,
        end: inner.end,
        base: inner.base ? { ...inner.base, text: text + inner.text } : undefined
      };
    }

    if (text === '[') {
      const close = this.findMatching(i);
      const elem = this.readTypeExpr(close + 1);
      return { text: this.textBetween(i, close + 1) + elem.text, end: elem.end };
    }

    if (text === 'map') {
      if (this.tokens[i + 1]?.text === '[') {
        const close = this.findMatching(i + 1);
        const key = this.readTypeExpr(i + 2);
        const val = this.readTypeExpr(close + 1);
        return { text: 'map[' + key.text + ']' + val.text, end: val.end };
      }
      return { text: 'map', end: i + 1 };
    }

    if (text === 'chan') {
      if (this.tokens[i + 1]?.text === '<-') {
        const inner = this.readTypeExpr(i + 2);
        return { text: 'chan<-' + inner.text, end: inner.end };
      }
      const inner = this.readTypeExpr(i + 1);
      return { text: 'chan ' + inner.text, end: inner.end };
    }

    if (text === '<-') {
      if (this.tokens[i + 1]?.text === 'chan') {
        const inner = this.readTypeExpr(i + 2);
        return { text: '<-chan ' + inner.text, end: inner.end };
      }
      return { text: '<-', end: i + 1 };
    }

    if (text === 'func') {
      if (this.tokens[i + 1]?.text === '(') {
        const sig = this.readSignature(i + 1);
        return { text: 'func' + sig.text, end: sig.end };
      }
      return { text: 'func', end: i + 1 };
    }

    if (text === 'interface' || text === 'struct') {
      if (this.tokens[i + 1]?.text === '{') {
        const close = this.findMatching(i + 1);
        return { text: text + this.textBetween(i + 1, close + 1), end: close + 1 };
      }
      return { text, end: i + 1 };
    }

    if (text === '(') {
      const close = this.findMatching(i);
      return { text: '(' + this.textBetween(i + 1, close) + ')', end: close + 1 };
    }

    if (tok.kind === 'ident') {
      let j = i + 1;
      let qualifier: string | undefined;
      let nameTok = tok;
      if (this.tokens[j]?.text === '.' && this.tokens[j + 1]?.kind === 'ident') {
        qualifier = tok.text;
        nameTok = this.tokens[j + 1];
        j += 2;
      }
      let typeText = qualifier ? qualifier + '.' + nameTok.text : nameTok.text;
      const base: TypeRef = {
        name: nameTok.text,
        qualifier,
        start: nameTok.start,
        end: nameTok.end,
        text: typeText
      };
      if (this.tokens[j]?.text === '[') {
        const close = this.findMatching(j);
        let k = j + 1;
        while (k < close) {
          if (this.tokens[k].text === ',') {
            k++;
            continue;
          }
          const arg = this.readTypeExpr(k);
          if (arg.end <= k) {
            k++;
          } else {
            k = arg.end;
          }
        }
        typeText += this.textBetween(j, close + 1);
        j = close + 1;
      }
      base.text = typeText;
      this.pushTypeRef(base.name, base.qualifier, base.start, base.end, base.text);
      return { text: typeText, end: j, base };
    }

    return { text, end: i + 1 };
  }

  /** 从 '(' 开始解析参数列表，返回与 types 等长的 names（无名参数为 ''）。 */
  private readParamList(i: number): { types: string[]; names: string[]; end: number } {
    const close = this.findMatching(i);
    const types: string[] = [];
    const names: string[] = [];
    let j = i + 1;

    while (j < close) {
      const tok = this.tokens[j];
      if (tok.text === ',' || tok.text === ';') {
        j++;
        continue;
      }

      if (tok.kind === 'ident') {
        // 非具名的包限定类型：pkg.Type（不能按「名字列表 + 类型」解析）
        if (this.tokens[j + 1]?.text === '.') {
          const qualified = this.readTypeExpr(j);
          names.push('');
          types.push(qualified.text);
          j = qualified.end;
          continue;
        }
        const candidates = [tok.text];
        let k = j + 1;
        while (this.tokens[k]?.text === ',' && this.tokens[k + 1]?.kind === 'ident') {
          candidates.push(this.tokens[k + 1].text);
          k += 2;
        }
        if (k < close && this.isTypeStart(this.tokens[k])) {
          const typeExpr = this.readTypeExpr(k);
          for (const candidate of candidates) {
            names.push(candidate);
            types.push(typeExpr.text);
          }
          j = typeExpr.end;
        } else {
          for (const candidate of candidates) {
            names.push('');
            types.push(candidate);
          }
          j = k;
        }
      } else {
        const typeExpr = this.readTypeExpr(j);
        if (typeExpr.end <= j) {
          j++;
          continue;
        }
        names.push('');
        types.push(typeExpr.text);
        j = typeExpr.end;
      }
    }

    return { types, names, end: close + 1 };
  }

  private readSignature(i: number): { sig: MethodSignature; text: string; end: number } {
    const params = this.readParamList(i);
    let j = params.end;
    const resultTypes: string[] = [];
    let resultText = '';

    if (this.tokens[j]?.text === '(') {
      const results = this.readParamList(j);
      resultTypes.push(...results.types);
      resultText = '(' + results.types.join(', ') + ')';
      j = results.end;
    } else if (this.isTypeStart(this.tokens[j])) {
      const result = this.readTypeExpr(j);
      resultTypes.push(result.text);
      resultText = ' ' + result.text;
      j = result.end;
    }

    const sig: MethodSignature = {
      paramTypes: params.types,
      paramNames: params.names,
      resultTypes,
      variadic: params.types.some(t => t.startsWith('...')),
      text: '(' + params.types.join(', ') + ')' + resultText
    };
    return { sig, text: sig.text, end: j };
  }

  // ------------------------------------------------------------------ import

  private parseImport(i: number): number {
    if (this.tokens[i]?.text === '(') {
      const close = this.findMatching(i);
      let j = i + 1;
      while (j < close) {
        if (this.tokens[j].text === ';') {
          j++;
          continue;
        }
        const next = this.parseImportSpec(j);
        j = next > j ? next : j + 1;
      }
      return close + 1;
    }
    return this.parseImportSpec(i);
  }

  private parseImportSpec(i: number): number {
    let j = i;
    let alias: string | undefined;
    const tok = this.tokens[j];
    if (tok && (tok.kind === 'ident' || tok.text === '.' || tok.text === '_')) {
      alias = tok.text;
      j++;
    }
    const pathTok = this.tokens[j];
    if (pathTok && pathTok.kind === 'string') {
      const importPath = pathTok.text.slice(1, -1);
      const spec: ImportSpec = { alias, path: importPath };
      this.file.imports.push(spec);
      return j + 1;
    }
    return j + 1;
  }

  // ------------------------------------------------------------------ type

  private parseTypeDecl(i: number): number {
    if (this.tokens[i]?.text === '(') {
      const close = this.findMatching(i);
      let j = i + 1;
      while (j < close) {
        if (this.tokens[j].text === ';') {
          j++;
          continue;
        }
        const next = this.parseTypeSpec(j);
        j = next > j ? next : j + 1;
      }
      return close + 1;
    }
    return this.parseTypeSpec(i);
  }

  private parseTypeSpec(i: number): number {
    const nameTok = this.tokens[i];
    if (!nameTok || nameTok.kind !== 'ident') {
      return i + 1;
    }

    const decl: TypeDecl = {
      name: nameTok.text,
      nameStart: nameTok.start,
      nameEnd: nameTok.end,
      kind: 'other',
      declStart: nameTok.start,
      declEnd: nameTok.end,
      isAlias: false,
      typeParams: []
    };

    let j = i + 1;
    if (this.tokens[j]?.text === '[') {
      const close = this.findMatching(j);
      for (let k = j + 1; k < close; k++) {
        if (this.tokens[k].kind === 'ident' && (k === j + 1 || this.tokens[k - 1].text === ',')) {
          decl.typeParams.push(this.tokens[k].text);
        }
      }
      j = close + 1;
    }

    if (this.tokens[j]?.text === '=') {
      decl.isAlias = true;
      j++;
    }

    if (this.tokens[j]?.text === 'interface' && this.tokens[j + 1]?.text === '{') {
      decl.kind = 'interface';
      const body = this.parseInterfaceBody(j + 1);
      decl.interfaceMethods = body.methods;
      decl.embeddedTypes = body.embedded;
      decl.typeTerms = body.terms;
      decl.declEnd = this.tokens[body.close]?.end ?? decl.declEnd;
      j = body.close + 1;
    } else if (this.tokens[j]?.text === 'struct' && this.tokens[j + 1]?.text === '{') {
      decl.kind = 'struct';
      const body = this.parseStructBody(j + 1);
      decl.structFields = body.fields;
      decl.declEnd = this.tokens[body.close]?.end ?? decl.declEnd;
      j = body.close + 1;
    } else {
      const typeExpr = this.readTypeExpr(j);
      decl.aliasTarget = typeExpr.base;
      decl.declEnd = this.tokens[Math.max(typeExpr.end - 1, j)]?.end ?? decl.declEnd;
      j = Math.max(typeExpr.end, j + 1);
      if (decl.isAlias) {
        decl.kind = 'alias';
      }
    }

    this.file.types.push(decl);
    this.file.decls.push({
      name: decl.name,
      start: decl.nameStart,
      end: decl.nameEnd,
      kind: 'type'
    });

    if (decl.kind === 'interface') {
      for (const method of decl.interfaceMethods ?? []) {
        this.file.decls.push({
          name: method.name,
          start: method.nameStart,
          end: method.nameEnd,
          kind: 'ifaceMethod',
          ownerType: decl.name
        });
      }
    }

    return j;
  }

  private parseInterfaceBody(i: number): {
    methods: InterfaceMethod[];
    embedded: TypeRef[];
    terms: TypeRef[];
    close: number;
  } {
    const close = this.findMatching(i);
    const methods: InterfaceMethod[] = [];
    const embedded: TypeRef[] = [];
    const terms: TypeRef[] = [];
    let j = i + 1;

    while (j < close) {
      const tok = this.tokens[j];
      if (tok.text === ';') {
        j++;
        continue;
      }

      if (tok.text === '~') {
        const term = this.readTypeExpr(j);
        if (term.base) {
          terms.push(term.base);
        }
        j = term.end;
        while (this.tokens[j]?.text === '|') {
          const next = this.readTypeExpr(j + 1);
          if (next.base) {
            terms.push(next.base);
          }
          j = next.end;
        }
        continue;
      }

      if (tok.kind === 'ident' && this.tokens[j + 1]?.text === '(') {
        const sig = this.readSignature(j + 1);
        methods.push({
          name: tok.text,
          nameStart: tok.start,
          nameEnd: tok.end,
          signature: sig.sig,
          start: tok.start,
          end: this.tokens[Math.max(sig.end - 1, j + 1)]?.end ?? tok.end
        });
        j = sig.end;
        continue;
      }

      const typeExpr = this.readTypeExpr(j);
      if (typeExpr.end <= j) {
        j++;
        continue;
      }
      j = typeExpr.end;
      if (this.tokens[j]?.text === '|') {
        if (typeExpr.base) {
          terms.push(typeExpr.base);
        }
        while (this.tokens[j]?.text === '|') {
          const next = this.readTypeExpr(j + 1);
          if (next.base) {
            terms.push(next.base);
          }
          j = next.end;
        }
      } else if (typeExpr.base) {
        embedded.push(typeExpr.base);
      }
    }

    return { methods, embedded, terms, close };
  }

  private parseStructBody(i: number): { fields: StructField[]; close: number } {
    const close = this.findMatching(i);
    const fields: StructField[] = [];
    let j = i + 1;

    while (j < close) {
      if (this.tokens[j].text === ';') {
        j++;
        continue;
      }
      const start = j;
      let depth = 0;
      while (j < close) {
        const t = this.tokens[j];
        if (depth === 0 && j > start && t.nl) {
          break;
        }
        if (depth === 0 && t.text === ';') {
          break;
        }
        if (t.text === '(' || t.text === '[' || t.text === '{') {
          depth++;
        } else if (t.text === ')' || t.text === ']' || t.text === '}') {
          depth--;
        }
        j++;
      }
      this.parseStructField(start, j, fields);
      if (this.tokens[j]?.text === ';') {
        j++;
      }
    }

    return { fields, close };
  }

  private parseStructField(start: number, end: number, fields: StructField[]): void {
    if (start >= end) {
      return;
    }
    const first = this.tokens[start];
    let typeStartIdx = start;
    let names: string[] = [];

    if (first.kind === 'ident') {
      const candidates = [first.text];
      let k = start + 1;
      while (k < end && this.tokens[k].text === ',' && this.tokens[k + 1]?.kind === 'ident') {
        candidates.push(this.tokens[k + 1].text);
        k += 2;
      }
      if (k < end && this.isTypeStart(this.tokens[k])) {
        if (this.tokens[k].text === '[') {
          const bracketClose = this.findMatching(k);
          const nextInField = this.tokens[bracketClose + 1];
          if (bracketClose + 1 >= end || nextInField?.kind === 'string') {
            // 内嵌泛型类型 Base[T]（后面没有字段类型）
            typeStartIdx = start;
          } else {
            names = candidates;
            typeStartIdx = k;
          }
        } else {
          names = candidates;
          typeStartIdx = k;
        }
      } else if (k >= end) {
        // 单个内嵌类型
        typeStartIdx = start;
      }
    }

    const typeExpr = this.readTypeExpr(typeStartIdx);
    fields.push({
      names,
      typeText: typeExpr.text,
      typeRef: typeExpr.base,
      start: first.start,
      end: this.tokens[Math.max(typeExpr.end - 1, typeStartIdx)]?.end ?? first.end
    });
  }

  // ------------------------------------------------------------------ func

  private parseFunc(funcIdx: number): number {
    let i = funcIdx + 1;
    let recvName: string | undefined;
    let recvTypeText: string | undefined;

    if (this.tokens[i]?.text === '(') {
      const recv = this.readParamList(i);
      recvTypeText = recv.types[0];
      recvName = recv.names[0] || undefined;
      i = recv.end;
    }

    const nameTok = this.tokens[i];
    if (!nameTok || nameTok.kind !== 'ident') {
      return i + 1;
    }
    i++;
    if (this.tokens[i]?.text === '[') {
      i = this.findMatching(i) + 1;
    }
    if (this.tokens[i]?.text !== '(') {
      return i;
    }

    const sig = this.readSignature(i);
    i = sig.end;

    const locals: LocalVar[] = [];
    if (recvName && recvTypeText) {
      locals.push({ names: [recvName], typeText: recvTypeText });
    }
    for (let k = 0; k < sig.sig.paramNames.length; k++) {
      const name = sig.sig.paramNames[k];
      const typeText = sig.sig.paramTypes[k];
      if (name && name !== '_' && typeText) {
        locals.push({ names: [name], typeText });
      }
    }

    const calls: CallSite[] = [];
    let declEnd = nameTok.end;
    if (this.tokens[i]?.text === '{') {
      i = this.scanBody(i, locals, calls);
      declEnd = this.tokens[i - 1]?.end ?? nameTok.end;
    }

    const decl: FuncDecl = {
      name: nameTok.text,
      nameStart: nameTok.start,
      nameEnd: nameTok.end,
      recvName,
      recvTypeText,
      signature: sig.sig,
      declStart: this.tokens[funcIdx]?.start ?? nameTok.start,
      declEnd,
      locals,
      calls
    };

    const kind: DeclRef['kind'] = recvTypeText ? 'method' : 'func';
    if (recvTypeText) {
      this.file.methods.push(decl);
    } else {
      this.file.funcs.push(decl);
    }
    this.file.calls.push(...calls);
    this.file.decls.push({
      name: decl.name,
      start: decl.nameStart,
      end: decl.nameEnd,
      kind,
      ownerType: recvTypeText ? baseNameOfType(recvTypeText) : undefined
    });

    return i;
  }

  // ------------------------------------------------------------------ 函数体扫描

  private scanBody(startBrace: number, locals: LocalVar[], calls: CallSite[]): number {
    let i = startBrace + 1;
    let depth = 0;
    const tokens = this.tokens;

    while (i < tokens.length) {
      const t = tokens[i];

      if (t.text === '{') {
        depth++;
        i++;
        continue;
      }
      if (t.text === '}') {
        if (depth === 0) {
          return i + 1;
        }
        depth--;
        i++;
        continue;
      }

      if (t.kind === 'keyword' && t.text === 'var') {
        const next = this.scanVarDecl(i, locals);
        if (next !== undefined) {
          i = next;
          continue;
        }
        i++;
        continue;
      }

      if (t.kind === 'ident') {
        const short = this.scanShortDecl(i, locals);
        if (short !== undefined) {
          i = short;
          continue;
        }

        const prev = tokens[i - 1];
        if (tokens[i + 1]?.text === '(') {
          if (prev?.text === '.') {
            const chain = this.buildChainBackward(i);
            if (chain.length >= 2) {
              calls.push({
                name: t.text,
                start: t.start,
                end: t.end,
                receiverChain: chain.slice(0, -1),
                locals
              });
            }
          } else if (prev?.text !== 'func') {
            calls.push({ name: t.text, start: t.start, end: t.end, locals });
          }
        }

        // 复合字面量：T{...} / pkg.T{...}
        const nextTok = tokens[i + 1];
        if (nextTok?.text === '{') {
          if (prev?.text === '.') {
            const qualifierTok = tokens[i - 2];
            if (qualifierTok?.kind === 'ident') {
              this.pushTypeRef(t.text, qualifierTok.text, t.start, t.end, qualifierTok.text + '.' + t.text);
            }
          } else if (!prev || !CONTROL_PREV.has(prev.text)) {
            this.pushTypeRef(t.text, undefined, t.start, t.end, t.text);
          }
        }
      }

      i++;
    }

    return i;
  }

  private buildChainBackward(i: number): string[] {
    const chain = [this.tokens[i].text];
    let k = i - 1;
    while (k >= 1 && this.tokens[k].text === '.' && this.tokens[k - 1].kind === 'ident') {
      chain.unshift(this.tokens[k - 1].text);
      k -= 2;
    }
    return chain;
  }

  private scanVarDecl(varIdx: number, locals: LocalVar[]): number | undefined {
    let j = varIdx + 1;
    if (this.tokens[j]?.kind !== 'ident') {
      return undefined;
    }
    const names = [this.tokens[j].text];
    j++;
    while (this.tokens[j]?.text === ',' && this.tokens[j + 1]?.kind === 'ident') {
      names.push(this.tokens[j + 1].text);
      j += 2;
    }

    if (this.isTypeStart(this.tokens[j]) && this.tokens[j].text !== '{') {
      const typeExpr = this.readTypeExpr(j);
      if (typeExpr.text) {
        for (const name of names) {
          if (name !== '_') {
            locals.push({ names: [name], typeText: typeExpr.text });
          }
        }
      }
      return typeExpr.end;
    }

    if (this.tokens[j]?.text === '=') {
      this.recordLocalsFromRhs(names, j + 1, locals);
      return j + 1;
    }

    return j;
  }

  private scanShortDecl(i: number, locals: LocalVar[]): number | undefined {
    const names = [this.tokens[i].text];
    let j = i + 1;
    while (this.tokens[j]?.text === ',' && this.tokens[j + 1]?.kind === 'ident') {
      names.push(this.tokens[j + 1].text);
      j += 2;
    }
    if (this.tokens[j]?.text !== ':=') {
      return undefined;
    }
    this.recordLocalsFromRhs(names, j + 1, locals);
    return j + 1;
  }

  /**
   * 根据赋值右侧记录局部变量。支持：
   * - 单表达式：a := f() / a := T{} / a := pkg.NewX()
   * - 多值单调用：a, b := f()（a/b 分别对应 f 的第 0/1 个返回值）
   * - 一一对应多调用：a, b := f(), g()
   * 其他形式（a, b := 1, 2 / v, ok := m[k] / v, ok := x.(T)）保持原样，不记录。
   */
  private recordLocalsFromRhs(names: string[], rhsStart: number, locals: LocalVar[]): void {
    if (names.length === 0) {
      return;
    }
    const parts = this.splitRhs(rhsStart);
    if (parts.length === 1) {
      const inferred = this.inferRhs(parts[0]);
      if (!inferred) {
        return;
      }
      if (inferred.typeText) {
        if (names.length === 1 && names[0] !== '_') {
          locals.push({ names: [names[0]], typeText: inferred.typeText });
        }
        return;
      }
      if (inferred.ctorText) {
        names.forEach((name, index) => {
          if (name === '_') {
            return;
          }
          const entry: LocalVar = { names: [name], ctorText: inferred.ctorText };
          if (names.length > 1) {
            entry.ctorIndex = index;
          }
          locals.push(entry);
        });
      }
      return;
    }

    if (parts.length !== names.length) {
      return;
    }
    const inferredList = parts.map(part => this.inferRhs(part));
    if (!inferredList.every(item => item?.ctorText)) {
      return;
    }
    names.forEach((name, index) => {
      if (name === '_') {
        return;
      }
      locals.push({ names: [name], ctorText: inferredList[index]!.ctorText });
    });
  }

  /** 返回 RHS 中顶层逗号分隔的各个表达式的起始 token 下标。 */
  private splitRhs(start: number): number[] {
    const parts = [start];
    let depth = 0;
    let j = start;
    while (j < this.tokens.length) {
      const t = this.tokens[j];
      if (j > start && depth === 0 && t.nl) {
        break;
      }
      if (t.text === '(' || t.text === '[' || t.text === '{') {
        depth++;
        j++;
        continue;
      }
      if (t.text === ')' || t.text === ']' || t.text === '}') {
        if (depth === 0) {
          break;
        }
        depth--;
        j++;
        continue;
      }
      if (depth === 0 && (t.text === ';' || t.text === ':=' || t.text === '=')) {
        break;
      }
      if (depth === 0 && t.text === ',') {
        parts.push(j + 1);
        j++;
        continue;
      }
      j++;
    }
    return parts;
  }

  private inferRhs(i: number): { typeText?: string; ctorText?: string } | undefined {
    let j = i;
    if (this.tokens[j]?.text === '&') {
      j++;
    }

    if (this.tokens[j]?.kind === 'ident') {
      const segments = [this.tokens[j].text];
      let k = j + 1;
      while (this.tokens[k]?.text === '.' && this.tokens[k + 1]?.kind === 'ident') {
        segments.push(this.tokens[k + 1].text);
        k += 2;
      }
      let afterTypeArgs = k;
      if (this.tokens[k]?.text === '[') {
        afterTypeArgs = this.findMatching(k) + 1;
      }
      const qualified = segments.join('.');
      if (this.tokens[afterTypeArgs]?.text === '{') {
        return { typeText: qualified };
      }
      if (this.tokens[k]?.text === '(') {
        return { ctorText: qualified };
      }
    }

    if (this.tokens[j]?.text === 'new' && this.tokens[j + 1]?.text === '(') {
      const typeExpr = this.readTypeExpr(j + 2);
      if (typeExpr.text) {
        return { typeText: '*' + typeExpr.text };
      }
    }

    return undefined;
  }
}

/** 从类型文本中提取基础类型名：*pkg.Server -> Server。 */
export function baseNameOfType(typeText: string): string {
  let text = typeText.trim();
  while (text.startsWith('*')) {
    text = text.slice(1);
  }
  const bracket = text.indexOf('[');
  if (bracket >= 0) {
    text = text.slice(0, bracket);
  }
  const dot = text.lastIndexOf('.');
  return dot >= 0 ? text.slice(dot + 1) : text;
}
