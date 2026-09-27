import { isExportStory, storyNameFromExport, toId } from 'storybook/internal/csf/csf-utils';
import type { IndexInput, IndexerOptions, IndexInputStats } from 'storybook/internal/types';

import { parseSync } from 'oxc-parser';

import { Tag } from '../shared/constants/tags.ts';

const MODULE_MOCK_REGEX = /^[.\/#].*\.mock($|\.[^.]*$)/i;

type AstNode = {
  type: string;
  [key: string]: any;
};

export type OxcCsfFallbackReason =
  | 'parse-error'
  | 'program-error'
  | 'import-source'
  | 'expression-statement'
  | 'export-all'
  | 'default-export'
  | 'named-export-specifier'
  | 'missing-meta'
  | 'meta-unsupported'
  | 'story-export'
  | 'named-exports-order'
  | 'story-unsupported';

export type OxcCsfIndexerDiagnostics = {
  fallbackReason?: OxcCsfFallbackReason;
};

type StoryDescriptor = string[] | RegExp;

type StaticMeta = {
  id?: string;
  title?: string;
  tags: string[];
  rawComponentPath?: string;
  includeStories?: StoryDescriptor;
  excludeStories?: StoryDescriptor;
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
  factory: boolean;
  play?: AstNode;
  playTagInjected: boolean;
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

const regexValue = (node: unknown, bindings: Map<string, AstNode>): RegExp | undefined => {
  const resolved = resolveBinding(node, bindings);
  if (!resolved) {
    return undefined;
  }

  if (
    resolved.type === 'RegExpLiteral' &&
    typeof resolved.pattern === 'string'
  ) {
    return new RegExp(resolved.pattern, resolved.flags ?? '');
  }

  if (
    resolved.type === 'Literal' &&
    resolved.regex &&
    typeof resolved.regex.pattern === 'string'
  ) {
    return new RegExp(resolved.regex.pattern, resolved.regex.flags ?? '');
  }

  return undefined;
};

const storyDescriptor = (
  node: unknown,
  bindings: Map<string, AstNode>
): StoryDescriptor | undefined => stringArray(node, bindings) ?? regexValue(node, bindings);

const isCanonicalCsf2BindCall = (node: AstNode) => {
  if (node.type !== 'CallExpression' || !isNode(node.callee)) {
    return false;
  }

  const callee = node.callee;
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    identifierName(callee.property) !== 'bind' ||
    !identifierName(callee.object)
  ) {
    return false;
  }

  const args = Array.isArray(node.arguments) ? node.arguments : [];
  if (args.length === 0) {
    return true;
  }

  return args.length === 1 && objectProperties(args[0])?.length === 0;
};

const findProperty = (node: unknown, name: string) =>
  objectProperties(node)?.find((property) => propertyName(property) === name);

const propertyValue = (property: AstNode | undefined) => property?.value;

const memberCall = (input: unknown) => {
  const node = unwrapExpression(input);
  if (!node || node.type !== 'CallExpression' || !isNode(node.callee)) {
    return undefined;
  }

  const callee = node.callee;
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    !isNode(callee.object) ||
    !isNode(callee.property)
  ) {
    return undefined;
  }

  const object = identifierName(callee.object);
  const method = identifierName(callee.property);
  return object && method ? { node, object, method } : undefined;
};

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
  factory: story.factory,
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
      const componentName = identifierName(propertyValue(property));
      if (componentName) {
        meta.rawComponentPath = importsByLocalName.get(componentName);
      }
    } else if (key === 'includeStories' || key === 'excludeStories') {
      const value = storyDescriptor(propertyValue(property), bindings);
      if (!value) {
        return null;
      }
      meta[key] = value;
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
  const rawNode = isNode(input) ? input : undefined;
  const node = unwrapExpression(input);
  if (!node) {
    return null;
  }

  const story: StaticStory = {
    exportName,
    name: storyNameFromExport(exportName),
    tags: [],
    annotations: new Set(),
    storyFn: ['ArrowFunctionExpression', 'FunctionDeclaration'].includes(node.type),
    factory: false,
    playTagInjected: false,
  };

  if (
    ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
  ) {
    return story;
  }

  // Babel only recognizes a direct bind call as canonical CSF2. A TS-wrapped bind remains a
  // registered story, but its storyFn stat is false.
  if (rawNode !== node && isCanonicalCsf2BindCall(node)) {
    return story;
  }

  if (rawNode === node && isCanonicalCsf2BindCall(node)) {
    const templateName = identifierName(node.callee.object);
    const template = templateName ? bindings.get(templateName) : undefined;
    const resolvedTemplate = template && unwrapExpression(template);
    if (
      !resolvedTemplate ||
      !['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
        resolvedTemplate.type
      )
    ) {
      return null;
    }
    story.storyFn = ['ArrowFunctionExpression', 'FunctionDeclaration'].includes(
      resolvedTemplate.type
    );
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
    story.playTagInjected = true;
  }

  return story;
};

