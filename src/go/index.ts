import {
  CallSite, FuncDecl, GoFileIndex, Implementer, LocalVar, MethodSignature, ModuleInfo,
  ResolvedType, SourceLocation, Token, TypeDecl, TypeRef
} from './model';
import { tokenize } from './lexer';
import { baseNameOfType } from './parser';

export function normalizeTypeText(text: string): string {
  return text.replace(/\s+/g, '');
}

export function signatureCompatible(
  required: MethodSignature,
  provided: MethodSignature,
  canonicalRequired?: (text: string) => string,
  canonicalProvided?: (text: string) => string
): boolean {
  const canonReq = canonicalRequired ?? normalizeTypeText;
  const canonProv = canonicalProvided ?? normalizeTypeText;
  if (required.paramTypes.length !== provided.paramTypes.length) {
    return false;
  }
  for (let i = 0; i < required.paramTypes.length; i++) {
    if (canonReq(required.paramTypes[i]) !== canonProv(provided.paramTypes[i])) {
      return false;
    }
  }
  if (required.resultTypes.length !== provided.resultTypes.length) {
    return false;
  }
  for (let i = 0; i < required.resultTypes.length; i++) {
    if (canonReq(required.resultTypes[i]) !== canonProv(provided.resultTypes[i])) {
      return false;
    }
  }
  return true;
}

const TYPE_START_TOKENS = new Set(['*', '[', 'map', 'chan', 'func', 'interface', 'struct', '(', '<-', '...', '~']);

const TYPE_KEYWORDS = new Set([
  'func', 'map', 'chan', 'interface', 'struct', 'any', 'error', 'bool', 'byte',
  'rune', 'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8',
  'uint16', 'uint32', 'uint64', 'uintptr', 'float32', 'float64', 'complex64',
  'complex128', 'comparable'
]);

function isTypeStartToken(tok: Token | undefined): boolean {
  if (!tok) {
    return false;
  }
  return tok.kind === 'ident' || TYPE_START_TOKENS.has(tok.text);
}

/**
 * 去掉函数类型中的参数名：func(ctx context.Context) -> func(context.Context)，
 * 避免接口与实现仅仅因为参数名不同而被判定为签名不一致。
 */
function stripFuncParamNames(text: string): string {
  const tokens = tokenize(text);
  if (!tokens.some(tok => tok.text === 'func')) {
    return tokens.map(tok => tok.text).join('');
  }
  const drop = new Set<number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].text !== 'func' || tokens[i + 1].text !== '(') {
      continue;
    }
    let depth = 0;
    let close = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].text === '(') {
        depth++;
      } else if (tokens[j].text === ')') {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) {
      continue;
    }
    let j = i + 2;
    while (j < close) {
      if (tokens[j].text === ',' || tokens[j].text === ';') {
        j++;
        continue;
      }
      if (tokens[j].kind === 'ident') {
        const candidates = [j];
        let k = j + 1;
        while (k + 1 < close && tokens[k].text === ',' && tokens[k + 1].kind === 'ident') {
          candidates.push(k + 1);
          k += 2;
        }
        if (k < close && isTypeStartToken(tokens[k])) {
          for (const index of candidates) {
            drop.add(index);
          }
          j = k;
        } else {
          j = k;
        }
      } else {
        j++;
      }
    }
  }
  if (drop.size === 0) {
    return tokens.map(tok => tok.text).join('');
  }
  return tokens.filter((_, index) => !drop.has(index)).map(tok => tok.text).join('');
}

const BUILTIN_FUNCS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag',
  'len', 'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover'
]);

interface MethodEntry {
  signature: MethodSignature;
  file: GoFileIndex;
  decl?: FuncDecl;
  iface?: { name: string; nameStart: number; nameEnd: number };
}

interface FallbackCandidate {
  location: SourceLocation;
  signature: MethodSignature;
  file: GoFileIndex;
}

export interface InterfaceInfo {
  file: GoFileIndex;
  decl: TypeDecl;
}

export interface ImplementationItem {
  label: string;
  description?: string;
  detail?: string;
  location: SourceLocation;
}

export interface ImplementationGroup {
  title: string;
  items: ImplementationItem[];
}

export interface ImplementationResult {
  symbolName: string;
  groups: ImplementationGroup[];
  locations: SourceLocation[];
}

type Occurrence =
  | { kind: 'decl'; declName: string; start: number; end: number; ownerType?: string; declKind: string }
  | { kind: 'type'; ref: TypeRef }
  | { kind: 'call'; call: CallSite };

function normPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  s = s.replace(/\/+$/, '');
  if (process.platform === 'win32') {
    s = s.toLowerCase();
  }
  return s;
}

/** 去掉指针/切片/可变参前缀，便于比较规范化后的类型键。 */
function stripTypePrefix(text: string): string {
  let value = text;
  while (value.startsWith('*') || value.startsWith('[]')) {
    value = value.startsWith('*') ? value.slice(1) : value.slice(2);
  }
  if (value.startsWith('...')) {
    value = value.slice(3);
  }
  return value;
}

export class GoIndex {
  version = 0;
  private files = new Map<string, GoFileIndex>();
  private modules: ModuleInfo[] = [];
  private dirFiles = new Map<string, GoFileIndex[]>();
  private dirPackages = new Map<string, string>();
  private dirTypeIndex = new Map<string, Map<string, ResolvedType>>();
  private dirMethodIndex = new Map<string, Map<string, Array<{ decl: FuncDecl; file: GoFileIndex }>>>();
  private dirsDirty = true;

