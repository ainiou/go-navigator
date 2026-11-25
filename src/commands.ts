import * as vscode from 'vscode';
import { GoFileIndex, SourceLocation } from './go/model';
import { offsetToLineChar } from './go/text';
import { GoIndexService } from './vscode/service';

interface SymbolArgument {
  path: string;
  offset: number;
}

type PickerItem = vscode.QuickPickItem & { location?: SourceLocation };

async function revealLocation(service: GoIndexService, location: SourceLocation): Promise<void> {
  const target = service.index.getFile(location.path);
  const uri = vscode.Uri.file(location.path);
  const document = await vscode.workspace.openTextDocument(uri);
  let selection: vscode.Range | undefined;
  if (target) {
    const start = offsetToLineChar(target.lineStarts, location.start);
    const end = offsetToLineChar(target.lineStarts, location.end);
    selection = new vscode.Range(start.line, start.character, end.line, end.character);
  }
  await vscode.window.showTextDocument(document, {
    selection,
    preview: false
  });
}

function resolveFile(service: GoIndexService, filePath: string): GoFileIndex | undefined {
  const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === filePath);
  if (open) {
    return service.getFileForDocument(open);
  }
  return service.index.getFile(filePath);
}

async function showSymbolNavigation(
  service: GoIndexService,
  filePath: string,
  offset: number,
  emptyMessage: string
): Promise<void> {
  const file = resolveFile(service, filePath);
  if (!file) {
    vscode.window.showInformationMessage('Gopher Nav: 文件尚未完成索引，请稍后重试或执行「重建 Go 索引」。');
    return;
  }
  const result = service.index.findImplementationsAt(file, offset);
  if (!result) {
    vscode.window.showInformationMessage('当前位置不是接口、接口方法或实现方法，无法查找实现。');
    return;
  }
  if (result.groups.length === 0) {
    vscode.window.showInformationMessage(emptyMessage.replace('{symbol}', result.symbolName));
    return;
  }

  // 统计所有候选位置总数，唯一匹配时直接跳转
  const allItems = result.groups.flatMap(g => g.items);
  if (allItems.length === 1) {
    await revealLocation(service, allItems[0].location);
    return;
  }

  const items: PickerItem[] = [];
  for (const group of result.groups) {
    items.push({ label: group.title, kind: vscode.QuickPickItemKind.Separator });
    const icon = group.title.includes('方法')
      ? '$(symbol-method)'
      : group.title.includes('接口')
        ? '$(symbol-interface)'
        : '$(symbol-struct)';
    for (const item of group.items) {
      items.push({
        label: `${icon} ${item.label}`,
        description: item.description,
        detail: item.detail,
        location: item.location
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `选择 ${result.symbolName} 的目标位置`,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (picked?.location) {
    await revealLocation(service, picked.location);
  }
}

export function registerCommands(context: vscode.ExtensionContext, service: GoIndexService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('goNavigator.findAllImplementations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'go') {
        vscode.window.showInformationMessage('Gopher Nav: 请在 Go 代码中将光标放在接口或方法上再使用该命令。');
        return;
      }
      await service.whenReady();
      await showSymbolNavigation(
        service,
        editor.document.uri.fsPath,
        editor.document.offsetAt(editor.selection.active),
        '未找到 {symbol} 的实现。'
      );
    }),

    vscode.commands.registerCommand('goNavigator.showImplementations', async (argument?: SymbolArgument) => {
      await service.whenReady();
      if (argument) {
        await showSymbolNavigation(service, argument.path, argument.offset, '未找到 {symbol} 的实现。');
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'go') {
        return;
      }
      await showSymbolNavigation(
        service,
        editor.document.uri.fsPath,
        editor.document.offsetAt(editor.selection.active),
        '未找到 {symbol} 的实现。'
      );
    }),

    vscode.commands.registerCommand('goNavigator.showInterfaces', async (argument?: SymbolArgument) => {
      await service.whenReady();
      if (argument) {
        await showSymbolNavigation(service, argument.path, argument.offset, '未找到 {symbol} 对应的接口。');
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'go') {
        return;
      }
      await showSymbolNavigation(
        service,
        editor.document.uri.fsPath,
        editor.document.offsetAt(editor.selection.active),
        '未找到 {symbol} 对应的接口。'
      );
    }),

    vscode.commands.registerCommand('goNavigator.reindex', async () => {
      await service.reindex();
    })
  );
}
