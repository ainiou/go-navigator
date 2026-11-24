import * as vscode from 'vscode';
import { GoIndex } from '../go/index';
import { SourceLocation } from '../go/model';
import { offsetToLineChar } from '../go/text';

export function toLocation(index: GoIndex, location: SourceLocation): vscode.Location {
  const target = index.getFile(location.path);
  const uri = vscode.Uri.file(location.path);
  if (!target) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
  const start = offsetToLineChar(target.lineStarts, location.start);
  const end = offsetToLineChar(target.lineStarts, location.end);
  return new vscode.Location(uri, new vscode.Range(start.line, start.character, end.line, end.character));
}