const memberNames = (node: unknown) => {
  const resolved = unwrapExpression(node);
  if (
    !resolved ||
    resolved.type !== 'MemberExpression' ||
    resolved.computed ||
    !isNode(resolved.object) ||
    !isNode(resolved.property)
  ) {
    return undefined;
  }

  const object = identifierName(resolved.object);
  const property = identifierName(resolved.property);
  return object && property ? { object, property } : undefined;
};

const applyLegacyAnnotation = (
  story: StaticStory,
  key: string,
  value: unknown,
  bindings: Map<string, AstNode>
) => {
  if (key === 'story') {
    const properties = objectProperties(value);
    if (!properties) {
      story.annotations.add(key);
      return true;
    }

    for (const property of properties) {
      const nestedKey = propertyName(property);
      if (
        nestedKey &&
        !applyLegacyAnnotation(story, nestedKey, propertyValue(property), bindings)
      ) {
        return false;
      }
    }
    return true;
  }

  story.annotations.add(key);

  if (key === 'storyName') {
    const name = stringValue(resolveBinding(value, bindings));
    if (name !== undefined) {
      story.name = name;
    }
    return true;
  }

  if (key === 'tags') {
    const tags = stringArray(value, bindings);
    if (!tags) {
      return false;
    }
    story.tags = story.annotations.has('play') ? [...tags, Tag.PLAY_FN] : tags;
    story.playTagInjected = story.annotations.has('play');
    return true;
  }

  if (key === 'play') {
    story.play = unwrapExpression(value);
    if (!story.playTagInjected) {
      story.tags = [...story.tags, Tag.PLAY_FN];
      story.playTagInjected = true;
    }
  }

  return true;
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
  options: IndexerOptions,
  diagnostics?: OxcCsfIndexerDiagnostics
): IndexInput[] | null {
  const fallback = (reason: OxcCsfFallbackReason) => {
    if (diagnostics) {
      diagnostics.fallbackReason = reason;
    }
    return null;
  };
  let result: ReturnType<typeof parseSync>;
  try {
    result = parseSync(fileName, code);
  } catch {
    return fallback('parse-error');
  }

  if (result.errors.length > 0 || !result.program || !Array.isArray(result.program.body)) {
    return fallback('program-error');
  }

  const body = result.program.body as AstNode[];
  const bindings = new Map<string, AstNode>();
  const rawBindings = new Map<string, AstNode>();
  const previewImports = new Set<string>();
  const importsByLocalName = new Map<string, string>();
  const importSources: string[] = [];

  for (const statement of body) {
    if (statement.type === 'ImportDeclaration') {
      const source = stringValue(statement.source);
      if (!source) {
        return fallback('import-source');
      }
      importSources.push(source);
      for (const specifier of statement.specifiers ?? []) {
        const localName = identifierName(specifier.local);
        if (localName) {
          importsByLocalName.set(localName, source);
          if (source.includes('.storybook/preview')) {
            previewImports.add(localName);
          }
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
        const rawInit = isNode(declarator.init) ? declarator.init : undefined;
        const init = unwrapExpression(declarator.init);
        if (name && rawInit) {
          rawBindings.set(name, rawInit);
        }
        if (name && init) {
          bindings.set(name, init);
        }
      }
    } else if (declaration.type === 'FunctionDeclaration') {
      const name = identifierName(declaration.id);
      if (name) {
        bindings.set(name, declaration);
      }
    }
  }

  let metaNode: AstNode | undefined;
  for (const statement of body) {
    if (statement.type === 'ExportAllDeclaration') {
      return fallback('export-all');
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = resolveBinding(statement.declaration, bindings);
      if (!declaration || declaration.type !== 'ObjectExpression') {
        return fallback('default-export');
      }
      metaNode = declaration;
    }

    if (
      statement.type === 'ExportNamedDeclaration' &&
      Array.isArray(statement.specifiers) &&
      statement.specifiers.length > 0
    ) {
      return fallback('named-export-specifier');
    }
  }

  let factoryMetaName: string | undefined;

  if (!metaNode) {
    for (const [name, rawInit] of rawBindings) {
      const call = memberCall(rawInit);
      if (!call || call.method !== 'meta' || !previewImports.has(call.object)) {
        continue;
      }

      const argument = Array.isArray(call.node.arguments)
        ? unwrapExpression(call.node.arguments[0])
        : undefined;
      if (!argument || argument.type !== 'ObjectExpression') {
        return fallback('meta-unsupported');
      }

      metaNode = argument;
      factoryMetaName = name;
      break;
    }
  }

  if (!metaNode) {
    return fallback('missing-meta');
  }

  const meta = parseMeta(metaNode, bindings, importsByLocalName);
  if (!meta) {
    return fallback('meta-unsupported');
  }

  meta.title = options.makeTitle(meta.title);
  const moduleMock = importSources.some((source) => MODULE_MOCK_REGEX.test(source));

  const stories: StaticStory[] = [];
  const storyByExportName = new Map<string, StaticStory>();

  for (const statement of body) {
    if (statement.type === 'ExportNamedDeclaration' && isNode(statement.declaration)) {
      const declaration = statement.declaration;

      if (declaration.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations ?? []) {
          const exportName = identifierName(declarator.id);
          if (!exportName) {
            return fallback('story-export');
          }
          if (exportName === '__namedExportsOrder') {
            return fallback('named-exports-order');
          }

          const story = parseStory(exportName, declarator.init, bindings);
          if (!story) {
            return fallback('story-unsupported');
          }

          stories.push(story);
          storyByExportName.set(exportName, story);
        }
      } else if (declaration.type === 'FunctionDeclaration') {
        const exportName = identifierName(declaration.id);
        if (!exportName) {
          return fallback('story-export');
        }

        const story = parseStory(exportName, declaration, bindings);
        if (!story) {
          return fallback('story-unsupported');
        }

        stories.push(story);
        storyByExportName.set(exportName, story);
      }

      continue;
    }

    if (statement.type !== 'ExpressionStatement') {
      continue;
    }

    const expression = unwrapExpression(statement.expression);
    if (!expression) {
      continue;
    }

    if (expression.type === 'CallExpression') {
      const callee = memberNames(expression.callee);
      if (callee?.property === 'test' && storyByExportName.has(callee.object)) {
        return fallback('expression-statement');
      }
      continue;
    }

    if (expression.type !== 'AssignmentExpression') {
      continue;
    }

    const target = memberNames(expression.left);
    if (!target) {
      continue;
    }

    const story = storyByExportName.get(target.object);
    if (!story) {
      continue;
    }

    if (!applyLegacyAnnotation(story, target.property, expression.right, bindings)) {
      return fallback('expression-statement');
    }
  }

  const metaForFilter = {
    includeStories: meta.includeStories,
    excludeStories: meta.excludeStories,
  };

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
