/**
 * Go 代码模型：解析器、索引与导航 Provider 之间共享的数据结构。
 * 该文件不依赖 vscode，便于单独测试解析逻辑。
 */

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** 该 token 之前是否存在换行（用于 Go 的分号插入语义）。 */
  nl: boolean;
}

export type TokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'rune' | 'operator' | 'punct';

/** 类型引用（可用于跳转到类型定义），start/end 指向类型的基础名字 token。 */
export interface TypeRef {
  name: string;
  qualifier?: string;
  start: number;
  end: number;
  /** 完整类型文本，例如 "*pkg.Server"、"[]Foo"。 */
  text: string;
}

export interface MethodSignature {
  paramTypes: string[];
  paramNames: string[];
  resultTypes: string[];
  variadic: boolean;
  /** 便于展示的签名文本。 */
  text: string;
}

export interface InterfaceMethod {
  name: string;
  nameStart: number;
  nameEnd: number;
  signature: MethodSignature;
  start: number;
  end: number;
}

export interface StructField {
  /** 命名字段的字段名；内嵌字段为空数组。 */
  names: string[];
  typeText: string;
  typeRef?: TypeRef;
  start: number;
  end: number;
}

export interface TypeDecl {
  name: string;
  nameStart: number;
  nameEnd: number;
  kind: 'interface' | 'struct' | 'alias' | 'other';
  declStart: number;
  declEnd: number;
  isAlias: boolean;
  typeParams: string[];
  interfaceMethods?: InterfaceMethod[];
  embeddedTypes?: TypeRef[];
  typeTerms?: TypeRef[];
  structFields?: StructField[];
  /** type A = B 时的目标类型引用。 */
  aliasTarget?: TypeRef;
}

export interface LocalVar {
  names: string[];
  /** 显式声明的类型文本，例如 "*Server"、"pkg.Repo"。 */
  typeText?: string;
  /** 由构造函数推断时的调用路径，例如 "NewServer"、"pkg.NewServer"。 */
  ctorText?: string;
}

export interface CallSite {
  name: string;
  start: number;
  end: number;
  /** s.repo.Find() -> ["s", "repo"]；pkg.Func() -> ["pkg"]。 */
  receiverChain?: string[];
  /** 所在函数/方法体内可见的局部变量（共享引用）。 */
  locals: LocalVar[];
}

export interface FuncDecl {
  name: string;
  nameStart: number;
  nameEnd: number;
  /** 接收者变量名，例如 func (s *Server) 中的 "s"。 */
  recvName?: string;
  /** 接收者类型文本，例如 "*Server"。 */
  recvTypeText?: string;
  signature: MethodSignature;
  declStart: number;
  declEnd: number;
  locals: LocalVar[];
  calls: CallSite[];
}

export interface ImportSpec {
  /** 显式别名；未显式声明时为 undefined。 */
  alias?: string;
  path: string;
}

export interface DeclRef {
  name: string;
  start: number;
  end: number;
  kind: 'type' | 'func' | 'method' | 'ifaceMethod';
  ownerType?: string;
}

export interface GoFileIndex {
  /** 文件绝对路径。 */
  path: string;
  /** 文件所在目录（绝对路径）。 */
  dir: string;
  packageName: string;
  imports: ImportSpec[];
  types: TypeDecl[];
  funcs: FuncDecl[];
  methods: FuncDecl[];
  decls: DeclRef[];
  /** 文件中所有类型引用（含字段、参数、返回值、局部变量、复合字面量等）。 */
  typeRefs: TypeRef[];
  /** 文件中所有调用点。 */
  calls: CallSite[];
  lineStarts: number[];
  contentHash: string;
}

export interface SourceLocation {
  path: string;
  start: number;
  end: number;
}

export interface ResolvedType {
  file: GoFileIndex;
  decl: TypeDecl;
}

export interface Implementer {
  file: GoFileIndex;
  decl: TypeDecl;
  methods: Array<{ name: string; decl: FuncDecl; file: GoFileIndex }>;
}

export interface InterfaceMatch {
  file: GoFileIndex;
  decl: TypeDecl;
  methodName: string;
}

export interface ModuleInfo {
  root: string;
  module: string;
}
