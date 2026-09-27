import { isExportStory, storyNameFromExport, toId } from 'storybook/internal/csf/csf-utils';
import type { IndexInput, IndexerOptions, IndexInputStats } from 'storybook/internal/types';

import { parseSync } from 'oxc-parser';

import { Tag } from '../shared/constants/tags.ts';

const MODULE_MOCK_REGEX = /^[.\/#].*\.mock($|\.[^.]*$)/i;

type AstNode = {
  type: string;
  [key: string]: any;
};

type StaticMeta = {
  id?: string;
  title?: string;
  tags: string[];
  rawComponentPath?: string;
  annotations: Set<string>;
  play?: AstNode;
};

type StaticStory = {
  exportName: string;
  name: string;
  tags: string[];
  customId?: string;
  annotations: Set<string>;
  storyFn: boolean;
  play?: AstNode;
};

const isNode = (value: unknown): value is AstNode =>
  !!value && typeof value === 'object' && typeof (value as AstNode).type === 'string';

const unwrapExpression = (input: unknown): AstNode | undefined => {
  if (!isNode(input)) {
    return undefined;
  }

  let node = input;
  while (
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'ParenthesizedExpression',
      'ChainExpression',
    ].includes(node.type)
  ) {
    if (!isNode(node.expression)) {
      return undefined;
    }
    node = node.expression;
  }

  return node;
};

const identifierName = (node: unknown) =>
  isNode(node) && node.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : undefined;

const stringValue = (input: unknown) => {
  const node = unwrapExpression(input);
  if (!node) {
    return undefined;
  }

  if (
    (node.type === 'Literal' || node.type === 'StringLiteral') &&
    typeof node.value === 'string'
  ) {
    return node.value;
  }

  return undefined;
};

const propertyName = (property: AstNode) => {
  if (!['Property', 'ObjectProperty'].includes(property.type) || property.computed) {
    return undefined;
  }

  return identifierName(property.key) ?? stringValue(property.key);
};

const objectProperties = (input: unknown): AstNode[] | undefined => {
  const node = unwrapExpression(input);
  if (!node || node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) {
    return undefined;
  }

  return node.properties.filter(
    (property: unknown): property is AstNode =>
      isNode(property) && ['Property', 'ObjectProperty'].includes(property.type)
  );
};

const resolveBinding = (node: unknown, bindings: Map<string, AstNode>) => {
  const unwrapped = unwrapExpression(node);
  const name = identifierName(unwrapped);
  return name ? unwrapExpression(bindings.get(name)) : unwrapped;
};

const stringArray = (node: unknown, bindings: Map<string, AstNode>): string[] | undefined => {
  const resolved = resolveBinding(node, bindings);
  if (!resolved || resolved.type !== 'ArrayExpression' || !Array.isArray(resolved.elements)) {
    return undefined;
  }

  const values: string[] = [];
  for (const element of resolved.elements) {
    const value = stringValue(element);
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }

  return values;
};

const findProperty = (node: unknown, name: string) =>
  objectProperties(node)?.find((property) => propertyName(property) === name);

const propertyValue = (property: AstNode | undefined) => property?.value;

