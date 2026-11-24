import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GoIndex } from '../go/index';
import { GoFileIndex, ModuleInfo } from '../go/model';
import { parseGoFile } from '../go/parser';
import { hashText } from '../go/text';

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const close = glob.indexOf('}', i);
      if (close > i) {
        const parts = glob.slice(i + 1, close).split(',');
        out += '(?:' + parts.map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = close;
      } else {
        out += '\\{';
      }
    } else if ('.+^$()|[]\\'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp('^' + out + '$');
}

/**
 * 负责工作区级索引：发现 .go 文件、读取 go.mod、监听文件变更，
 * 并把最新（含未保存修改）的解析结果提供给导航 Provider。
 */
export class GoIndexService implements vscode.Disposable {
  readonly index = new GoIndex();

  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly overlay = new Map<string, string>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private disposed = false;
  private reindexing = false;
  private statusText = '';
  private notifyTimer: NodeJS.Timeout | undefined;
  private updateNotifier: (() => void) | undefined;

  constructor() {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = 'goNavigator.reindex';
    this.status.tooltip = '点击重建 Go 代码索引';
    this.status.show();
    this.disposables.push(this.status);

    this.ready = new Promise<void>(resolve => {
      this.resolveReady = resolve;
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  setUpdateNotifier(fn: () => void): void {
    this.updateNotifier = fn;
  }

  async initialize(): Promise<void> {
    this.reindexing = true;
    try {
      this.setStatus('$(sync~spin) Go 导航: 正在建立索引', true);
      await this.loadModules();
      await this.buildIndex();
      this.registerWatchers();
      this.setStatus(`$(check) Go 导航: ${this.index.size} 个文件`, true);
    } catch (error) {
      this.setStatus('$(error) Go 索引失败', true);
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Go Navigator 索引失败: ${message}`);
    } finally {
      this.reindexing = false;
      this.resolveReady();
      this.scheduleNotify();
    }
  }

  async reindex(): Promise<void> {
    if (this.reindexing) {
      return;
    }
    this.reindexing = true;
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
    this.overlay.clear();
    try {
      this.setStatus('$(sync~spin) Go 导航: 正在重建索引', true);
      await this.loadModules();
      await this.buildIndex();
      this.setStatus(`$(check) Go 导航: ${this.index.size} 个文件`, true);
      vscode.window.showInformationMessage(`Go Navigator: 索引完成，共 ${this.index.size} 个 Go 文件。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Go Navigator 重建索引失败: ${message}`);
      this.setStatus('$(error) Go 索引失败', true);
    } finally {
      this.reindexing = false;
      this.scheduleNotify();
    }
  }

  private async loadModules(): Promise<void> {
    const modules: ModuleInfo[] = [];
    const goMods = await vscode.workspace.findFiles('**/go.mod', '**/node_modules/**', 200);
    for (const uri of goMods) {
      const normalized = uri.fsPath.replace(/\\/g, '/');
      if (/\/(?:\.git|vendor)\//.test(normalized)) {
        continue;
      }
      try {
        const text = await fs.promises.readFile(uri.fsPath, 'utf8');
        const match = /^\s*module\s+(\S+)/m.exec(text);
        if (match) {
          modules.push({ root: path.dirname(uri.fsPath), module: match[1] });
        }
      } catch {
        // 忽略无法读取的 go.mod
      }
    }
    this.index.setModules(modules);
  }

  private async buildIndex(): Promise<void> {
    const config = vscode.workspace.getConfiguration('goNavigator');
    const indexVendor = config.get<boolean>('indexVendor', false);
    const userExcludes = config.get<string[]>('exclude', []) ?? [];
    const maxBytes = Math.max(64, config.get<number>('maxFileSizeKB', 2048)) * 1024;

    const defaultPatterns = ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**'];
    if (!indexVendor) {
      defaultPatterns.push('**/vendor/**');
    }
    const excludeMatchers = [...defaultPatterns, ...userExcludes].map(globToRegExp);

    const uris = await vscode.workspace.findFiles('**/*.go', '**/node_modules/**');
    const targets = uris.filter(uri => {
      const normalized = uri.fsPath.replace(/\\/g, '/');
      return !excludeMatchers.some(regex => regex.test(normalized));
    });

    this.index.clear();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Go Navigator 正在解析 Go 源文件',
        cancellable: true
      },
      async (progress, token) => {
        const total = targets.length;
        const batchSize = 64;
        for (let i = 0; i < total; i += batchSize) {
          if (token.isCancellationRequested || this.disposed) {
            break;
          }
          await Promise.all(
            targets.slice(i, i + batchSize).map(async uri => {
              const file = await this.readAndParse(uri, maxBytes);
              if (file) {
                this.index.upsert(file);
              }
            })
          );
          progress.report({
            message: `${Math.min(i + batchSize, total)}/${total}`,
            increment: total > 0 ? (batchSize / total) * 100 : 100
          });
          this.setStatus(`$(sync~spin) Go 导航: 已解析 ${this.index.size}/${total}`, true);
          // 让出事件循环，避免长时间阻塞扩展宿主
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    );
  }

  private async readAndParse(uri: vscode.Uri, maxBytes: number): Promise<GoFileIndex | undefined> {
    try {
      const stat = await fs.promises.stat(uri.fsPath);
      if (stat.size > maxBytes) {
        return undefined;
      }
      const buffer = await fs.promises.readFile(uri.fsPath);
      return parseGoFile(buffer.toString('utf8'), uri.fsPath);
    } catch {
      return undefined;
    }
  }

  private registerWatchers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.go');
    watcher.onDidCreate(uri => this.scheduleDiskReload(uri));
    watcher.onDidChange(uri => this.scheduleDiskReload(uri));
    watcher.onDidDelete(uri => {
      this.overlay.delete(uri.fsPath);
      this.index.remove(uri.fsPath);
      this.setStatus(`$(check) Go 导航: ${this.index.size} 个文件`, true);
      this.scheduleNotify();
    });
    this.disposables.push(watcher);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId !== 'go') {
          return;
        }
        const filePath = event.document.uri.fsPath;
        this.overlay.set(filePath, event.document.getText());
        this.scheduleDocumentParse(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.languageId !== 'go') {
          return;
        }
        this.overlay.delete(document.uri.fsPath);
        this.scheduleDiskReload(document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document.languageId !== 'go') {
          return;
        }
        if (this.overlay.delete(document.uri.fsPath)) {
          this.scheduleDiskReload(document.uri);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.reindex();
      })
    );
  }

  private scheduleDiskReload(uri: vscode.Uri): void {
    this.debounce(uri.fsPath, async () => {
      if (this.overlay.has(uri.fsPath)) {
        return;
      }
      const config = vscode.workspace.getConfiguration('goNavigator');
      const maxBytes = Math.max(64, config.get<number>('maxFileSizeKB', 2048)) * 1024;
      const file = await this.readAndParse(uri, maxBytes);
      if (file) {
        this.index.upsert(file);
      } else {
        this.index.remove(uri.fsPath);
      }
      this.setStatus(`$(check) Go 导航: ${this.index.size} 个文件`, true);
      this.scheduleNotify();
    });
  }

  private scheduleDocumentParse(document: vscode.TextDocument): void {
    const filePath = document.uri.fsPath;
    this.debounce(filePath, () => {
      const text = this.overlay.get(filePath);
      if (text === undefined) {
        return;
      }
      this.index.upsert(parseGoFile(text, filePath));
      this.scheduleNotify();
    });
  }

  private debounce(key: string, action: () => void | Promise<void>): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void action();
    }, 200);
    this.debounceTimers.set(key, timer);
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.updateNotifier?.();
    }, 300);
  }

  private setStatus(text: string, force = false): void {
    if (!force && text === this.statusText) {
      return;
    }
    this.statusText = text;
    this.status.text = text;
  }

  /**
   * 获取与当前编辑器内容一致的解析结果；若文档尚未索引或存在未保存修改则即时重建。
   */
  getFileForDocument(document: vscode.TextDocument): GoFileIndex | undefined {
    const filePath = document.uri.fsPath;
    const overlayText = this.overlay.get(filePath);

    if (overlayText !== undefined) {
      const existing = this.index.getFile(filePath);
      const hash = hashText(overlayText);
      if (!existing || existing.contentHash !== hash) {
        const parsed = parseGoFile(overlayText, filePath);
        this.index.upsert(parsed);
        this.scheduleNotify();
        return parsed;
      }
      return existing;
    }

    const existing = this.index.getFile(filePath);
    if (existing) {
      return existing;
    }
    if (document.languageId !== 'go') {
      return undefined;
    }
    const parsed = parseGoFile(document.getText(), filePath);
    this.index.upsert(parsed);
    this.scheduleNotify();
    return parsed;
  }

  dispose(): void {
    this.disposed = true;
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    this.disposables.forEach(disposable => disposable.dispose());
    this.disposables.length = 0;
  }
}
