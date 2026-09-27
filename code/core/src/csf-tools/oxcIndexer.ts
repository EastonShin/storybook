import { isExportStory, storyNameFromExport, toId } from 'storybook/internal/csf/csf-utils';
import type { IndexInput, IndexerOptions, IndexInputStats } from 'storybook/internal/types';

import { parseSync } from 'oxc-parser';

import { Tag } from '../shared/constants/tags.ts';

const MODULE_MOCK_REGEX = /^[.\/#].*\.mock($|\.[^.]*$)/i;

const WRAPPER_TYPES = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'ParenthesizedExpression',
  'ChainExpression',
]);

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
]);

type AstNode = {
  type: string;
  [key: string]: any;
};

type Bindings = Map<string, AstNode>;

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

type Annotated = {
  tags: string[];
  annotations: Set<string>;
  play?: AstNode;
};

type StaticMeta = Annotated & {
  id?: string;
  title?: string;
  rawComponentPath?: string;
  includeStories?: string[] | RegExp;
  excludeStories?: string[] | RegExp;
};

type StaticStory = Annotated & {
  exportName: string;
  name: string;
  customId?: string;
  storyFn: boolean;
  factory: boolean;
};

class OxcFallback extends Error {
  constructor(readonly reason: OxcCsfFallbackReason) {
    super(reason);
  }
}

function fallback(reason: OxcCsfFallbackReason): never {
  throw new OxcFallback(reason);
}

const isNode = (value: unknown): value is AstNode =>
  !!value && typeof value === 'object' && typeof (value as AstNode).type === 'string';

const unwrapExpression = (input: unknown): AstNode | undefined => {
  let node = isNode(input) ? input : undefined;
  while (node && WRAPPER_TYPES.has(node.type)) {
    node = node.expression;
  }
  return node;
};

const isStoryFn = (node: AstNode) =>
  node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration';

const identifierName = (node: AstNode | undefined): string | undefined =>
  node?.type === 'Identifier' ? node.name : undefined;

const stringValue = (input: unknown): string | undefined => {
  const node = unwrapExpression(input);
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
};

const propertyName = (property: AstNode) =>
  property.type === 'Property' && !property.computed
    ? (identifierName(property.key) ?? stringValue(property.key))
    : undefined;

const objectProperties = (input: unknown): AstNode[] | undefined => {
  const node = unwrapExpression(input);
  return node?.type === 'ObjectExpression'
    ? node.properties.filter((property: AstNode) => property.type === 'Property')
    : undefined;
};

const resolveBinding = (input: unknown, bindings: Bindings) => {
  const node = unwrapExpression(input);
  const name = identifierName(node);
  return name ? unwrapExpression(bindings.get(name)) : node;
};

const boundString = (input: unknown, bindings: Bindings) =>
  stringValue(resolveBinding(input, bindings));

const stringArray = (input: unknown, bindings: Bindings): string[] | undefined => {
  const array = resolveBinding(input, bindings);
  if (array?.type !== 'ArrayExpression') {
    return undefined;
  }
  const values: (string | undefined)[] = array.elements.map(stringValue);
  return values.every((value): value is string => value !== undefined) ? values : undefined;
};

const regexValue = (input: unknown, bindings: Bindings) => {
  const regex = resolveBinding(input, bindings)?.regex;
  return regex ? new RegExp(regex.pattern, regex.flags) : undefined;
};

const memberNames = (input: unknown) => {
  const node = unwrapExpression(input);
  if (node?.type !== 'MemberExpression' || node.computed) {
    return undefined;
  }
  const object = identifierName(node.object);
  const property = identifierName(node.property);
  return object && property ? { object, property } : undefined;
};

const memberCall = (input: unknown) => {
  const node = unwrapExpression(input);
  if (node?.type !== 'CallExpression') {
    return undefined;
  }
  const callee = memberNames(node.callee);
  return callee && { object: callee.object, method: callee.property, args: node.arguments };
};

const isEmptyBindArgs = (args: unknown[]) =>
  args.length === 0 || (args.length === 1 && objectProperties(args[0])?.length === 0);

const hasMount = (input: unknown) => {
  const node = unwrapExpression(input);
  const [first] = node && FUNCTION_TYPES.has(node.type) ? node.params : [];
  return (
    first?.type === 'ObjectPattern' &&
    first.properties.some((property: AstNode) => propertyName(property) === 'mount')
  );
};

const withPlayTag = ({ tags, annotations }: Annotated) =>
  annotations.has('play') ? [...tags, Tag.PLAY_FN] : tags;

