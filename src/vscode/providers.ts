import * as vscode from 'vscode';
import { GoIndexService } from './service';
import { toLocation } from './convert';

export class GoImplementationProvider implements vscode.ImplementationProvider {
  constructor(private readonly service: GoIndexService) {}

  async provideImplementation(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[] | undefined> {
    await this.service.whenReady();
    const file = this.service.getFileForDocument(document);
    if (!file) {
      return undefined;
    }
    const locations = this.service.index.findImplementationsForRegistration(
      file,
      document.offsetAt(position)
    );
    if (locations.length === 0) {
      return undefined;
    }
    return locations.map(location => toLocation(this.service.index, location));
  }
}