const hasMount = (input: unknown) => {
  const node = unwrapExpression(input);
  if (
    !node ||
    !['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type) ||
    !Array.isArray(node.params) ||
    node.params.length === 0
  ) {
    return false;
  }

  const [first] = node.params;
  if (!isNode(first) || first.type !== 'ObjectPattern' || !Array.isArray(first.properties)) {
    return false;
  }

  return first.properties.some(
    (property: unknown) =>
      isNode(property) &&
      ['Property', 'ObjectProperty'].includes(property.type) &&
      propertyName(property) === 'mount'
  );
};

const annotationStats = (
  story: StaticStory,
  meta: StaticMeta,
  moduleMock: boolean
): IndexInputStats => ({
  factory: false,
  play: story.annotations.has('play') || meta.annotations.has('play'),
  render: story.annotations.has('render') || meta.annotations.has('render'),
  loaders: story.annotations.has('loaders') || meta.annotations.has('loaders'),
  beforeEach: story.annotations.has('beforeEach') || meta.annotations.has('beforeEach'),
  globals: story.annotations.has('globals') || meta.annotations.has('globals'),
  tags: story.annotations.has('tags') || meta.annotations.has('tags'),
  storyFn: story.storyFn,
  mount: hasMount(story.play ?? meta.play),
  moduleMock,
});

const parseMeta = (
  node: AstNode,
  bindings: Map<string, AstNode>,
  importsByLocalName: Map<string, string>
): StaticMeta | null => {
  const properties = objectProperties(node);
  if (!properties) {
    return null;
  }

  const meta: StaticMeta = {
    tags: [],
    annotations: new Set(),
  };

  for (const property of properties) {
    const key = propertyName(property);
    if (!key) {
      continue;
    }

    meta.annotations.add(key);

    if (key === 'title') {
      const value = stringValue(resolveBinding(propertyValue(property), bindings));
      if (value === undefined) {
        return null;
      }
      meta.title = value;
    } else if (key === 'id') {
      const value = stringValue(resolveBinding(propertyValue(property), bindings));
      if (value === undefined) {
        return null;
      }
      meta.id = value;
    } else if (key === 'tags') {
      const value = stringArray(propertyValue(property), bindings);
      if (!value) {
        return null;
      }
      meta.tags = value;
    } else if (key === 'component') {
      const componentName = identifierName(unwrapExpression(propertyValue(property)));
      if (componentName) {
        meta.rawComponentPath = importsByLocalName.get(componentName);
      }
    } else if (key === 'includeStories' || key === 'excludeStories') {
      // Filtering semantics are subtle; keep the Babel implementation as the oracle for now.
      return null;
    } else if (key === 'play') {
      meta.play = unwrapExpression(propertyValue(property));
    }
  }

  if (meta.annotations.has('play')) {
    meta.tags = [...meta.tags, Tag.PLAY_FN];
  }

  return meta;
};

const parseStory = (
  exportName: string,
  input: unknown,
  bindings: Map<string, AstNode>
): StaticStory | null => {
  const node = unwrapExpression(input);
  if (!node) {
    return null;
  }

  const story: StaticStory = {
    exportName,
    name: storyNameFromExport(exportName),
    tags: [],
    annotations: new Set(),
    storyFn: ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
      node.type
    ),
  };

  if (story.storyFn) {
    return story;
  }

  const properties = objectProperties(node);
  if (!properties) {
    return null;
  }

  for (const property of properties) {
    const key = propertyName(property);
    if (!key) {
      continue;
    }

    story.annotations.add(key);

    if (key === 'name') {
      const value = stringValue(resolveBinding(propertyValue(property), bindings));
      if (value === undefined) {
        return null;
      }
      story.name = value;
    } else if (key === 'tags') {
      const value = stringArray(propertyValue(property), bindings);
      if (!value) {
        return null;
      }
      story.tags = value;
    } else if (key === 'parameters') {
      const parameters = resolveBinding(propertyValue(property), bindings);
      const idProperty = findProperty(parameters, '__id');
      if (idProperty) {
        const value = stringValue(resolveBinding(propertyValue(idProperty), bindings));
        if (value === undefined) {
          return null;
        }
        story.customId = value;
      }
    } else if (key === 'play') {
      story.play = unwrapExpression(propertyValue(property));
    }
  }

  if (story.annotations.has('play')) {
    story.tags = [...story.tags, Tag.PLAY_FN];
  }

  return story;
};

/**
 * Read-only CSF indexer fast path backed by OXC.
 *
 * This intentionally supports only statically analyzable CSF 1-3 shapes. Returning null means
 * "unsupported by the fast path" and lets the caller fall back to the existing Babel/CsfFile
 * implementation, which remains the compatibility oracle.
 */
