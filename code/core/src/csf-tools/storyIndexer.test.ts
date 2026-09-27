import { describe, expect, it } from 'vitest';

import { loadCsf } from './CsfFile.ts';
import { indexCsfWithOxc } from './oxcIndexer.ts';

const getIndex = (code: string) => {
  const inputs = loadCsf(code, { makeTitle: () => 'title', fileName: 'a.stories.ts' }).parse()
    .indexInputs;

  return {
    raw: inputs,
    entries: inputs.map((i) => i.name),
  };
};

describe('OXC indexer fast path', () => {
  const makeTitle = (title?: string) => title || 'title';
  const getOxcIndex = (code: string) =>
    indexCsfWithOxc(code, 'a.stories.tsx', { makeTitle });

  it('matches Babel indexing for common CSF 1-3 shapes', () => {
    const code = `
      import { Button } from './Button';
      export default {
        id: 'button',
        title: 'Components/Button',
        component: Button,
        tags: ['autodocs']
      };

      export const CSF1 = () => 'foo';
      export const CSF2 = (args) => 'foo';
      export const CSF3 = {
        tags: ['smoke']
      };
      export const CustomName = {
        name: 'Custom name',
        parameters: { __id: 'custom-id' }
      };
    `;

    const babel = loadCsf(code, { makeTitle, fileName: 'a.stories.tsx' }).parse().indexInputs;
    expect(getOxcIndex(code)).toEqual(babel);
  });

  it('matches Babel component path semantics for cast component expressions', () => {
    const code = `
      import type { Meta } from '@storybook/react';
      import { Button } from './Button';

      const meta = {
        title: 'Components/Button',
        component: Button as any,
      } satisfies Meta;

      export default meta;
      export const Primary = {};
    `;

    const babel = loadCsf(code, { makeTitle, fileName: 'a.stories.tsx' }).parse().indexInputs;
    expect(getOxcIndex(code)).toEqual(babel);
  });

  it('supports TypeScript satisfies wrappers', () => {
    const code = `
      import type { Meta, StoryObj } from '@storybook/react';

      const meta = {
        title: 'Components/Button',
        tags: ['autodocs'],
      } satisfies Meta;

      export default meta;

      export const Primary = {
        name: 'Primary button',
      } satisfies StoryObj;
    `;

    const babel = loadCsf(code, { makeTitle, fileName: 'a.stories.tsx' }).parse().indexInputs;
    expect(getOxcIndex(code)).toEqual(babel);
  });

  it('matches Babel indexing for CSF2 bind and assignment annotations', () => {
    const code = `
      export default { title: 'Button' };

      const Template = (args) => args;
      export const Primary = Template.bind({});
      Primary.storyName = 'Primary button';
      Primary.args = { label: 'Primary' };

      export const Secondary = Template.bind({});
      Secondary.parameters = { layout: 'centered' };
    `;

    const babel = loadCsf(code, { makeTitle, fileName: 'a.stories.tsx' }).parse().indexInputs;
    expect(getOxcIndex(code)).toEqual(babel);
  });

  it('matches Babel include and exclude story filtering', () => {
    const code = `
      export default {
        title: 'Button',
        includeStories: /^[A-Z]/,
        excludeStories: ['Helper'],
      };

      export const Primary = {};
      export const Helper = {};
      export const helper = {};
    `;

    const babel = loadCsf(code, { makeTitle, fileName: 'a.stories.tsx' }).parse().indexInputs;
    expect(getOxcIndex(code)).toEqual(babel);
  });

  it('falls back for CSF test syntax', () => {
    const code = `
      export default { title: 'Button' };
      export const Primary = {};
      Primary.test('renders', () => {});
    `;

    expect(getOxcIndex(code)).toBeNull();
  });
});

describe('test fn', () => {
  it('indexes CSF v1 to v3 stories', () => {
    const { entries } = getIndex(
      `
          export default { component: 'foo' };
          export const CSF1 = () => 'foo';
          export const CSF2 = (args) => 'foo';
          export const CSF3 = {};
          export const CustomName = {
            name: 'Custom name',
          };
        `
    );
    expect(entries).toMatchInlineSnapshot(`
      [
        "CSF 1",
        "CSF 2",
        "CSF 3",
        "Custom name",
      ]
    `);
  });

  it('indexes test functions', () => {
    const { entries } = getIndex(
      `
          import { config } from '#.storybook/preview'
          const meta = config.meta({ component: 'foo' });
          export const A = meta.story({})
          A.test('async test function', async () => {})
          A.test('sync test function', () => {})
          A.test('with overrides', { args: { label: 'bar' } }, () => {})
          const reference = () => {}
          A.test('with function reference', reference)
        `
    );
    expect(entries).toMatchInlineSnapshot(`
      [
        "A",
        "async test function",
        "sync test function",
        "with overrides",
        "with function reference",
      ]
    `);
  });
});
