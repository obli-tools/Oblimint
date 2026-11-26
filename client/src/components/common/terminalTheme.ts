import type { ITheme } from '@xterm/xterm';

// Dark terminal palette shared by the consoles and log viewers (Oblihub DNA):
// near-black background and light text whatever the panel theme, so a shell or
// a log never reads grey on grey.

export const TERMINAL_BG = '#0d1117';

export const TERMINAL_THEME: ITheme = {
  background: TERMINAL_BG,
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: TERMINAL_BG,
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#c9d1d9',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

export const TERMINAL_FONT = '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, Menlo, monospace';