const indexStats = (story: StaticStory, meta: StaticMeta, moduleMock: boolean): IndexInputStats => {
  const has = (key: string) => story.annotations.has(key) || meta.annotations.has(key);
  return {
    factory: story.factory,
    play: has('play'),
    render: has('render'),
    loaders: has('loaders'),
    beforeEach: has('beforeEach'),
    globals: has('globals'),
    tags: has('tags'),
    storyFn: story.storyFn,
    mount: hasMount(story.play ?? meta.play),
    moduleMock,
  };
};

const parseMeta = (node: AstNode, bindings: Bindings, imports: Map<string, string>) => {
  const meta: StaticMeta = { tags: [], annotations: new Set() };

  for (const property of objectProperties(node) ?? []) {
    const key = propertyName(property);
    if (!key) {
      continue;
    }
    meta.annotations.add(key);

    if (key === 'title' || key === 'id') {
      meta[key] = boundString(property.value, bindings) ?? fallback('meta-unsupported');
    } else if (key === 'tags') {
      meta.tags = stringArray(property.value, bindings) ?? fallback('meta-unsupported');
    } else if (key === 'component') {
      const componentName = identifierName(property.value);
      meta.rawComponentPath = componentName && imports.get(componentName);
    } else if (key === 'includeStories' || key === 'excludeStories') {
      meta[key] =
        stringArray(property.value, bindings) ??
        regexValue(property.value, bindings) ??
        fallback('meta-unsupported');
    } else if (key === 'play') {
      meta.play = unwrapExpression(property.value);
    }
  }

  return meta;
};

const parseStory = (exportName: string, input: unknown, bindings: Bindings) => {
  const node = unwrapExpression(input) ?? fallback('story-unsupported');
  const story: StaticStory = {
    exportName,
    name: storyNameFromExport(exportName),
    tags: [],
    annotations: new Set(),
    storyFn: isStoryFn(node),
    factory: false,
  };

  if (FUNCTION_TYPES.has(node.type)) {
    return story;
  }

  const call = memberCall(node);
  if (call?.method === 'bind' && isEmptyBindArgs(call.args)) {
    // Babel only treats an unwrapped `Template.bind({})` as CSF2, so a cast bind keeps storyFn false.
    if (node === input) {
      const template = unwrapExpression(bindings.get(call.object));
      if (!template || !FUNCTION_TYPES.has(template.type)) {
        fallback('story-unsupported');
      }
      story.storyFn = isStoryFn(template);
    }
    return story;
  }

  for (const property of objectProperties(node) ?? fallback('story-unsupported')) {
    const key = propertyName(property);
    if (!key) {
      continue;
    }
    story.annotations.add(key);

    if (key === 'name') {
      story.name = boundString(property.value, bindings) ?? fallback('story-unsupported');
    } else if (key === 'tags') {
      story.tags = stringArray(property.value, bindings) ?? fallback('story-unsupported');
    } else if (key === 'parameters') {
      const idProperty = objectProperties(resolveBinding(property.value, bindings))?.find(
        (parameter) => propertyName(parameter) === '__id'
      );
      if (idProperty) {
        story.customId = boundString(idProperty.value, bindings) ?? fallback('story-unsupported');
      }
    } else if (key === 'play') {
      story.play = unwrapExpression(property.value);
    }
  }

  return story;
};

const applyLegacyAnnotation = (
  story: StaticStory,
  key: string,
  value: unknown,
  bindings: Bindings
): void => {
  const nested = key === 'story' ? objectProperties(value) : undefined;
  if (nested) {
    for (const property of nested) {
      const nestedKey = propertyName(property);
      if (nestedKey) {
        applyLegacyAnnotation(story, nestedKey, property.value, bindings);
      }
    }
    return;
  }

  story.annotations.add(key);

  if (key === 'storyName') {
    story.name = boundString(value, bindings) ?? story.name;
  } else if (key === 'tags') {
    story.tags = stringArray(value, bindings) ?? fallback('expression-statement');
  } else if (key === 'play') {
    story.play = unwrapExpression(value);
  }
};

