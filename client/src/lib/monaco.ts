import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

/** Monaco's own language registry, matched on file extension. */
export function languageForPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const extension = filePath.slice(dot).toLowerCase();
  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.some((candidate) => candidate.toLowerCase() === extension)) {
      return language.id;
    }
  }
  return 'plaintext';
}

export { monaco };