  private methodSetCache = new Map<string, Map<string, MethodEntry>>();
  private implementersCache = new Map<string, Implementer[]>();
  private interfacesForTypeCache = new Map<string, InterfaceInfo[]>();
  private interfacesForMethodCache = new Map<string, InterfaceInfo[]>();
  private methodImplCache = new Map<string, SourceLocation[]>();
  private canonicalCache = new Map<string, string>();

  // ------------------------------------------------------------------ 生命周期

  upsert(file: GoFileIndex): void {
    this.files.set(normPath(file.path), file);
    this.invalidate();
  }

  remove(path: string): void {
    if (this.files.delete(normPath(path))) {
      this.invalidate();
    }
  }

  clear(): void {
    this.files.clear();
    this.dirFiles.clear();
    this.dirPackages.clear();
    this.dirTypeIndex.clear();
    this.dirMethodIndex.clear();
    this.dirsDirty = true;
    this.invalidate();
  }

  setModules(modules: ModuleInfo[]): void {
    this.modules = modules;
    this.dirsDirty = true;
    this.invalidate();
  }

  getFiles(): GoFileIndex[] {
    return Array.from(this.files.values());
  }

  getFile(path: string): GoFileIndex | undefined {
    return this.files.get(normPath(path));
  }

  get size(): number {
    return this.files.size;
  }

  private invalidate(): void {
    this.dirsDirty = true;
    this.dirTypeIndex.clear();
    this.dirMethodIndex.clear();
    this.version++;
    this.methodSetCache.clear();
    this.implementersCache.clear();
    this.interfacesForTypeCache.clear();
    this.interfacesForMethodCache.clear();
    this.methodImplCache.clear();
    this.canonicalCache.clear();
  }

  private ensureDirs(): void {
    if (!this.dirsDirty) {
      return;
    }
    this.dirFiles.clear();
    this.dirPackages.clear();
    for (const file of this.files.values()) {
      const key = normPath(file.dir);
      const list = this.dirFiles.get(key);
      if (list) {
        list.push(file);
      } else {
        this.dirFiles.set(key, [file]);
      }
      if (!this.dirPackages.get(key) && file.packageName) {
        this.dirPackages.set(key, file.packageName);
      }
    }
    this.dirsDirty = false;
  }

  private dirKey(dir: string): string {
    return normPath(dir);
  }

  private nodeKey(file: GoFileIndex, decl: TypeDecl): string {
    return normPath(file.dir) + '#' + decl.name;
  }

  private locationOf(file: GoFileIndex, start: number, end: number): SourceLocation {
    return { path: file.path, start, end };
  }

  private declLocation(file: GoFileIndex, decl: TypeDecl): SourceLocation {
    return this.locationOf(file, decl.nameStart, decl.nameEnd);
  }

  private funcLocation(file: GoFileIndex, fn: FuncDecl): SourceLocation {
    return this.locationOf(file, fn.nameStart, fn.nameEnd);
  }

  // ------------------------------------------------------------------ 包与 import

  packageNameOfDir(dirKey: string): string | undefined {
    this.ensureDirs();
    return this.dirPackages.get(dirKey);
  }

  filesInDir(dirKey: string): GoFileIndex[] {
    this.ensureDirs();
    return this.dirFiles.get(dirKey) ?? [];
  }

  private dirExists(dirKey: string): boolean {
    this.ensureDirs();
    return this.dirFiles.has(dirKey);
  }

  resolveImportDir(_fromFile: GoFileIndex, importPath: string): string | undefined {
    const target = importPath.replace(/\\/g, '/').replace(/\/+$/, '');
    this.ensureDirs();

    for (const module of this.modules) {
      const root = normPath(module.root);
      const modulePath = module.module.replace(/\/+$/, '');
      if (target === modulePath) {
        if (this.dirExists(root)) {
          return root;
        }
        continue;
      }
      if (target.startsWith(modulePath + '/')) {
        const candidate = normPath(root + '/' + target.slice(modulePath.length + 1));
        if (this.dirExists(candidate)) {
          return candidate;
        }
      }
      const vendor = normPath(root + '/vendor/' + target);
      if (this.dirExists(vendor)) {
        return vendor;
      }
    }

    // 回退：按目录后缀匹配，适配未读取到 go.mod 或使用 replace 的场景
    let best: { dir: string; length: number } | undefined;
    for (const dir of this.dirFiles.keys()) {
      for (const module of this.modules) {
        const root = normPath(module.root);
        if (!dir.startsWith(root + '/')) {
          continue;
        }
        const rel = dir.slice(root.length + 1);
        if (!rel || rel.startsWith('..')) {
          continue;
        }
        if (target === rel || target.endsWith('/' + rel)) {
          if (!best || rel.length > best.length) {
            best = { dir, length: rel.length };
          }
        }
      }
    }
    return best?.dir;
  }

  aliasToDir(file: GoFileIndex, alias: string): string | undefined {
    for (const spec of file.imports) {
      if (spec.alias === '_' || spec.alias === '.') {
        continue;
      }
      const dir = this.resolveImportDir(file, spec.path);
      const pkg = dir ? this.packageNameOfDir(dir) : undefined;
      const effective = spec.alias ?? pkg ?? spec.path.split('/').pop() ?? '';
      if (effective === alias) {
        return dir;
      }
    }
    return undefined;
  }

