import type { ThemeRegistration } from 'shiki/core';

/**
 * files.gg's own dark code theme, built on the design tokens (styles/theme.css):
 * the `--well` background, `--text` foreground, brand green strings, `--muted`
 * punctuation. Small on purpose: it ships in the text chunk instead of a bundled theme.
 * Every colour keeps at least 4.5:1 contrast on the well.
 */
export const THEME_NAME = 'filesgg-dark';

export const filesggDark: ThemeRegistration = {
  name: THEME_NAME,
  type: 'dark',
  fg: '#f2f3f5',
  bg: '#1a1b1e',
  colors: { 'editor.background': '#1a1b1e', 'editor.foreground': '#f2f3f5' },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment', 'string.comment'], settings: { foreground: '#8b919a', fontStyle: 'italic' } },
    {
      scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string', 'string.unquoted', 'markup.inline.raw'],
      settings: { foreground: '#7ee3a2' },
    },
    { scope: ['string.regexp', 'constant.character.escape'], settings: { foreground: '#5fd4c4' } },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.other', 'support.constant', 'variable.language', 'constant.character'],
      settings: { foreground: '#f6b26b' },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.control',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.logical.python',
        'keyword.other.unit',
      ],
      settings: { foreground: '#ff8fa3' },
    },
    { scope: ['keyword.operator', 'punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'], settings: { foreground: '#b5bac1' } },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call.generic', 'variable.function', 'entity.name.command'],
      settings: { foreground: '#8cc4ff' },
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.class', 'support.type', 'entity.other.inherited-class', 'entity.name.namespace', 'storage.type.class.jsdoc'],
      settings: { foreground: '#f0d080' },
    },
    { scope: ['entity.name.tag', 'meta.tag.sgml'], settings: { foreground: '#7ee3a2' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#c7a8ff' } },
    {
      scope: ['variable.other.property', 'support.type.property-name', 'meta.object-literal.key', 'entity.name.tag.yaml', 'support.variable.property', 'keyword.other.definition.ini'],
      settings: { foreground: '#a8d4ff' },
    },
    { scope: ['variable.parameter'], settings: { foreground: '#f2f3f5', fontStyle: 'italic' } },
    { scope: ['entity.name.section', 'markup.heading', 'markup.heading entity.name'], settings: { foreground: '#8cc4ff', fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.underline.link', 'string.other.link'], settings: { foreground: '#8cc4ff' } },
    { scope: ['markup.inserted', 'meta.diff.header.to-file', 'punctuation.definition.inserted'], settings: { foreground: '#3deb7e' } },
    { scope: ['markup.deleted', 'meta.diff.header.from-file', 'punctuation.definition.deleted'], settings: { foreground: '#ff8080' } },
    { scope: ['markup.changed', 'meta.diff.range'], settings: { foreground: '#f6b26b' } },
    { scope: ['invalid', 'invalid.illegal'], settings: { foreground: '#ff8080' } },
  ],
};
