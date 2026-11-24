import * as vscode from 'vscode';
import { GoIndexService } from './service';

/**
 * GoLand 风格的导航按钮：
 * - 接口 / 接口方法上方显示「N 个实现」，点击弹出实现列表；
 * - 结构体 / 方法上方显示「实现 N 个接口」，点击弹出接口列表。
 */
export class GoCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly service: GoIndexService) {}

  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration('goNavigator', document.uri);
    if (!config.get<boolean>('enableCodeLens', true)) {
      return [];
    }
    await this.service.whenReady();
    const file = this.service.getFileForDocument(document);
    if (!file) {
      return [];
    }

    const index = this.service.index;
    const lenses: vscode.CodeLens[] = [];
    const lineRange = (offset: number): vscode.Range => {
      const position = document.positionAt(offset);
      return new vscode.Range(position.line, 0, position.line, 0);
    };

    for (const decl of file.types) {
      if (token.isCancellationRequested) {
        return lenses;
      }
      if (decl.kind === 'interface') {
        const count = index.interfaceImplementationCount(file, decl);
        if (count > 0) {
          lenses.push(
            new vscode.CodeLens(lineRange(decl.nameStart), {
              title: `$(arrow-down) ${count} 个实现`,
              tooltip: `查看接口 ${decl.name} 的所有实现`,
              command: 'goNavigator.showImplementations',
              arguments: [{ path: file.path, offset: decl.nameStart }]
            })
          );
        }
        for (const method of decl.interfaceMethods ?? []) {
          const methodCount = index.interfaceMethodImplementationCount(file, decl, method.name);
          if (methodCount > 0) {
            lenses.push(
              new vscode.CodeLens(lineRange(method.nameStart), {
                title: `$(arrow-down) ${methodCount} 个实现`,
                tooltip: `查看 ${decl.name}.${method.name} 的所有实现`,
                command: 'goNavigator.showImplementations',
                arguments: [{ path: file.path, offset: method.nameStart }]
              })
            );
          }
        }
      } else if (decl.kind === 'struct') {
        const interfaceCount = index.interfaceCountForType(file, decl);
        if (interfaceCount > 0) {
          lenses.push(
            new vscode.CodeLens(lineRange(decl.nameStart), {
              title: `$(arrow-up) 实现 ${interfaceCount} 个接口`,
              tooltip: `查看 ${decl.name} 实现的接口`,
              command: 'goNavigator.showInterfaces',
              arguments: [{ path: file.path, offset: decl.nameStart }]
            })
          );
        }
      }
    }

    for (const method of file.methods) {
      if (token.isCancellationRequested) {
        return lenses;
      }
      const interfaceCount = index.interfaceCountForMethod(file, method);
      if (interfaceCount > 0) {
        lenses.push(
          new vscode.CodeLens(lineRange(method.nameStart), {
            title: `$(arrow-up) 属于 ${interfaceCount} 个接口`,
            tooltip: `查看方法 ${method.name} 对应的接口`,
            command: 'goNavigator.showInterfaces',
            arguments: [{ path: file.path, offset: method.nameStart }]
          })
        );
      }
    }

    return lenses;
  }
}
