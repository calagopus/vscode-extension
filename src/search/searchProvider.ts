import * as vscode from 'vscode';
import { ApiError } from '../api/client.ts';
import type { ContentMatches, FileSearchFilters, FileSearchResponse } from '../api/types.ts';
import { decodeAuthority } from '../fs/fileSystemProvider.ts';
import type { Session } from '../session.ts';

const CONTENT_SEARCH_SIZE = Number.MAX_SAFE_INTEGER;
const CONTEXT_MAX_MATCHES = 100;

export function toGitGlobs(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]*)\}/);
  if (!match) {
    return [pattern];
  }

  return match[1]
    .split(',')
    .flatMap((alt) => toGitGlobs(pattern.slice(0, match.index) + alt + pattern.slice(match.index! + match[0].length)));
}

function serverRelative(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function anchorGlob(base: string, glob: string, always: boolean): string {
  const unanchored = glob.startsWith('**/') || !glob.replace(/\/+$/, '').includes('/');
  if (!always && unanchored) {
    return glob;
  }

  const relative = glob.replace(/^\/+/, '');
  return base ? `${base}/${relative}` : `/${relative}`;
}

function serverGlobs(folder: vscode.Uri, glob: vscode.GlobPattern): string[] {
  if (typeof glob === 'string') {
    return toGitGlobs(glob).map((g) => anchorGlob(serverRelative(folder.path), g, false));
  }
  if (glob.baseUri.scheme !== folder.scheme || glob.baseUri.authority !== folder.authority) {
    return [];
  }

  return toGitGlobs(glob.pattern).map((g) => anchorGlob(serverRelative(glob.baseUri.path), g, true));
}

function joinRoot(root: string, relative: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  return base + relative.replace(/^\/+/, '');
}

async function searchServer(
  session: Session,
  folder: vscode.Uri,
  filters: FileSearchFilters,
): Promise<FileSearchResponse> {
  const { origin, server } = decodeAuthority(folder.authority);
  const client = await session.client(origin);
  try {
    return await client.searchFiles(server, filters);
  } catch (err) {
    if (err instanceof ApiError && err.status === 417) {
      throw new Error(
        `Calagopus: the server rejected an exclude pattern (from your exclude settings or a subuser ignore rule): ${err.message}`,
      );
    }
    throw err;
  }
}

export class CalagopusFileSearchProvider implements vscode.FileSearchProvider2 {
  constructor(private readonly session: Session) {}

  async provideFileSearchResults(
    pattern: string,
    options: vscode.FileSearchProviderOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.Uri[]> {
    const results: vscode.Uri[] = [];
    const needle = pattern.toLowerCase();

    for (const folder of options.folderOptions) {
      if (token.isCancellationRequested || results.length >= options.maxResults) {
        break;
      }
      if (folder.folder.scheme !== 'calagopus') {
        continue;
      }

      const root = folder.folder.path || '/';
      const includes = folder.includes.flatMap((glob) => serverGlobs(folder.folder, glob));
      const filterLocally = pattern !== '' && includes.length > 0;
      const include = filterLocally
        ? includes
        : pattern
          ? [pattern.includes('/') ? `**/*${pattern}*` : `*${pattern}*`]
          : ['**'];

      const { entries } = await searchServer(this.session, folder.folder, {
        root,
        path_filter: {
          include,
          exclude: folder.excludes.flatMap((glob) => serverGlobs(folder.folder, glob)),
          case_insensitive: true,
        },
        size_filter: null,
        content_filter: null,
      });

      for (const entry of entries) {
        if (!entry.file) {
          continue;
        }
        if (filterLocally) {
          const name = entry.name.toLowerCase();
          const haystack = pattern.includes('/') ? name : name.slice(name.lastIndexOf('/') + 1);
          if (!haystack.includes(needle)) {
            continue;
          }
        }
        results.push(folder.folder.with({ path: joinRoot(root, entry.name) }));
        if (results.length >= options.maxResults) {
          break;
        }
      }
    }

    return results;
  }
}

export class CalagopusTextSearchProvider implements vscode.TextSearchProvider2 {
  constructor(private readonly session: Session) {}

  async provideTextSearchResults(
    query: vscode.TextSearchQuery2,
    options: vscode.TextSearchProviderOptions,
    progress: vscode.Progress<vscode.TextSearchResult2>,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextSearchComplete2> {
    if (query.isRegExp) {
      throw new Error('Calagopus: regular expression search is not supported, turn off regex mode.');
    }

    let limitHit = false;
    let reported = 0;

    for (const folder of options.folderOptions) {
      if (token.isCancellationRequested) {
        break;
      }
      if (folder.folder.scheme !== 'calagopus') {
        continue;
      }

      const root = folder.folder.path || '/';
      const includes = folder.includes.flatMap((glob) => serverGlobs(folder.folder, glob));
      const excludes = folder.excludes.flatMap((glob) => serverGlobs(folder.folder, glob));

      const { entries, content_matches } = await this.search(folder.folder, {
        root,
        path_filter:
          includes.length > 0 || excludes.length > 0
            ? { include: includes, exclude: excludes, case_insensitive: true }
            : null,
        size_filter: null,
        content_filter: {
          query: query.pattern,
          max_search_size: CONTENT_SEARCH_SIZE,
          include_unmatched: false,
          case_insensitive: !query.isCaseSensitive,
        },
        match_context: {
          before: 0,
          after: 0,
          max_matches: Math.max(1, Math.min(options.maxResults, CONTEXT_MAX_MATCHES)),
        },
      });
      if (!content_matches) {
        throw new Error('Calagopus: the node running this server is too old for content search.');
      }

      const contentMatches = new Map(content_matches.map((matches) => [matches.file, matches]));

      for (const entry of entries) {
        if (token.isCancellationRequested || reported >= options.maxResults) {
          limitHit = limitHit || reported >= options.maxResults;
          break;
        }

        const context = contentMatches.get(entry.name);
        if (!entry.file || !context) {
          continue;
        }

        limitHit = limitHit || context.truncated;
        const uri = folder.folder.with({ path: joinRoot(root, entry.name) });
        for (const match of contextMatches(uri, context, query, options)) {
          progress.report(match);
          if (++reported >= options.maxResults) {
            limitHit = true;
            break;
          }
        }
      }
    }

    return { limitHit };
  }

  private async search(folder: vscode.Uri, filters: FileSearchFilters): Promise<FileSearchResponse> {
    try {
      return await searchServer(this.session, folder, filters);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        throw new Error('Calagopus: content search needs the files.read-content permission on this server.');
      }
      if (err instanceof ApiError && err.status === 400) {
        throw new Error(`Calagopus: content search was refused: ${err.message}`);
      }
      throw err;
    }
  }
}

function lineMatch(
  uri: vscode.Uri,
  line: string,
  lineNo: number,
  start: number,
  end: number,
  options: vscode.TextSearchProviderOptions,
): vscode.TextSearchMatch2 {
  const maxPreview = options.previewOptions?.charsPerLine ?? 250;
  return new vscode.TextSearchMatch2(
    uri,
    [
      {
        sourceRange: new vscode.Range(lineNo, start, lineNo, end),
        previewRange: new vscode.Range(0, Math.min(start, maxPreview), 0, Math.min(end, maxPreview)),
      },
    ],
    line.slice(0, maxPreview),
  );
}

function contextMatches(
  uri: vscode.Uri,
  context: ContentMatches,
  query: vscode.TextSearchQuery2,
  options: vscode.TextSearchProviderOptions,
): vscode.TextSearchMatch2[] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const out: vscode.TextSearchMatch2[] = [];

  for (const block of context.blocks) {
    const bytes = encoder.encode(block.content);
    const lineStarts = [0];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a) {
        lineStarts.push(i + 1);
      }
    }

    const position = (byte: number): [number, number] => {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= byte) {
        line++;
      }
      return [line, decoder.decode(bytes.subarray(lineStarts[line], byte)).length];
    };
    const lineText = (line: number) =>
      decoder.decode(bytes.subarray(lineStarts[line], lineStarts[line + 1] ?? bytes.length)).replace(/\r?\n$/, '');

    for (const span of block.matches) {
      const [startLine, startCol] = position(span.start_byte);
      const [endLine, endCol] = position(span.end_byte);
      const line = lineText(startLine);
      const lineNo = block.start_line - 1 + startLine;

      if (startLine === endLine) {
        if (!query.isWordMatch || isWordBounded(line, startCol, endCol)) {
          out.push(lineMatch(uri, line, lineNo, startCol, endCol, options));
        }
        continue;
      }

      const lastLine = lineText(endLine);
      if (query.isWordMatch && !(isWordBounded(line, startCol, line.length) && isWordBounded(lastLine, 0, endCol))) {
        continue;
      }

      const preview = Array.from({ length: endLine - startLine + 1 }, (_, i) => lineText(startLine + i)).join('\n');
      out.push(
        new vscode.TextSearchMatch2(
          uri,
          [
            {
              sourceRange: new vscode.Range(lineNo, startCol, block.start_line - 1 + endLine, endCol),
              previewRange: new vscode.Range(0, startCol, endLine - startLine, endCol),
            },
          ],
          preview,
        ),
      );
    }
  }

  return out;
}

function isWordBounded(line: string, start: number, end: number): boolean {
  const isWord = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);
  return !isWord(line[start - 1]) && !isWord(line[end]);
}