const indexStaticCsf = (code: string, fileName: string, options: IndexerOptions) => {
  let result: ReturnType<typeof parseSync>;
  try {
    result = parseSync(fileName, code);
  } catch {
    return fallback('parse-error');
  }
  if (result.errors.length > 0) {
    fallback('program-error');
  }

  const body = result.program.body as AstNode[];
  const bindings: Bindings = new Map();
  const imports = new Map<string, string>();
  let moduleMock = false;
  let defaultExport: AstNode | undefined;

  for (const statement of body) {
    if (statement.type === 'ImportDeclaration') {
      const source = stringValue(statement.source) || fallback('import-source');
      moduleMock ||= MODULE_MOCK_REGEX.test(source);
      for (const specifier of statement.specifiers) {
        imports.set(specifier.local.name, source);
      }
      continue;
    }
    if (statement.type === 'ExportAllDeclaration') {
      fallback('export-all');
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      defaultExport = statement.declaration;
      continue;
    }
    if (statement.type === 'ExportNamedDeclaration' && statement.specifiers.length > 0) {
      fallback('named-export-specifier');
    }

    const declaration: AstNode | null =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') {
      for (const { id, init } of declaration.declarations) {
        const name = identifierName(id);
        if (name && isNode(init)) {
          bindings.set(name, init);
        }
      }
    } else if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      bindings.set(declaration.id.name, declaration);
    }
  }

  let metaNode: AstNode | undefined;
  let factoryMetaName: string | undefined;

  if (defaultExport) {
    metaNode = resolveBinding(defaultExport, bindings);
    if (metaNode?.type !== 'ObjectExpression') {
      fallback('default-export');
    }
  } else {
    for (const [name, init] of bindings) {
      const call = memberCall(init);
      if (call?.method !== 'meta' || !imports.get(call.object)?.includes('.storybook/preview')) {
        continue;
      }
      metaNode = unwrapExpression(call.args[0]);
      if (metaNode?.type !== 'ObjectExpression') {
        fallback('meta-unsupported');
      }
      factoryMetaName = name;
      break;
    }
  }

  const meta = parseMeta(metaNode ?? fallback('missing-meta'), bindings, imports);
  const title = options.makeTitle(meta.title);
  const stories = new Map<string, StaticStory>();

  for (const statement of body) {
    const declaration: AstNode | null | undefined =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined;

    if (declaration?.type === 'FunctionDeclaration') {
      const exportName = identifierName(declaration.id) ?? fallback('story-export');
      stories.set(exportName, parseStory(exportName, declaration, bindings));
    } else if (declaration?.type === 'VariableDeclaration') {
      for (const { id, init } of declaration.declarations) {
        const exportName = identifierName(id) ?? fallback('story-export');
        if (exportName === '__namedExportsOrder') {
          fallback('named-exports-order');
        }
        if (!factoryMetaName) {
          stories.set(exportName, parseStory(exportName, init, bindings));
          continue;
        }

        const call = memberCall(init);
        if (call?.object !== factoryMetaName || !['story', 'extend'].includes(call.method)) {
          continue;
        }
        const story = parseStory(exportName, call.args[0], bindings);
        story.factory = true;
        story.storyFn = false;
        stories.set(exportName, story);
      }
    } else if (statement.type === 'ExpressionStatement') {
      const expression = unwrapExpression(statement.expression);
      if (expression?.type === 'CallExpression') {
        const callee = memberNames(expression.callee);
        if (callee?.property === 'test' && stories.has(callee.object)) {
          fallback('expression-statement');
        }
      } else if (expression?.type === 'AssignmentExpression') {
        const target = memberNames(expression.left);
        const story = target && stories.get(target.object);
        if (story) {
          applyLegacyAnnotation(story, target.property, expression.right, bindings);
        }
      }
    }
  }

  return [...stories.values()]
    .filter((story) => isExportStory(story.exportName, meta))
    .map(
      (story) =>
        ({
          rawComponentPath: meta.rawComponentPath,
          exportName: story.exportName,
          title,
          metaId: meta.id,
          tags: [...withPlayTag(meta), ...withPlayTag(story)],
          __id: story.customId ?? toId(meta.id || title, storyNameFromExport(story.exportName)),
          __stats: indexStats(story, meta, moduleMock),
          type: 'story',
          subtype: 'story',
          name: story.name,
        }) satisfies IndexInput
    );
};

/**
 * Index statically analyzable CSF with OXC.
 *
 * Returns null for shapes the fast path does not support, so callers can fall back to `loadCsf`.
 */
export function indexCsfWithOxc(
  code: string,
  fileName: string,
  options: IndexerOptions,
  diagnostics?: OxcCsfIndexerDiagnostics
): IndexInput[] | null {
  try {
    return indexStaticCsf(code, fileName, options);
  } catch (error) {
    if (!(error instanceof OxcFallback)) {
      throw error;
    }
    if (diagnostics) {
      diagnostics.fallbackReason = error.reason;
    }
    return null;
  }
}