  isImportAlias(file: GoFileIndex, alias: string): boolean {
    for (const spec of file.imports) {
      if (spec.alias === '_' || spec.alias === '.') {
        continue;
      }
      const dir = this.resolveImportDir(file, spec.path);
      const pkg = dir ? this.packageNameOfDir(dir) : undefined;
      const effective = spec.alias ?? pkg ?? spec.path.split('/').pop() ?? '';
      if (effective === alias) {
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ 符号查找

  findTypeInDir(dirKey: string, name: string): ResolvedType | undefined {
    let typeMap = this.dirTypeIndex.get(dirKey);
    if (!typeMap) {
      typeMap = new Map<string, ResolvedType>();
      for (const file of this.filesInDir(dirKey)) {
        for (const decl of file.types) {
          if (!typeMap.has(decl.name)) {
            typeMap.set(decl.name, { file, decl });
          }
        }
      }
      this.dirTypeIndex.set(dirKey, typeMap);
    }
    return typeMap.get(name);
  }

  findTypesByName(name: string): ResolvedType[] {
    const out: ResolvedType[] = [];
    for (const file of this.files.values()) {
      for (const decl of file.types) {
        if (decl.name === name) {
          out.push({ file, decl });
        }
      }
    }
    return out;
  }

  findMethods(dirKey: string, typeName: string): Array<{ decl: FuncDecl; file: GoFileIndex }> {
    let methodMap = this.dirMethodIndex.get(dirKey);
    if (!methodMap) {
      methodMap = new Map<string, Array<{ decl: FuncDecl; file: GoFileIndex }>>();
      for (const file of this.filesInDir(dirKey)) {
        for (const method of file.methods) {
          if (!method.recvTypeText) {
            continue;
          }
          const name = baseNameOfType(method.recvTypeText);
          const list = methodMap.get(name);
          if (list) {
            list.push({ decl: method, file });
          } else {
            methodMap.set(name, [{ decl: method, file }]);
          }
        }
      }
      this.dirMethodIndex.set(dirKey, methodMap);
    }
    return methodMap.get(typeName) ?? [];
  }

  findFuncsInDir(dirKey: string, name: string): Array<{ decl: FuncDecl; file: GoFileIndex }> {
    const out: Array<{ decl: FuncDecl; file: GoFileIndex }> = [];
    for (const file of this.filesInDir(dirKey)) {
      for (const fn of file.funcs) {
        if (fn.name === name) {
          out.push({ decl: fn, file });
        }
      }
    }
    return out;
  }

  functionsNamed(name: string): Array<{ decl: FuncDecl; file: GoFileIndex }> {
    const out: Array<{ decl: FuncDecl; file: GoFileIndex }> = [];
    for (const file of this.files.values()) {
      for (const fn of file.funcs) {
        if (fn.name === name) {
          out.push({ decl: fn, file });
        }
      }
    }
    return out;
  }

  methodsNamed(name: string): Array<{ decl: FuncDecl; file: GoFileIndex }> {
    const out: Array<{ decl: FuncDecl; file: GoFileIndex }> = [];
    for (const file of this.files.values()) {
      for (const method of file.methods) {
        if (method.name === name) {
          out.push({ decl: method, file });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 类型解析

  resolveNamedType(file: GoFileIndex, name: string, qualifier?: string): ResolvedType | undefined {
    if (qualifier) {
      const dir = this.aliasToDir(file, qualifier);
      if (dir) {
        return this.findTypeInDir(dir, name);
      }
      return undefined;
    }
    const local = this.findTypeInDir(this.dirKey(file.dir), name);
    if (local) {
      return local;
    }
    const all = this.findTypesByName(name);
    if (all.length === 1) {
      return all[0];
    }
    return undefined;
  }

  resolveTypeRef(file: GoFileIndex, ref: TypeRef): ResolvedType | undefined {
    return this.resolveNamedType(file, ref.name, ref.qualifier);
  }

  resolveTypeText(file: GoFileIndex, text: string): ResolvedType | undefined {
    let value = text.replace(/\s+/g, '');
    while (value.startsWith('*')) {
      value = value.slice(1);
    }
    if (!value) {
      return undefined;
    }
    if (/^(\[|map\[|func|chan|interface|struct|<-)/.test(value)) {
      return undefined;
    }
    const bracket = value.indexOf('[');
    if (bracket > 0) {
      value = value.slice(0, bracket);
    }
    const parts = value.split('.');
    if (parts.length > 2) {
      return undefined;
    }
    const name = parts[parts.length - 1];
    const qualifier = parts.length === 2 ? parts[0] : undefined;
    return this.resolveNamedType(file, name, qualifier);
  }

  followAlias(resolved: ResolvedType): ResolvedType {
    let current = resolved;
    const guard = new Set<string>();
    while (current.decl.isAlias && current.decl.aliasTarget) {
      const key = this.nodeKey(current.file, current.decl);
      if (guard.has(key)) {
        break;
      }
      guard.add(key);
      const next = this.resolveTypeRef(current.file, current.decl.aliasTarget);
      if (!next) {
        break;
      }
      current = next;
    }
    return current;
  }

  // ------------------------------------------------------------------ 方法集与接口实现

  methodSetOf(file: GoFileIndex, decl: TypeDecl): Map<string, MethodEntry> {
    const key = this.nodeKey(file, decl);
    const cached = this.methodSetCache.get(key);
    if (cached) {
      return cached;
    }
    const result = this.computeMethodSet(file, decl, new Set());
    this.methodSetCache.set(key, result);
    return result;
  }

  private computeMethodSet(file: GoFileIndex, decl: TypeDecl, visiting: Set<string>): Map<string, MethodEntry> {
    const key = this.nodeKey(file, decl);
    const result = new Map<string, MethodEntry>();
    if (visiting.has(key)) {
      return result;
    }
    visiting.add(key);

    for (const entry of this.findMethods(this.dirKey(file.dir), decl.name)) {
      result.set(entry.decl.name, {
        signature: entry.decl.signature,
        decl: entry.decl,
        file: entry.file
      });
    }

    const mergeInterface = (ifaceFile: GoFileIndex, ifaceDecl: TypeDecl) => {
      for (const [name, entry] of this.computeMethodSet(ifaceFile, ifaceDecl, visiting)) {
        if (!result.has(name)) {
          result.set(name, entry);
        }
      }
    };

    if (decl.kind === 'interface') {
      for (const method of decl.interfaceMethods ?? []) {
        if (!result.has(method.name)) {
          result.set(method.name, {
            signature: method.signature,
            file,
            iface: { name: method.name, nameStart: method.nameStart, nameEnd: method.nameEnd }
          });
        }
      }
      for (const ref of decl.embeddedTypes ?? []) {
        const target = this.resolveTypeRef(file, ref);
        if (target && target.decl.kind === 'interface') {
          mergeInterface(target.file, target.decl);
        }
      }
    }

    for (const field of decl.structFields ?? []) {
      if (field.names.length > 0 || !field.typeRef) {
        continue;
      }
      const target = this.resolveTypeRef(file, field.typeRef);
      if (target) {
        mergeInterface(target.file, target.decl);
      }
    }

    if (decl.isAlias && decl.aliasTarget) {
      const target = this.resolveTypeRef(file, decl.aliasTarget);
      if (target) {
        mergeInterface(target.file, target.decl);
      }
    }

    return result;
  }

  private satisfies(methodSet: Map<string, MethodEntry>, required: Map<string, MethodEntry>): boolean {
    for (const [name, needed] of required) {
      const provided = methodSet.get(name);
      if (!provided || !this.signatureMatches(needed, provided)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 把类型文本规范化为「包目录#类型名」，从而正确比较跨包的同一类型
   * （例如接口中的 *User 与实现中的 *domain.User）。
   */
  private canonicalType(file: GoFileIndex, text: string): string {
    const cacheKey = normPath(file.path) + '|' + text;
    const cached = this.canonicalCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const stripped = stripFuncParamNames(text);
    const value = stripped.replace(
      /([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g,
      (_match, first: string, second: string | undefined) => {
        if (second) {
          const dir = this.aliasToDir(file, first);
          if (dir) {
            const found = this.findTypeInDir(dir, second);
            if (found) {
              return '#' + this.dirKey(found.file.dir) + '.' + found.decl.name;
            }
          }
          return second;
        }
        if (TYPE_KEYWORDS.has(first)) {
          return first;
        }
        const found = this.findTypeInDir(this.dirKey(file.dir), first);
        if (found) {
          return '#' + this.dirKey(found.file.dir) + '.' + found.decl.name;
        }
        return first;
      }
    );
    this.canonicalCache.set(cacheKey, value);
    return value;
  }

  private signatureMatches(required: MethodEntry, provided: MethodEntry): boolean {
    return signatureCompatible(
      required.signature,
      provided.signature,
      text => this.canonicalType(required.file, text),
      text => this.canonicalType(provided.file, text)
    );
  }

  findImplementers(ifaceFile: GoFileIndex, ifaceDecl: TypeDecl): Implementer[] {
    const key = this.nodeKey(ifaceFile, ifaceDecl);
    const cached = this.implementersCache.get(key);
    if (cached) {
      return cached;
    }

    const required = this.methodSetOf(ifaceFile, ifaceDecl);
    if (required.size === 0) {
      this.implementersCache.set(key, []);
      return [];
    }

    const out: Implementer[] = [];
    for (const file of this.files.values()) {
      for (const decl of file.types) {
        if (decl.kind === 'interface') {
          continue;
        }
        // 别名与其目标类型会重复，跳过别名避免噪声
        if (decl.isAlias && decl.aliasTarget) {
          continue;
        }
        const set = this.methodSetOf(file, decl);
        if (set.size < required.size) {
          continue;
        }
        if (!this.satisfies(set, required)) {
          continue;
        }
        const methods: Implementer['methods'] = [];
        for (const method of set.values()) {
          if (method.decl) {
            methods.push({ name: method.decl.name, decl: method.decl, file: method.file });
          }
        }
        out.push({ file, decl, methods });
      }
    }

    out.sort((a, b) => a.decl.name.localeCompare(b.decl.name));
    this.implementersCache.set(key, out);
    return out;
  }

  findInterfacesForType(file: GoFileIndex, decl: TypeDecl): InterfaceInfo[] {
    const key = this.nodeKey(file, decl);
    const cached = this.interfacesForTypeCache.get(key);
    if (cached) {
      return cached;
    }
    const set = this.methodSetOf(file, decl);
    const out: InterfaceInfo[] = [];
    for (const candidate of this.files.values()) {
      for (const iface of candidate.types) {
        if (iface.kind !== 'interface') {
          continue;
        }
        const required = this.methodSetOf(candidate, iface);
        if (required.size === 0) {
          continue;
        }
        if (this.satisfies(set, required)) {
          out.push({ file: candidate, decl: iface });
        }
      }
    }
    this.interfacesForTypeCache.set(key, out);
    return out;
  }

  interfacesForMethod(method: FuncDecl, file: GoFileIndex): InterfaceInfo[] {
    const typeName = method.recvTypeText ? baseNameOfType(method.recvTypeText) : '';
    if (!typeName) {
      return [];
    }
    const key = this.dirKey(file.dir) + '#' + typeName + '#' + method.name;
    const cached = this.interfacesForMethodCache.get(key);
    if (cached) {
      return cached;
    }
    const typeInfo = this.findTypeInDir(this.dirKey(file.dir), typeName);
    if (!typeInfo) {
      this.interfacesForMethodCache.set(key, []);
      return [];
    }
    const set = this.methodSetOf(typeInfo.file, typeInfo.decl);
    const out: InterfaceInfo[] = [];
    for (const candidate of this.files.values()) {
      for (const iface of candidate.types) {
        if (iface.kind !== 'interface') {
          continue;
        }
        const required = this.methodSetOf(candidate, iface);
        const needed = required.get(method.name);
        if (!needed || !this.signatureMatches(needed, { signature: method.signature, file })) {
          continue;
        }
        if (this.satisfies(set, required)) {
          out.push({ file: candidate, decl: iface });
        }
      }
    }
    this.interfacesForMethodCache.set(key, out);
    return out;
  }

  implementationsOfInterfaceMethod(
    ifaceFile: GoFileIndex,
    ifaceDecl: TypeDecl,
    methodName: string
  ): SourceLocation[] {
    const key = this.nodeKey(ifaceFile, ifaceDecl) + '#' + methodName;
    const cached = this.methodImplCache.get(key);
    if (cached) {
      return cached;
    }
    const locations: SourceLocation[] = [];
    const seen = new Set<string>();
    for (const impl of this.findImplementers(ifaceFile, ifaceDecl)) {
      for (const method of impl.methods) {
        if (method.name !== methodName) {
          continue;
        }
        const loc = this.funcLocation(method.file, method.decl);
        const dedupe = normPath(loc.path) + ':' + loc.start;
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          locations.push(loc);
        }
      }
    }
    this.methodImplCache.set(key, locations);
    return locations;
  }

  // ------------------------------------------------------------------ 定义解析

  private findOccurrenceAt(file: GoFileIndex, offset: number): Occurrence | undefined {
    let best: Occurrence | undefined;
    let bestSpan = Number.MAX_VALUE;

    for (const decl of file.decls) {
      if (offset >= decl.start && offset <= decl.end) {
        const span = decl.end - decl.start;
        if (span < bestSpan) {
          bestSpan = span;
          best = {
            kind: 'decl',
            declName: decl.name,
            start: decl.start,
            end: decl.end,
            ownerType: decl.ownerType,
            declKind: decl.kind
          };
        }
      }
    }

    for (const ref of file.typeRefs) {
      if (offset >= ref.start && offset <= ref.end) {
        const span = ref.end - ref.start;
        if (span < bestSpan) {
          bestSpan = span;
          best = { kind: 'type', ref };
        }
      }
    }

    for (const call of file.calls) {
      if (offset >= call.start && offset <= call.end) {
        const span = call.end - call.start;
        if (span < bestSpan) {
          bestSpan = span;
          best = { kind: 'call', call };
        }
      }
    }

    return best;
  }

  resolveDefinitionAt(file: GoFileIndex, offset: number): SourceLocation[] {
    const occurrence = this.findOccurrenceAt(file, offset);
    if (!occurrence) {
      return [];
    }
    if (occurrence.kind === 'decl') {
      return [{ path: file.path, start: occurrence.start, end: occurrence.end }];
    }
    if (occurrence.kind === 'type') {
      const target = this.resolveTypeRef(file, occurrence.ref);
      return target ? [this.declLocation(target.file, target.decl)] : [];
    }
    return this.resolveCall(file, occurrence.call);
  }

  resolveCall(file: GoFileIndex, call: CallSite): SourceLocation[] {
    const chain = call.receiverChain ?? [];

    if (chain.length === 0) {
      return this.resolveFunctionName(file, call);
    }

    // pkg.Func(...)
    if (chain.length === 1 && this.isImportAlias(file, chain[0])) {
      const dir = this.aliasToDir(file, chain[0]);
      if (!dir) {
        return [];
      }
      return this.findFuncsInDir(dir, call.name).map(entry => this.funcLocation(entry.file, entry.decl));
    }

    const receiver = this.inferReceiverType(file, call);
    if (receiver) {
      const target = this.followAlias(receiver);
      const set = this.methodSetOf(target.file, target.decl);
      const entry = set.get(call.name);
      if (entry?.decl) {
        return [this.funcLocation(entry.file, entry.decl)];
      }
      if (entry?.iface) {
        return [{ path: entry.file.path, start: entry.iface.nameStart, end: entry.iface.nameEnd }];
      }
    }

    return this.fallbackCallCandidates(file, call);
  }

  /**
   * 类型推断失败时的兜底：先按实参个数过滤候选，再用可解析的实参类型与
   * 候选参数类型做规范化比较，只保留匹配度最高的同名符号。
   */
  private fallbackCallCandidates(file: GoFileIndex, call: CallSite): SourceLocation[] {
    const items: FallbackCandidate[] = [];
    const seen = new Set<string>();
    const push = (location: SourceLocation, signature: MethodSignature, owner: GoFileIndex) => {
      const key = normPath(location.path) + ':' + location.start;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      items.push({ location, signature, file: owner });
    };

    for (const entry of this.methodsNamed(call.name)) {
      push(this.funcLocation(entry.file, entry.decl), entry.decl.signature, entry.file);
    }
    for (const entry of this.functionsNamed(call.name)) {
      push(this.funcLocation(entry.file, entry.decl), entry.decl.signature, entry.file);
    }
    for (const candidate of this.files.values()) {
      for (const iface of candidate.types) {
        if (iface.kind !== 'interface') {
          continue;
        }
        for (const method of iface.interfaceMethods ?? []) {
          if (method.name === call.name) {
            push(
              { path: candidate.path, start: method.nameStart, end: method.nameEnd },
              method.signature,
              candidate
            );
          }
        }
      }
    }
    return this.rankCandidates(file, call, items).map(item => item.location).slice(0, 30);
  }

  private rankCandidates(
    file: GoFileIndex,
    call: CallSite,
    candidates: FallbackCandidate[]
  ): FallbackCandidate[] {
    if (!call.args || candidates.length === 0) {
      return candidates;
    }

    const sameArity = candidates.filter(item => this.callArgsMatch(call, item.signature));
    if (sameArity.length <= 1) {
      return sameArity;
    }

    const scores = sameArity.map(item =>
      this.signatureTypeScore(file, call, item.file, item.signature)
    );
    const best = Math.max(...scores);
    if (best <= 0) {
      return sameArity;
    }
    return sameArity.filter((_item, index) => scores[index] === best);
  }

  /** 实参个数是否与候选签名参数个数兼容（可变参放行）。 */
  private callArgsMatch(call: CallSite, signature: MethodSignature): boolean {
    if (!call.args) {
      return true;
    }
    const count = call.args.length;
    const params = signature.paramTypes.length;
    if (signature.variadic) {
      return count >= Math.max(0, params - 1);
    }
    return count === params;
  }

  /** 用可解析的实参类型与候选参数类型做规范化比较，返回匹配个数。 */
  private signatureTypeScore(
    file: GoFileIndex,
    call: CallSite,
    candidateFile: GoFileIndex,
    signature: MethodSignature
  ): number {
    if (!call.args) {
      return 0;
    }
    let score = 0;
    const limit = Math.min(call.args.length, signature.paramTypes.length);
    for (let i = 0; i < limit; i++) {
      const argType = this.resolveArgumentType(file, call.locals, call.args[i]);
      if (!argType) {
        continue;
      }
      const argKey = stripTypePrefix(this.canonicalResolvedType(argType));
      const paramKey = stripTypePrefix(this.canonicalType(candidateFile, signature.paramTypes[i]));
      if (paramKey === argKey) {
        score++;
      }
    }
    return score;
  }

  /** 仅支持简单标识符（可带 & 取址）的实参类型解析。 */
  private resolveArgumentType(
    file: GoFileIndex,
    locals: LocalVar[],
    argText: string
  ): ResolvedType | undefined {
    const trimmed = argText.trim();
    if (!/^&?[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      return undefined;
    }
    const name = trimmed.replace(/^&/, '');
    const local = locals.find(item => item.names.includes(name));
    if (!local) {
      return undefined;
    }
    if (local.typeText) {
      return this.resolveTypeText(file, local.typeText);
    }
    if (local.ctorText) {
      return this.resolveChainType(file, locals, local.ctorText.split('.'), local.ctorIndex ?? 0);
    }
    return undefined;
  }

  private canonicalResolvedType(resolved: ResolvedType): string {
    const target = this.followAlias(resolved);
    return '#' + this.dirKey(target.file.dir) + '.' + target.decl.name;
  }

  private resolveFunctionName(file: GoFileIndex, call: CallSite): SourceLocation[] {
    const name = call.name;
    if (BUILTIN_FUNCS.has(name)) {
      return [];
    }
    const local = this.findFuncsInDir(this.dirKey(file.dir), name);
    if (local.length > 0) {
      return local.map(entry => this.funcLocation(entry.file, entry.decl));
    }
    const all = this.functionsNamed(name);
    if (all.length > 0) {
      const candidates: FallbackCandidate[] = all.map(entry => ({
        location: this.funcLocation(entry.file, entry.decl),
        signature: entry.decl.signature,
        file: entry.file
      }));
      return this.rankCandidates(file, call, candidates)
        .map(item => item.location)
        .slice(0, 30);
    }
    // 类型转换 T(x)
    const typeTarget = this.resolveNamedType(file, name);
    if (typeTarget) {
      return [this.declLocation(typeTarget.file, typeTarget.decl)];
    }
    return [];
  }

  private inferReceiverType(file: GoFileIndex, call: CallSite): ResolvedType | undefined {
    const chain = call.receiverChain ?? [];
    if (chain.length === 0) {
      return undefined;
    }
    return this.resolveChainType(file, call.locals, chain, 0);
  }

  /**
   * 解析表达式链的类型：
   * - 首段是 import 别名 → 包级函数，取 signature.resultTypes[resultIndex]；
   * - 首段是局部变量 → 按 typeText 或 ctorText/ctorIndex 递归解析；
   * - 后续段优先按结构体字段，其次按方法（含接口方法），取 resultTypes[resultIndex]。
   */
  private resolveChainType(
    file: GoFileIndex,
    locals: LocalVar[],
    chain: string[],
    resultIndex: number,
    depth = 0
  ): ResolvedType | undefined {
    if (chain.length === 0 || depth > 8) {
      return undefined;
    }

    const first = chain[0];
    if (this.isImportAlias(file, first)) {
      if (chain.length !== 2) {
        return undefined;
      }
      const dir = this.aliasToDir(file, first);
      if (!dir) {
        return undefined;
      }
      const candidates = this.findFuncsInDir(dir, chain[1]);
      if (candidates.length === 0) {
        return undefined;
      }
      const resultType = candidates[0].decl.signature.resultTypes[resultIndex];
      return resultType ? this.resolveTypeText(candidates[0].file, resultType) : undefined;
    }

    const local = locals.find(item => item.names.includes(first));
    if (!local) {
      return undefined;
    }

    let current: ResolvedType | undefined;
    if (local.typeText) {
      current = this.resolveTypeText(file, local.typeText);
    } else if (local.ctorText) {
      current = this.resolveChainType(
        file,
        locals,
        local.ctorText.split('.'),
        local.ctorIndex ?? 0,
        depth + 1
      );
    }
    if (!current) {
      return undefined;
    }

    for (let i = 1; i < chain.length; i++) {
      const target = this.followAlias(current);
      const segment = chain[i];
      const field = (target.decl.structFields ?? []).find(item => item.names.includes(segment));
      if (field) {
        const next = this.resolveTypeText(target.file, field.typeText);
        if (!next) {
          return undefined;
        }
        current = next;
        continue;
      }
      const entry = this.methodSetOf(target.file, target.decl).get(segment);
      if (!entry) {
        return undefined;
      }
      const resultType = entry.signature.resultTypes[resultIndex];
      const next = resultType ? this.resolveTypeText(entry.file, resultType) : undefined;
      if (!next) {
        return undefined;
      }
      current = next;
    }
    return current;
  }

  // ------------------------------------------------------------------ 实现列表

  findImplementationsAt(file: GoFileIndex, offset: number): ImplementationResult | undefined {
    const occurrence = this.findOccurrenceAt(file, offset);
    if (!occurrence) {
      return undefined;
    }

    if (occurrence.kind === 'decl') {
      if (occurrence.declKind === 'type') {
        const decl = file.types.find(item => item.name === occurrence.declName);
        if (decl && decl.kind === 'interface') {
          return this.buildInterfaceResult(file, decl);
        }
        if (decl) {
          return this.buildTypeInterfacesResult(file, decl);
        }
      }
      if (occurrence.declKind === 'ifaceMethod' && occurrence.ownerType) {
        const owner = file.types.find(item => item.name === occurrence.ownerType && item.kind === 'interface');
        const method = owner?.interfaceMethods?.find(item => item.name === occurrence.declName);
        if (owner && method) {
          return this.buildInterfaceMethodResult(file, owner, method.name);
        }
      }
      if (occurrence.declKind === 'method') {
        const method = file.methods.find(item => item.name === occurrence.declName && item.nameStart === occurrence.start);
        if (method) {
          return this.buildConcreteMethodResult(file, method);
        }
      }
      return undefined;
    }

    if (occurrence.kind === 'type') {
      const target = this.resolveTypeRef(file, occurrence.ref);
      if (!target) {
        return undefined;
      }
      const followed = this.followAlias(target);
      if (followed.decl.kind === 'interface') {
        return this.buildInterfaceResult(followed.file, followed.decl);
      }
      return undefined;
    }

    const receiver = this.inferReceiverType(file, occurrence.call);
    if (receiver) {
      const target = this.followAlias(receiver);
      if (target.decl.kind === 'interface') {
        return this.buildInterfaceMethodResult(target.file, target.decl, occurrence.call.name);
      }
      const entry = this.methodSetOf(target.file, target.decl).get(occurrence.call.name);
      if (entry?.decl) {
        return this.buildConcreteMethodResult(entry.file, entry.decl);
      }
    }
    return undefined;
  }

  private interfaceMethodLocation(file: GoFileIndex, iface: TypeDecl, methodName: string): SourceLocation | undefined {
    const method = iface.interfaceMethods?.find(item => item.name === methodName);
    if (!method) {
      return undefined;
    }
    return { path: file.path, start: method.nameStart, end: method.nameEnd };
  }

  private buildInterfaceResult(file: GoFileIndex, iface: TypeDecl): ImplementationResult {
    const implementers = this.findImplementers(file, iface);
    const typeItems: ImplementationItem[] = [];
    const methodItems: ImplementationItem[] = [];
    const seenMethods = new Set<string>();

    for (const impl of implementers) {
      typeItems.push({
        label: impl.decl.name,
        description: this.packageNameOfDir(this.dirKey(impl.file.dir)) ?? impl.file.packageName,
        detail: `${impl.methods.length} 个方法  ${impl.file.path}`,
        location: this.declLocation(impl.file, impl.decl)
      });
      for (const method of impl.methods) {
        const location = this.funcLocation(method.file, method.decl);
        const dedupeKey = normPath(location.path) + ':' + location.start;
        if (seenMethods.has(dedupeKey)) {
          continue;
        }
        seenMethods.add(dedupeKey);
        methodItems.push({
          label: `${impl.decl.name}.${method.name}`,
          description: this.packageNameOfDir(this.dirKey(method.file.dir)) ?? method.file.packageName,
          location
        });
      }
    }

    const groups: ImplementationGroup[] = [];
    if (typeItems.length > 0) {
      groups.push({ title: `实现类型 (${typeItems.length})`, items: typeItems });
    }
    if (methodItems.length > 0) {
      groups.push({ title: `实现方法 (${methodItems.length})`, items: methodItems });
    }

    const locations = implementers.map(impl => this.declLocation(impl.file, impl.decl));
    return { symbolName: iface.name, groups, locations };
  }

  private buildInterfaceMethodResult(file: GoFileIndex, iface: TypeDecl, methodName: string): ImplementationResult {
    const locations = this.implementationsOfInterfaceMethod(file, iface, methodName);
    const items: ImplementationItem[] = [];
    const seen = new Set<string>();
    for (const impl of this.findImplementers(file, iface)) {
      for (const method of impl.methods) {
        if (method.name !== methodName) {
          continue;
        }
        const location = this.funcLocation(method.file, method.decl);
        const dedupeKey = normPath(location.path) + ':' + location.start;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        items.push({
          label: `${impl.decl.name}.${method.name}`,
          description: this.packageNameOfDir(this.dirKey(method.file.dir)) ?? method.file.packageName,
          detail: method.file.path,
          location
        });
      }
    }
    return {
      symbolName: `${iface.name}.${methodName}`,
      groups: items.length ? [{ title: `实现方法 (${items.length})`, items }] : [],
      locations
    };
  }

  private buildTypeInterfacesResult(file: GoFileIndex, decl: TypeDecl): ImplementationResult {
    const interfaces = this.findInterfacesForType(file, decl);
    const items: ImplementationItem[] = interfaces.map(iface => ({
      label: `${iface.decl.name}`,
      description: this.packageNameOfDir(this.dirKey(iface.file.dir)) ?? iface.file.packageName,
      detail: iface.file.path,
      location: this.declLocation(iface.file, iface.decl)
    }));
    return {
      symbolName: decl.name,
      groups: items.length ? [{ title: `实现的接口 (${items.length})`, items }] : [],
      locations: interfaces.map(iface => this.declLocation(iface.file, iface.decl))
    };
  }

  private buildConcreteMethodResult(file: GoFileIndex, method: FuncDecl): ImplementationResult {
    const interfaces = this.interfacesForMethod(method, file);
    const items: ImplementationItem[] = [];
    const locations: SourceLocation[] = [];
    const seen = new Set<string>();
    for (const iface of interfaces) {
      const loc = this.interfaceMethodLocation(iface.file, iface.decl, method.name);
      if (!loc) {
        continue;
      }
      const key = normPath(loc.path) + ':' + loc.start;
      if (!seen.has(key)) {
        seen.add(key);
        locations.push(loc);
      }
      items.push({
        label: `${iface.decl.name}.${method.name}`,
        description: this.packageNameOfDir(this.dirKey(iface.file.dir)) ?? iface.file.packageName,
        detail: '接口方法',
        location: loc
      });
    }
    return {
      symbolName: method.name,
      groups: items.length ? [{ title: `对应的接口方法 (${items.length})`, items }] : [],
      locations
    };
  }

  findImplementationsForRegistration(file: GoFileIndex, offset: number): SourceLocation[] {
    const occurrence = this.findOccurrenceAt(file, offset);
    if (!occurrence) {
      return [];
    }
    if (occurrence.kind === 'decl') {
      if (occurrence.declKind === 'type') {
        const decl = file.types.find(item => item.name === occurrence.declName);
        if (decl && decl.kind === 'interface') {
          return this.findImplementers(file, decl).map(impl => this.declLocation(impl.file, impl.decl));
        }
        return [];
      }
      if (occurrence.declKind === 'ifaceMethod' && occurrence.ownerType) {
        const owner = file.types.find(item => item.name === occurrence.ownerType && item.kind === 'interface');
        if (owner) {
          return this.implementationsOfInterfaceMethod(file, owner, occurrence.declName);
        }
      }
      return [];
    }
    if (occurrence.kind === 'type') {
      const target = this.resolveTypeRef(file, occurrence.ref);
      if (target && target.decl.kind === 'interface') {
        return this.findImplementers(target.file, target.decl).map(impl => this.declLocation(impl.file, impl.decl));
      }
      return [];
    }
    const receiver = this.inferReceiverType(file, occurrence.call);
    if (receiver) {
      const target = this.followAlias(receiver);
      if (target.decl.kind === 'interface') {
        return this.implementationsOfInterfaceMethod(target.file, target.decl, occurrence.call.name);
      }
    }
    return [];
  }

  interfaceImplementationCount(file: GoFileIndex, decl: TypeDecl): number {
    return this.findImplementers(file, decl).length;
  }

  interfaceMethodImplementationCount(file: GoFileIndex, iface: TypeDecl, methodName: string): number {
    return this.implementationsOfInterfaceMethod(file, iface, methodName).length;
  }

  interfaceCountForType(file: GoFileIndex, decl: TypeDecl): number {
    return this.findInterfacesForType(file, decl).length;
  }

  interfaceCountForMethod(file: GoFileIndex, method: FuncDecl): number {
    return this.interfacesForMethod(method, file).length;
  }
}
