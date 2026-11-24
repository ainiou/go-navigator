import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { GoCodeLensProvider } from './vscode/codeLens';
import { GoDefinitionProvider, GoImplementationProvider } from './vscode/providers';
import { GoIndexService } from './vscode/service';

export function activate(context: vscode.ExtensionContext): void {
  const service = new GoIndexService();
  context.subscriptions.push(service);

  const codeLensProvider = new GoCodeLensProvider(service);
  service.setUpdateNotifier(() => codeLensProvider.refresh());

  const selector: vscode.DocumentFilter[] = [
    { language: 'go', scheme: 'file' },
    { language: 'go', scheme: 'untitled' }
  ];

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new GoDefinitionProvider(service)),
    vscode.languages.registerImplementationProvider(selector, new GoImplementationProvider(service)),
    vscode.languages.registerCodeLensProvider(selector, codeLensProvider),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('goNavigator.enableCodeLens')) {
        codeLensProvider.refresh();
      }
      if (
        event.affectsConfiguration('goNavigator.exclude') ||
        event.affectsConfiguration('goNavigator.indexVendor') ||
        event.affectsConfiguration('goNavigator.maxFileSizeKB')
      ) {
        void service.reindex();
      }
    })
  );

  registerCommands(context, service);

  // 后台建立索引，不阻塞扩展激活
  void service.initialize();
}

export function deactivate(): void {
  // 资源由 context.subscriptions 统一释放
}