export function indexCsfWithOxc(
  code: string,
  fileName: string,
  options: IndexerOptions
): IndexInput[] | null {
  let result: ReturnType<typeof parseSync>;
  try {
    result = parseSync(fileName, code);
  } catch {
    return null;
  }

  if (result.errors.length > 0 || !result.program || !Array.isArray(result.program.body)) {
    return null;
  }

  const body = result.program.body as AstNode[];
  const bindings = new Map<string, AstNode>();
  const importsByLocalName = new Map<string, string>();
  const importSources: string[] = [];

  for (const statement of body) {
    if (statement.type === 'ImportDeclaration') {
      const source = stringValue(statement.source);
      if (!source) {
        return null;
      }
      importSources.push(source);
      for (const specifier of statement.specifiers ?? []) {
        const localName = identifierName(specifier.local);
        if (localName) {
          importsByLocalName.set(localName, source);
        }
      }
      continue;
    }

    const declaration =
      statement.type === 'ExportNamedDeclaration' && isNode(statement.declaration)
        ? statement.declaration
        : statement;

    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations ?? []) {
        const name = identifierName(declarator.id);
        const init = unwrapExpression(declarator.init);
        if (name && init) {
          bindings.set(name, init);
        }
      }
    }
  }

  let metaNode: AstNode | undefined;
  for (const statement of body) {
    if (statement.type === 'ExpressionStatement') {
      // Covers CSF2 assignment annotations and CSF test syntax. Keep Babel semantics for now.
      return null;
    }

    if (statement.type === 'ExportAllDeclaration') {
      return null;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = resolveBinding(statement.declaration, bindings);
      if (!declaration || declaration.type !== 'ObjectExpression') {
        return null;
      }
      metaNode = declaration;
    }

    if (
      statement.type === 'ExportNamedDeclaration' &&
      Array.isArray(statement.specifiers) &&
      statement.specifiers.length > 0
    ) {
      // Includes `export { X }` and re-export forms. They need local/export binding resolution.
      return null;
    }
  }

  if (!metaNode) {
    return null;
  }

  const meta = parseMeta(metaNode, bindings, importsByLocalName);
  if (!meta) {
    return null;
  }

  meta.title = options.makeTitle(meta.title);
  const moduleMock = importSources.some((source) => MODULE_MOCK_REGEX.test(source));

  const stories: StaticStory[] = [];
  for (const statement of body) {
    if (statement.type !== 'ExportNamedDeclaration' || !isNode(statement.declaration)) {
      continue;
    }

    const declaration = statement.declaration;
    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations ?? []) {
        const exportName = identifierName(declarator.id);
        if (!exportName) {
          return null;
        }
        if (exportName === '__namedExportsOrder') {
          return null;
        }
        const story = parseStory(exportName, declarator.init, bindings);
        if (!story) {
          return null;
        }
        stories.push(story);
      }
    } else if (declaration.type === 'FunctionDeclaration') {
      const exportName = identifierName(declaration.id);
      if (!exportName) {
        return null;
      }
      const story = parseStory(exportName, declaration, bindings);
      if (!story) {
        return null;
      }
      stories.push(story);
    }
  }

  const metaForFilter = {
    id: meta.id,
    title: meta.title,
  } as Parameters<typeof isExportStory>[1];

  return stories
    .filter((story) => isExportStory(story.exportName, metaForFilter))
    .map((story) => {
      const id =
        story.customId ??
        toId((meta.id || meta.title) as string, storyNameFromExport(story.exportName));

      return {
        rawComponentPath: meta.rawComponentPath,
        exportName: story.exportName,
        title: meta.title,
        metaId: meta.id,
        tags: [...meta.tags, ...story.tags],
        __id: id,
        __stats: annotationStats(story, meta, moduleMock),
        type: 'story',
        subtype: 'story',
        name: story.name,
      } satisfies IndexInput;
    });
}
